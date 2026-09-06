-- Ad Assist App — RPCs
-- Two jobs here: hand work to the scanner safely, and serve the public /p/ pages
-- without granting anon any table access.

-- ─── job claim ────────────────────────────────────────────────────────
-- FOR UPDATE SKIP LOCKED is the reason two scanners (two Macs, or two of my own
-- sessions) can never take the same job. The row is locked inside the transaction
-- that flips it to 'running', so a loser skips it rather than racing on it.
create or replace function public.claim_job(worker_id text)
returns setof public.scanner_jobs
language plpgsql security definer set search_path = public as $$
begin
  return query
  with next_job as (
    select j.id from public.scanner_jobs j
    where j.status = 'queued'
    order by j.created_at
    for update skip locked
    limit 1
  )
  update public.scanner_jobs j
     set status       = 'running',
         claimed_by   = worker_id,
         claimed_at   = now(),
         heartbeat_at = now(),
         attempts     = j.attempts + 1
    from next_job
   where j.id = next_job.id
  returning j.*;
end $$;

-- A worker that dies mid-job leaves the row 'running' forever. Reclaim on a dead
-- heartbeat rather than on claimed_at, so a genuinely long scan is never stolen
-- out from under a worker that is still alive and reporting.
create or replace function public.reap_stale_jobs(max_silence interval default '5 minutes')
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with stale as (
    update public.scanner_jobs
       set status = case when attempts >= 3 then 'failed' else 'queued' end,
           error_message = case when attempts >= 3
             then 'worker went silent 3 times' else null end,
           claimed_by = null, claimed_at = null, heartbeat_at = null
     where status = 'running'
       and coalesce(heartbeat_at, claimed_at) < now() - max_silence
    returning 1
  ) select count(*) into n from stale;
  return n;
end $$;

-- ─── public landing pages ─────────────────────────────────────────────
-- Returns the fully merged page: base template with the persona's 20% swapped in.
-- The merge lives here so the renderer cannot drift from it, and so anon never
-- needs read access to campaigns, personas or base_pages.
create or replace function public.get_public_page(
  campaign_slug text,
  persona_slug  text default null
)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when b.id is null then null else jsonb_build_object(
    'campaign_id',   c.id,
    'persona_id',    p.id,
    'page_title',    coalesce(p.custom_hero_headline, b.page_title),
    'meta_description', b.meta_description,
    'topbar',        coalesce(p.custom_topbar_notice, c.current_offer),
    'headline',      coalesce(p.custom_hero_headline, b.hero_headline),
    'subheadline',   b.hero_subheadline,
    -- 80/20: persona overrides reasons 1-3, the rest of the page is locked
    'reasons',       case when p.id is null then b.reasons
                     else p.custom_reasons ||
                          coalesce(jsonb_path_query_array(b.reasons, '$[3 to last]'), '[]'::jsonb)
                     end,
    'testimonials',  case when p.proof_quote is not null
                     then jsonb_build_array(p.proof_quote) || b.testimonials
                     else b.testimonials end,
    'offer_headline', b.offer_headline,
    'offer_body',     b.offer_body,
    'cta_button_text', b.cta_button_text,
    'cta_url',        b.cta_url
  ) end
  from public.campaigns c
  join public.base_pages b on b.campaign_id = c.id
  left join public.personas p
         on p.campaign_id = c.id and p.slug = persona_slug
  where c.slug = campaign_slug
    and (persona_slug is null or p.id is not null);
$$;

grant execute on function public.get_public_page(text, text) to anon, authenticated;

-- Counters. Separate from get_public_page so a bot prefetch of the HTML and a real
-- CTA click are never the same event.
create or replace function public.bump_persona_view(pid uuid)
returns void language sql security definer set search_path = public as $$
  update public.personas set views_count = views_count + 1 where id = pid;
$$;

create or replace function public.bump_persona_click(pid uuid)
returns void language sql security definer set search_path = public as $$
  update public.personas set clicks_count = clicks_count + 1 where id = pid;
$$;

grant execute on function public.bump_persona_view(uuid)  to anon, authenticated;
grant execute on function public.bump_persona_click(uuid) to anon, authenticated;

-- ─── spend ceiling ────────────────────────────────────────────────────
-- Checked inside one transaction with the ledger insert, so two Approve clicks
-- landing together cannot both pass a ceiling that only one of them fits under.
create or replace function public.record_spend(
  cid uuid, aid uuid, cr int, amount numeric, note text
) returns numeric
language plpgsql security definer set search_path = public as $$
declare spent numeric; ceiling numeric;
begin
  select coalesce(s.campaign_spend_ceiling, 150.00) into ceiling
    from public.campaigns c
    left join public.settings s on s.user_id = c.user_id
   where c.id = cid
   for update;

  select coalesce(sum(usd), 0) into spent
    from public.spend_log where campaign_id = cid;

  if spent + amount > ceiling then
    raise exception 'spend ceiling reached: $% spent, $% requested, $% ceiling',
      spent, amount, ceiling using errcode = 'check_violation';
  end if;

  insert into public.spend_log (campaign_id, asset_id, credits, usd, note)
  values (cid, aid, cr, amount, note);

  return spent + amount;
end $$;

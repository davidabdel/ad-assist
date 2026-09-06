-- Fix: two drivers could write the same persona_index and crash the campaign.
--
-- `advance()` does one unit per call and the browser is what keeps calling it,
-- so two tabs — or a phone and a laptop — are two drivers on one campaign. Both
-- read "15 personas exist", both computed index 16, the first insert won and the
-- second died on the unique constraint. Observed live on 2026-09-07:
--
--   duplicate key value violates unique constraint
--   "personas_campaign_id_persona_index_key"
--
-- The campaign was marked failed even though all twenty personas were present
-- and correct. It also burned a full model call on the batch that lost.
--
-- The guard is a claim taken BEFORE the model call, not a retry after the
-- clash, so the loser costs nothing. Same shape as claim_job: a conditional
-- UPDATE is atomic, and under READ COMMITTED the second transaction re-checks
-- its WHERE against the committed row and matches nothing.

alter table public.campaigns
  add column if not exists persona_lock_at timestamptz;

-- Written when the base page is sent back for a rewrite, so the second attempt
-- knows what was wrong with the first instead of rerolling blind.
alter table public.campaigns
  add column if not exists base_page_guidance text;

-- A driver that dies mid-batch leaves the lock set. Expire it rather than
-- require a human, but expire it on time rather than on the next call: a
-- five-persona batch runs about 70 seconds, so five minutes is slack, not a
-- race.
create or replace function public.claim_persona_batch(
  p_campaign  uuid,
  max_silence interval default '5 minutes'
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare claimed boolean;
begin
  update public.campaigns c
     set persona_lock_at = now()
   where c.id = p_campaign
     and (c.persona_lock_at is null or c.persona_lock_at < now() - max_silence)
  returning true into claimed;

  return coalesce(claimed, false);
end $$;

create or replace function public.release_persona_batch(p_campaign uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.campaigns set persona_lock_at = null where id = p_campaign;
end $$;

-- 0005 made functions private by default in this schema, so these are already
-- closed to anon. Stated explicitly anyway: both bypass RLS by design, and the
-- anon key ships in the browser bundle on every public /p/ page.
revoke all on function public.claim_persona_batch(uuid, interval)
  from public, anon, authenticated;
revoke all on function public.release_persona_batch(uuid)
  from public, anon, authenticated;

grant execute on function public.claim_persona_batch(uuid, interval) to service_role;
grant execute on function public.release_persona_batch(uuid)         to service_role;

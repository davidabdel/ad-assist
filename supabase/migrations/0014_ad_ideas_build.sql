-- What the idea stage needs on top of the original ad_ideas table.
--
-- 0001 was written before it was settled HOW an ad image would be made. It is
-- now settled, and it is the single most important fact about this stage: the
-- image model is an EDITOR (`google/nano-banana-edit`), so every static ad is
-- built out of one of the seller's own photographs rather than dreamt up from
-- a sentence. That is not a cost decision. A generated-from-nothing product
-- shot is a picture of a product that does not exist, and it goes in an ad,
-- next to a price, for a thing somebody will actually be sent in the post.
--
-- So an idea has to name WHICH photograph it starts from, and that column did
-- not exist.

alter table public.ad_ideas
  add column if not exists source_image_url text;

comment on column public.ad_ideas.source_image_url is
  'The seller''s own photograph this ad is built from — the image handed to the '
  'edit model, or the first frame handed to the video model. Null means the '
  'library had nothing usable, and the idea cannot be generated until one is '
  'chosen.';

-- Set when the operator changes any field on the row.
--
-- Worth a column rather than being inferred: what gets approved is what is in
-- the row at the moment Approve is clicked, and being able to see that a row
-- was rewritten before it was approved is the difference between reading the
-- model's work and reading David's.
alter table public.ad_ideas
  add column if not exists edited_at timestamptz;

-- Why a row was sent back. Kept rather than deleted: a rejected idea is
-- evidence about the format it came from, and a table that silently loses rows
-- reads as a bug.
alter table public.ad_ideas
  add column if not exists rejected_reason text;

-- The estimate is written to spend_log BEFORE the task is submitted, because
-- the ceiling has to be enforced before the money is spent, not after. KIE
-- reports what it actually charged when the task finishes, and the two are not
-- always equal — so the true figure is recorded on the asset and any
-- difference is written to the ledger as its own correcting row.
comment on column public.generated_assets.credits_charged is
  'What KIE actually billed, read from the finished task. The pre-submit '
  'estimate lives in spend_log; a difference between them is written to '
  'spend_log as a separate correction row rather than by editing the original.';

-- Finding an idea's assets by task id, which is how a poll gets from KIE's
-- answer back to our row. Already unique on kie_task_id from 0001; this is the
-- one for listing a campaign's assets on the dashboard without a join per row.
create index if not exists generated_assets_state_idx
  on public.generated_assets (state);

-- ─── reserve, then reconcile ──────────────────────────────────────────
--
-- `record_spend` enforces the ceiling and appends the ledger row in one
-- transaction, which is exactly right — but it returns a running total, and the
-- caller needs the ROW.
--
-- The reason is the order the money moves in. The ceiling has to be checked
-- BEFORE the task is submitted, because a submitted KIE task is already paid
-- for. So a row goes in first, as a reservation, at our estimated price. Three
-- things can happen next, and all three need the row back:
--
--   KIE refuses the task   nothing was spent    → delete the reservation
--   the task fails         nothing was spent    → delete the reservation
--   the task succeeds      KIE reports the real
--                          number, which is not
--                          always our estimate  → replace it with the truth
--
-- Same body as record_spend, plus the id. record_spend is left in place: it is
-- the right function for a spend that is already final.
create or replace function public.reserve_spend(
  cid uuid, cr int, amount numeric, note text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare spent numeric; ceiling numeric; new_id uuid;
begin
  -- `for update of c` and not a bare FOR UPDATE: a bare one tries to lock the
  -- nullable side of the outer join and throws 0A000 on every call. That fault
  -- shipped once already (see 0003) and it only appears at execution time.
  select coalesce(s.campaign_spend_ceiling, 150.00) into ceiling
    from public.campaigns c
    left join public.settings s on s.user_id = c.user_id
   where c.id = cid
   for update of c;

  if ceiling is null then
    raise exception 'no such campaign: %', cid using errcode = 'no_data_found';
  end if;

  select coalesce(sum(usd), 0) into spent
    from public.spend_log where campaign_id = cid;

  if spent + amount > ceiling then
    raise exception 'spend ceiling reached: $% spent, $% requested, $% ceiling',
      spent, amount, ceiling using errcode = 'check_violation';
  end if;

  insert into public.spend_log (campaign_id, asset_id, credits, usd, note)
  values (cid, null, cr, amount, note)
  returning id into new_id;

  return new_id;
end $$;

-- 0005 revoked execute from anon/authenticated by default in this schema, and
-- this function bypasses RLS by design. Stated rather than assumed: the anon
-- key ships in the browser on every public /p/ page, and a spend function
-- callable with it would let a stranger exhaust the ceiling.
revoke all on function public.reserve_spend(uuid, int, numeric, text)
  from public, anon, authenticated;
grant execute on function public.reserve_spend(uuid, int, numeric, text) to service_role;

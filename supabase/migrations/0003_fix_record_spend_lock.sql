-- Fix: record_spend threw on every call.
--
-- 0002 wrote `... from campaigns c left join settings s ... for update`. A bare
-- FOR UPDATE locks every table in the FROM, and Postgres refuses to lock the
-- nullable side of an outer join:
--   0A000: FOR UPDATE cannot be applied to the nullable side of an outer join
-- Caught by a live call against the database, not by reading it — the function
-- created without complaint, because the planner only sees this at execution.
--
-- The campaign row is the lock we actually want: it is what serialises two
-- Approve clicks on the same campaign. settings is read-only here, so name the
-- lock target explicitly with `for update of c`.

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
  values (cid, aid, cr, amount, note);

  return spent + amount;
end $$;

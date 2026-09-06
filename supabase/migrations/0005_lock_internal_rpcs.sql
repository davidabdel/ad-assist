-- Fix: the internal RPCs were callable by anon.
--
-- Postgres grants EXECUTE on new functions to PUBLIC, and Supabase's default
-- privileges additionally grant it to anon and authenticated. 0002 granted the
-- four public-page RPCs explicitly, which read as "these four are the public
-- ones" — but the grant was never the thing keeping the others private. All nine
-- functions were open.
--
-- This matters because the anon key is shipped in the browser bundle on every
-- public /p/ page. Verified against the live database with that key:
--   * record_spend  — wrote a row into spend_log and moved the campaign total.
--     Anyone could exhaust the spend ceiling and block generation.
--   * claim_job     — flipped a queued job to 'running' under an attacker's
--     worker id AND returned the whole row: campaign_id, target_url, search
--     terms. Both a denial of service on the scanner and an information leak.
--   * reap_stale_jobs — returned 0, but would requeue or fail live jobs.
--
-- security definer is what makes this sharp: these functions bypass RLS by
-- design, so the grant was the only gate on them.

revoke all on function public.claim_job(text)              from public, anon, authenticated;
revoke all on function public.reap_stale_jobs(interval)    from public, anon, authenticated;
revoke all on function public.record_spend(uuid, uuid, int, numeric, text)
                                                           from public, anon, authenticated;
revoke all on function public.touch_updated_at()           from public, anon, authenticated;

grant execute on function public.claim_job(text)           to service_role;
grant execute on function public.reap_stale_jobs(interval) to service_role;
grant execute on function public.record_spend(uuid, uuid, int, numeric, text)
                                                           to service_role;

-- owns_campaign deliberately stays executable by anon and authenticated: it is
-- called inside the RLS policies on every child table, and a policy expression
-- runs as the querying role. Revoking it turns "you see no rows" into
-- "permission denied for function". It returns a boolean about the caller's own
-- auth.uid() and leaks nothing.

-- bump_persona_view / bump_persona_click stay open to anon by design — the
-- public pages call them. They are spammable by anyone who has a persona id;
-- the counters are directional, not analytics of record.

-- Private by default from here on, so a future RPC is not public because
-- somebody forgot a revoke. Anything the browser needs must be granted by name.
alter default privileges in schema public
  revoke execute on functions from anon, authenticated;

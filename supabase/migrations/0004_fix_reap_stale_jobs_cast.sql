-- Fix: reap_stale_jobs threw on every call.
--
--   42804: column "status" is of type job_status but expression is of type text
--
-- A CASE whose branches are both bare quoted literals resolves to text, and an
-- assignment to an enum column will not take text implicitly. (The `where status
-- = 'running'` in the same statement is fine — comparison context coerces the
-- literal, assignment context does not.) Cast the branches explicitly.
--
-- Same failure mode as record_spend in 0003: PL/pgSQL bodies are not type-checked
-- at CREATE time, so both functions were created clean and would only have blown
-- up the first time a worker went silent in production.

create or replace function public.reap_stale_jobs(max_silence interval default '5 minutes')
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with stale as (
    update public.scanner_jobs
       set status = case when attempts >= 3
                         then 'failed'::job_status
                         else 'queued'::job_status end,
           error_message = case when attempts >= 3
             then 'worker went silent 3 times' else null end,
           claimed_by = null, claimed_at = null, heartbeat_at = null
     where status = 'running'
       and coalesce(heartbeat_at, claimed_at) < now() - max_silence
    returning 1
  ) select count(*) into n from stale;
  return n;
end $$;

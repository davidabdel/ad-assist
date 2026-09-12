-- Anonymous scans contain only public product data. Access is through a random
-- HttpOnly cookie, never an anonymous table policy. Quotas work across instances.
create table if not exists public.free_scans (
  id uuid primary key default gen_random_uuid(),
  source_url text not null,
  payload jsonb not null,
  expires_at timestamptz not null default now() + interval '24 hours'
);
alter table public.free_scans enable row level security;
revoke all on public.free_scans from anon, authenticated;
grant all on public.free_scans to service_role;
create index if not exists free_scans_expiry on public.free_scans(expires_at);

create table if not exists public.free_scan_limits (
  key text primary key,
  uses int not null,
  expires_at timestamptz not null
);
alter table public.free_scan_limits enable row level security;
revoke all on public.free_scan_limits from anon, authenticated;
grant all on public.free_scan_limits to service_role;

create or replace function public.reserve_free_scan(p_key text)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  -- Global lock serializes the global and per-visitor budget in one transaction.
  perform pg_advisory_xact_lock(802020);
  delete from free_scan_limits where expires_at < now();
  delete from free_scans where expires_at < now();
  if coalesce((select uses from free_scan_limits where key = 'global'), 0) >= 500
    or coalesce((select uses from free_scan_limits where key = p_key), 0) >= 3
  then return false; end if;
  insert into free_scan_limits(key, uses, expires_at) values ('global', 1, now() + interval '1 day')
    on conflict(key) do update set uses = free_scan_limits.uses + 1;
  insert into free_scan_limits(key, uses, expires_at) values (p_key, 1, now() + interval '1 day')
    on conflict(key) do update set uses = free_scan_limits.uses + 1;
  return true;
end;
$$;
revoke all on function public.reserve_free_scan(text) from public, anon, authenticated;
grant execute on function public.reserve_free_scan(text) to service_role;

alter table public.billing_accounts add column checkout_attempt uuid not null default gen_random_uuid();
alter table public.billing_accounts add column checkout_plan text;
alter table public.billing_accounts add column sync_lock_until timestamptz;
create function public.claim_billing_sync(p_user uuid) returns boolean language plpgsql security definer set search_path=public as $$
begin
 update billing_accounts set sync_lock_until=now()+interval '1 minute' where user_id=p_user and (sync_lock_until is null or sync_lock_until<now());
 return found;
end $$;
revoke all on function public.claim_billing_sync(uuid) from public,anon,authenticated;
grant execute on function public.claim_billing_sync(uuid) to service_role;
create table public.service_heartbeats(name text primary key,seen_at timestamptz not null);
alter table public.service_heartbeats enable row level security;
revoke all on public.service_heartbeats from anon,authenticated;
grant all on public.service_heartbeats to service_role;
create index model_usage_user on public.model_usage(user_id,created_at);
create index media_usage_user on public.media_usage(user_id,created_at);
create index billing_payments_user on public.billing_payments(user_id,paid_at);
create index usage_unresolved on public.usage_reservations(state,created_at);

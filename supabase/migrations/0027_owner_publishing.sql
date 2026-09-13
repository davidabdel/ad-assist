-- Explicit campaign-scoped publishing grants do not create paid subscriptions,
-- change revenue metrics, or grant generation credits.
create table public.campaign_publishing_grants (
 campaign_id uuid primary key references public.campaigns(id) on delete cascade,
 user_id uuid not null references public.users(id) on delete cascade,
 reason text not null,
 granted_at timestamptz not null default now()
);
alter table public.campaign_publishing_grants enable row level security;
revoke all on public.campaign_publishing_grants from public,anon,authenticated;
grant all on public.campaign_publishing_grants to service_role;
create or replace function public.get_public_page(campaign_slug text,persona_slug text default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
begin
 if not exists(
   select 1 from campaigns c
   where c.slug=campaign_slug and c.archived_at is null and (
     exists(select 1 from billing_accounts b where b.user_id=c.user_id
       and b.status in ('active','past_due') and b.period_end+interval '7 days'>now())
     or exists(select 1 from campaign_publishing_grants g
       where g.campaign_id=c.id and g.user_id=c.user_id)
   )
 ) then return null; end if;
 return get_public_page_internal(campaign_slug,persona_slug);
end $$;

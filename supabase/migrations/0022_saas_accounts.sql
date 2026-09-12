-- Subscription entitlements and durable operating data. All mutations are server-only.
create table public.billing_accounts (
 user_id uuid primary key references public.users(id) on delete cascade,
 customer_id text unique, subscription_id text unique,
 plan text check(plan in ('starter','growth','agency')),
 status text not null default 'free', mrr_usd numeric not null default 0,
 period_start timestamptz, period_end timestamptz,
 cancel_at_period_end boolean not null default false,
 builds_limit int not null default 0, images_limit int not null default 0,
 products_limit int not null default 0, video_balance int not null default 0,
 last_event_at bigint not null default 0,
 checkout_url text, checkout_expires_at timestamptz,
 checkout_lock_until timestamptz,
 created_at timestamptz not null default now()
);
create table public.billing_events (
 id text primary key, user_id uuid references public.users(id) on delete set null,
 kind text not null, provider_created bigint not null,
 processed_at timestamptz not null default now()
);
create table public.subscription_history (
 id bigint generated always as identity primary key,
 user_id uuid references public.users(id) on delete set null,
 event_id text unique not null, happened_at timestamptz not null,
 plan text, status text not null, mrr_usd numeric not null,
 previous_mrr_usd numeric not null, cancel_at_period_end boolean not null
);
create index on public.subscription_history(user_id,happened_at desc);
create table public.billing_payments (
 provider_id text primary key, user_id uuid references public.users(id) on delete set null,
 kind text not null, amount_usd numeric not null, refunded_usd numeric not null default 0,
 paid_at timestamptz not null, created_at timestamptz not null default now()
);
create table public.product_events (
 id uuid primary key default gen_random_uuid(),
 user_id uuid references public.users(id) on delete set null,
 campaign_id uuid references public.campaigns(id) on delete set null,
 scan_id uuid, kind text not null,
 created_at timestamptz not null default now()
);
create index on public.product_events(created_at,kind);
create index on public.product_events(user_id,created_at);
create table public.usage_reservations (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.users(id) on delete cascade,
 campaign_id uuid references public.campaigns(id) on delete set null,
 resource text not null check(resource in ('build','image','video','text')),
 units numeric not null default 1,
 period_start timestamptz not null,
 state text not null default 'reserved' check(state in ('reserved','consumed','released')),
 created_at timestamptz not null default now()
);
create index on public.usage_reservations(user_id,resource,period_start);
alter table public.users add column if not exists last_seen_at timestamptz;
alter table public.campaigns add column if not exists is_trial boolean not null default false;
alter table public.campaigns add column if not exists archived_at timestamptz;
alter table public.model_usage add column if not exists user_id uuid references public.users(id) on delete set null;
update public.model_usage m set user_id=c.user_id from public.campaigns c where c.id=m.campaign_id;
create function public.model_usage_owner() returns trigger language plpgsql set search_path=public as $$
begin select user_id into new.user_id from campaigns where id=new.campaign_id; return new; end $$;
create trigger model_usage_owner before insert or update of campaign_id on public.model_usage
 for each row execute function public.model_usage_owner();

create table public.media_usage (
 task_id text primary key, user_id uuid references public.users(id) on delete set null,
 campaign_id uuid references public.campaigns(id) on delete set null,
 media_type text not null, role text not null, model text not null, state text not null,
 estimated_usd numeric not null, confirmed_credits numeric,
 created_at timestamptz not null, completed_at timestamptz
);
create function public.capture_media_usage() returns trigger language plpgsql security definer set search_path=public as $$
declare cid uuid; uid uuid; mt text;
begin
 select i.campaign_id,c.user_id,case when new.role='ad' then i.media_type else 'image' end
 into cid,uid,mt from ad_ideas i join campaigns c on c.id=i.campaign_id where i.id=new.ad_idea_id;
 insert into media_usage(task_id,user_id,campaign_id,media_type,role,model,state,estimated_usd,confirmed_credits,created_at,completed_at)
 values(new.kie_task_id,uid,cid,mt,new.role,new.kie_model,new.state::text,
 case when mt='video' then 1.24 else 0.02 end,new.credits_charged,new.created_at,new.completed_at)
 on conflict(task_id) do update set state=excluded.state,confirmed_credits=excluded.confirmed_credits,completed_at=excluded.completed_at;
 return new;
end $$;
create trigger capture_media_usage after insert or update on public.generated_assets
 for each row execute function public.capture_media_usage();
insert into public.media_usage
 select a.kie_task_id,c.user_id,c.id,case when a.role='ad' then i.media_type else 'image' end,
 a.role,a.kie_model,a.state::text,case when a.role='ad' and i.media_type='video' then 1.24 else 0.02 end,
 case when a.state='fail' and a.credits_charged=0 then null else a.credits_charged end,a.created_at,a.completed_at
 from public.generated_assets a join public.ad_ideas i on i.id=a.ad_idea_id join public.campaigns c on c.id=i.campaign_id;

create table public.admin_login_limits(key text primary key, attempts int not null, expires_at timestamptz not null);
create function public.admin_login_attempt(p_key text) returns boolean language plpgsql security definer set search_path=public as $$
declare n int;
begin
 insert into admin_login_limits values(p_key,1,now()+interval '15 minutes')
 on conflict(key) do update set attempts=case when admin_login_limits.expires_at<now() then 1 else admin_login_limits.attempts+1 end,
 expires_at=case when admin_login_limits.expires_at<now() then now()+interval '15 minutes' else admin_login_limits.expires_at end
 returning attempts into n;
 return n<=5;
end $$;

-- Capture all signups, even those who never reach an authenticated API route.
create function public.sync_saas_user() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.email is not null then
 insert into users(id,email,created_at) values(new.id,new.email,new.created_at)
 on conflict(id) do update set email=excluded.email;
 insert into billing_accounts(user_id) values(new.id) on conflict do nothing;
 end if;
 return new;
end $$;
create trigger sync_saas_user after insert or update of email on auth.users for each row execute function public.sync_saas_user();
insert into public.users(id,email,created_at) select id,email,created_at from auth.users where email is not null on conflict(id) do nothing;
insert into public.billing_accounts(user_id) select id from public.users on conflict do nothing;

-- Every campaign insert, including a direct API request, consumes an allowance.
create function public.reserve_campaign_build() returns trigger language plpgsql security definer set search_path=public as $$
declare a billing_accounts; used int;
begin
 select * into a from billing_accounts where user_id=new.user_id for update;
 if not found then raise exception 'Billing account unavailable'; end if;
 if a.status not in ('active') or a.period_end<=now() or a.period_end is null then
   if exists(select 1 from usage_reservations where user_id=new.user_id and resource='build') then
     raise exception 'Choose a paid plan to build another campaign'; end if;
   new.is_trial:=true;
   insert into usage_reservations(user_id,campaign_id,resource,period_start,state)
   values(new.user_id,null,'build','1970-01-01','consumed');
 else
   select coalesce(sum(units),0) into used from usage_reservations where user_id=new.user_id
     and resource='build' and period_start=a.period_start and state<>'released';
   if used>=a.builds_limit then raise exception 'Monthly campaign allowance reached'; end if;
   if (select count(*) from campaigns where user_id=new.user_id and archived_at is null)>=a.products_limit then
     raise exception 'Active product limit reached. Archive a campaign or change plan'; end if;
   insert into usage_reservations(user_id,resource,period_start,state) values(new.user_id,'build',a.period_start,'consumed');
 end if;
 return new;
end $$;
create trigger reserve_campaign_build before insert on public.campaigns for each row execute function public.reserve_campaign_build();
-- Preserve prior free usage, preventing old accounts from getting an extra unbounded trial.
insert into public.usage_reservations(user_id,resource,period_start,state)
 select distinct user_id,'build','1970-01-01'::timestamptz,'consumed' from public.campaigns;

create function public.reserve_saas_resource(p_campaign uuid,p_resource text,p_units numeric)
returns uuid language plpgsql security definer set search_path=public as $$
declare a billing_accounts; c campaigns; used numeric; cap numeric; rid uuid; period timestamptz;
begin
 if p_units<=0 or p_resource not in ('image','video','text') then raise exception 'Invalid resource'; end if;
 select * into c from campaigns where id=p_campaign;
 if c.id is null or c.archived_at is not null then raise exception 'Campaign unavailable'; end if;
 select * into a from billing_accounts where user_id=c.user_id for update;
 if c.is_trial and c.status in ('pending','scraping','base_review') and p_resource='text' then
   cap:=3; period:='1970-01-01';
   select coalesce(sum(units),0) into used from usage_reservations where campaign_id=c.id and resource='text' and state<>'released';
 else
   if a.status<>'active' or a.period_end is null or a.period_end<=now() then raise exception 'An active subscription is required. Open Plans and billing'; end if;
   period:=a.period_start;
   cap:=case p_resource when 'image' then a.images_limit when 'text' then a.builds_limit*5 else a.video_balance end;
   if p_resource='video' then
     if a.video_balance<p_units then raise exception 'Not enough video credits. Open Plans and billing'; end if;
     update billing_accounts set video_balance=video_balance-p_units where user_id=c.user_id;
     used:=0;
   else
     select coalesce(sum(units),0) into used from usage_reservations where user_id=c.user_id and resource=p_resource and period_start=period and state<>'released';
   end if;
 end if;
 if used+p_units>cap then raise exception 'AI allowance reached. Open Plans and billing'; end if;
 insert into usage_reservations(user_id,campaign_id,resource,units,period_start) values(c.user_id,c.id,p_resource,p_units,period) returning id into rid;
 return rid;
end $$;
create function public.settle_saas_resource(p_id uuid,p_release boolean,p_actual numeric default null)
returns void language plpgsql security definer set search_path=public as $$
declare r usage_reservations;
begin
 select * into r from usage_reservations where id=p_id for update;
 if r.state<>'reserved' then return; end if;
 if p_release and r.resource='video' then update billing_accounts set video_balance=video_balance+r.units where user_id=r.user_id; end if;
 update usage_reservations set state=case when p_release then 'released' else 'consumed' end,
 units=case when not p_release and p_actual is not null and p_actual>=0 then p_actual else units end where id=p_id;
end $$;

-- Same-origin admin endpoints are the only consumer of these server-only data.
do $$ declare t text; begin
 foreach t in array array['billing_accounts','billing_events','subscription_history','billing_payments','product_events','usage_reservations','media_usage','admin_login_limits'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon, authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
revoke all on function public.admin_login_attempt(text),public.reserve_saas_resource(uuid,text,numeric),public.settle_saas_resource(uuid,boolean,numeric) from public,anon,authenticated;
grant execute on function public.admin_login_attempt(text),public.reserve_saas_resource(uuid,text,numeric),public.settle_saas_resource(uuid,boolean,numeric) to service_role;

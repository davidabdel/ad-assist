alter table public.billing_payments add column payment_intent text;
create table public.billing_refunds (
 id text primary key,user_id uuid references public.users(id) on delete set null,
 payment_id text references public.billing_payments(provider_id) on delete set null,
 amount_usd numeric not null,status text not null,happened_at timestamptz not null
);
alter table public.billing_refunds enable row level security;
revoke all on public.billing_refunds from anon,authenticated;
grant all on public.billing_refunds to service_role;
create function public.apply_refund(p_id text,p_user uuid,p_payment text,p_amount numeric,p_status text,p_time timestamptz)
returns void language plpgsql security definer set search_path=public as $$
declare before_amount numeric; after_amount numeric; purchase billing_payments;
begin
 perform 1 from billing_accounts where user_id=p_user for update;
 select * into purchase from billing_payments where provider_id=p_payment and user_id=p_user for update;
 select coalesce(sum(amount_usd),0) into before_amount from billing_refunds where payment_id=p_payment and status='succeeded';
 insert into billing_refunds values(p_id,p_user,p_payment,p_amount,p_status,p_time)
 on conflict(id) do update set amount_usd=excluded.amount_usd,status=excluded.status;
 select coalesce(sum(amount_usd),0) into after_amount from billing_refunds where payment_id=p_payment and status='succeeded';
 if purchase.provider_id is not null then
   update billing_payments set refunded_usd=after_amount where provider_id=p_payment;
   if purchase.kind='video_pack' then
     -- Negative balances retain debt for credits already spent before a refund.
     update billing_accounts set video_balance=video_balance-(ceil(after_amount/59*10)-ceil(before_amount/59*10))::int where user_id=p_user;
   end if;
 end if;
end $$;
revoke all on function public.apply_refund(text,uuid,text,numeric,text,timestamptz) from public,anon,authenticated;
grant execute on function public.apply_refund(text,uuid,text,numeric,text,timestamptz) to service_role;

create or replace function public.settle_saas_resource(p_id uuid,p_release boolean,p_actual numeric default null)
returns void language plpgsql security definer set search_path=public as $$
declare r usage_reservations;
begin
 select * into r from usage_reservations where id=p_id for update;
 if not found or r.state='released' or (r.state='consumed' and not p_release) then return; end if;
 if p_release and r.resource='video' then update billing_accounts set video_balance=video_balance+r.units where user_id=r.user_id; end if;
 update usage_reservations set state=case when p_release then 'released' else 'consumed' end,
 units=case when not p_release and p_actual is not null and p_actual>=0 then p_actual else units end where id=p_id;
end $$;
create function public.refund_failed_media() returns trigger language plpgsql security definer set search_path=public as $$
declare rid uuid;
begin
 if new.state='fail' and new.credits_charged=0 then
 select id into rid from usage_reservations where task_id=new.kie_task_id;
 if rid is not null then perform settle_saas_resource(rid,true); end if;
 end if; return new;
end $$;
create trigger refund_failed_media after update on public.generated_assets for each row execute function public.refund_failed_media();
create function public.capture_product_scan() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.scraped_data->'raw' is not null and new.scraped_data->'raw' is distinct from old.scraped_data->'raw' then
 insert into product_events(user_id,campaign_id,kind) values(new.user_id,new.id,'scan_completed');
 end if; return new;
end $$;
create trigger capture_product_scan after update of scraped_data on public.campaigns for each row execute function public.capture_product_scan();

-- Prevent raw public RPC access from bypassing trial/subscription publishing.
alter function public.get_public_page(text,text) rename to get_public_page_internal;
revoke all on function public.get_public_page_internal(text,text) from public,anon,authenticated;
grant execute on function public.get_public_page_internal(text,text) to service_role;
create function public.get_public_page(campaign_slug text,persona_slug text default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
begin
 if not exists(select 1 from campaigns c join billing_accounts b on b.user_id=c.user_id
 where c.slug=campaign_slug and c.archived_at is null and b.status in ('active','past_due')
 and b.period_end+interval '7 days'>now()) then return null; end if;
 return get_public_page_internal(campaign_slug,persona_slug);
end $$;
revoke all on function public.get_public_page(text,text) from public;
grant execute on function public.get_public_page(text,text) to anon,authenticated,service_role;

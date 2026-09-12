alter table public.usage_reservations add column task_id text unique;
create function public.apply_subscription(p_event text,p_created bigint,p_user uuid,p_data jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare a billing_accounts;
begin
 select * into a from billing_accounts where user_id=p_user for update;
 if a.user_id is null then raise exception 'Unknown billing account'; end if;
 if exists(select 1 from billing_events where id=p_event) then return false; end if;
 insert into billing_events(id,user_id,kind,provider_created) values(p_event,p_user,'subscription',p_created);
 if p_created<a.last_event_at then return false; end if;
 -- A second subscription must not silently replace the first paid subscription.
 if a.subscription_id is not null and a.subscription_id<>p_data->>'subscription_id' and a.status in ('active','past_due','trialing') then
   raise exception 'Account already has a subscription; reconcile duplicate'; end if;
 update billing_accounts set customer_id=p_data->>'customer_id',subscription_id=p_data->>'subscription_id',
 plan=p_data->>'plan',status=p_data->>'status',mrr_usd=(p_data->>'mrr_usd')::numeric,
 period_start=(p_data->>'period_start')::timestamptz,period_end=(p_data->>'period_end')::timestamptz,
 cancel_at_period_end=(p_data->>'cancel_at_period_end')::boolean,
 builds_limit=(p_data->>'builds_limit')::int,images_limit=(p_data->>'images_limit')::int,products_limit=(p_data->>'products_limit')::int,
 last_event_at=p_created,checkout_url=null,checkout_expires_at=null,checkout_lock_until=null where user_id=p_user;
 insert into subscription_history(user_id,event_id,happened_at,plan,status,mrr_usd,previous_mrr_usd,cancel_at_period_end)
 values(p_user,p_event,to_timestamp(p_created),p_data->>'plan',p_data->>'status',(p_data->>'mrr_usd')::numeric,a.mrr_usd,(p_data->>'cancel_at_period_end')::boolean);
 return true;
end $$;
create function public.apply_video_purchase(p_event text,p_created bigint,p_session text,p_user uuid,p_amount numeric)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 perform 1 from billing_accounts where user_id=p_user for update;
 if exists(select 1 from billing_payments where provider_id=p_session) then return false; end if;
 insert into billing_events(id,user_id,kind,provider_created) values(p_event,p_user,'video_pack',p_created) on conflict do nothing;
 insert into billing_payments(provider_id,user_id,kind,amount_usd,paid_at) values(p_session,p_user,'video_pack',p_amount,to_timestamp(p_created));
 update billing_accounts set video_balance=video_balance+10 where user_id=p_user;
 return true;
end $$;
create function public.claim_checkout(p_user uuid) returns boolean language plpgsql security definer set search_path=public as $$
declare a billing_accounts;
begin
 select * into a from billing_accounts where user_id=p_user for update;
 if a.checkout_lock_until>now() then return false; end if;
 update billing_accounts set checkout_lock_until=now()+interval '1 minute' where user_id=p_user;
 return true;
end $$;
revoke all on function public.apply_subscription(text,bigint,uuid,jsonb),public.apply_video_purchase(text,bigint,text,uuid,numeric),public.claim_checkout(uuid) from public,anon,authenticated;
grant execute on function public.apply_subscription(text,bigint,uuid,jsonb),public.apply_video_purchase(text,bigint,text,uuid,numeric),public.claim_checkout(uuid) to service_role;

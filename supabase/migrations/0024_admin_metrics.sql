create table public.analytics_config(id boolean primary key default true, started_at timestamptz not null default now());
insert into public.analytics_config(id) values(true);
alter table public.analytics_config enable row level security;
revoke all on public.analytics_config from anon,authenticated;
grant all on public.analytics_config to service_role;

-- Pre-aggregate each ledger separately: joining raw ledgers multiplies spend.
create view public.admin_account_rollup with (security_invoker=true) as
select u.id,u.email,u.created_at,u.last_seen_at,b.plan,b.status,b.mrr_usd,b.cancel_at_period_end,b.period_start,b.period_end,
 b.video_balance,b.builds_limit,b.images_limit,b.products_limit,
 coalesce(c.campaigns,0) campaigns,coalesce(c.active_products,0) active_products,coalesce(c.failed,0) failed_campaigns,
 coalesce(e.scans,0) scans,
 coalesce(m.input_tokens,0) input_tokens,coalesce(m.output_tokens,0) output_tokens,coalesce(m.cached_tokens,0) cached_tokens,
 coalesce(m.estimated_usd,0) text_estimated_usd,coalesce(m.unknown_rates,0) unknown_text_rates,
 coalesce(g.images,0) images,coalesce(g.videos,0) videos,coalesce(g.succeeded,0) media_succeeded,coalesce(g.failed,0) media_failed,
 coalesce(g.confirmed_credits,0) media_confirmed_credits,coalesce(g.confirmed_credits,0)*0.005 media_confirmed_usd,
 coalesce(g.unknown_cost,0) media_unknown_cost,coalesce(g.pending_estimate,0) media_unconfirmed_estimate,
 coalesce(p.gross,0) paid_usd,coalesce(p.refunds,0) refunded_usd,
 coalesce(r.builds_used,0) builds_used,coalesce(r.images_used,0) images_used,coalesce(r.text_used,0) text_budget_used,coalesce(z.unresolved,0) unresolved_reservations
from public.users u left join public.billing_accounts b on b.user_id=u.id
left join lateral (select count(*) campaigns,count(*) filter(where archived_at is null) active_products,
 count(*) filter(where status='failed') failed from public.campaigns where user_id=u.id) c on true
left join lateral (select count(*) scans from public.product_events where user_id=u.id and kind='scan_completed') e on true
left join lateral (select sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(cached_tokens) cached_tokens,
 sum(estimated_usd) estimated_usd,count(*) filter(where estimated_usd is null) unknown_rates from public.model_usage where user_id=u.id) m on true
left join lateral (select count(*) filter(where media_type='image') images,count(*) filter(where media_type='video') videos,
 count(*) filter(where state='success') succeeded,count(*) filter(where state='fail') failed,
 sum(confirmed_credits) confirmed_credits,count(*) filter(where confirmed_credits is null) unknown_cost,
 sum(estimated_usd) filter(where confirmed_credits is null) pending_estimate from public.media_usage where user_id=u.id) g on true
left join lateral (select sum(amount_usd) gross,sum(refunded_usd) refunds from public.billing_payments where user_id=u.id) p on true
left join lateral (select sum(units) filter(where resource='build') builds_used,sum(units) filter(where resource='image') images_used,
 sum(units) filter(where resource='text') text_used from public.usage_reservations where user_id=u.id and period_start=b.period_start and state<>'released') r on true
left join lateral (select count(*) unresolved from public.usage_reservations where user_id=u.id and state='reserved' and created_at<now()-interval '10 minutes') z on true;
revoke all on public.admin_account_rollup from anon,authenticated;
grant select on public.admin_account_rollup to service_role;

create function public.admin_metrics(p_days int default 30,p_search text default '',p_page int default 0,p_user uuid default null,p_sort text default 'newest')
returns jsonb language plpgsql security definer set search_path=public as $$
declare since timestamptz; result jsonb; started timestamptz; cohort int; lost int; start_mrr numeric; lost_mrr numeric;
begin
 if p_days not in (7,30,90,365) or p_page<0 or p_page>100000 or p_sort not in ('newest','cost','mrr') then raise exception 'Invalid range'; end if;
 since:=now()-make_interval(days=>p_days);
 select started_at into started from analytics_config limit 1;
 with initial as (select distinct on(user_id) user_id,mrr_usd from subscription_history where happened_at<=since order by user_id,happened_at desc,id desc)
 select count(*),count(*) filter(where coalesce(b.mrr_usd,0)=0),coalesce(sum(i.mrr_usd),0),coalesce(sum(i.mrr_usd) filter(where coalesce(b.mrr_usd,0)=0),0)
 into cohort,lost,start_mrr,lost_mrr from initial i left join billing_accounts b using(user_id) where i.mrr_usd>0;
 select jsonb_build_object(
 'as_of',now(),'since',since,'tracking_started_at',started,'history_complete',since>=started,
 'overview',(select jsonb_build_object('users',count(*),'new_users',count(*) filter(where created_at>=since),
 'active_24h',count(*) filter(where last_seen_at>=now()-interval '1 day'),
 'active_7d',count(*) filter(where last_seen_at>=now()-interval '7 days'),
 'active_30d',count(*) filter(where last_seen_at>=now()-interval '30 days'),
 'activated',count(*) filter(where campaigns>0),'paying',count(*) filter(where mrr_usd>0),
 'mrr',coalesce(sum(mrr_usd),0),'cancel_scheduled',count(*) filter(where cancel_at_period_end and mrr_usd>0),
 'past_due',count(*) filter(where status='past_due'),
 'text_estimated_usd',coalesce(sum(text_estimated_usd),0),'media_confirmed_usd',coalesce(sum(media_confirmed_usd),0),
 'unknown_text_rates',coalesce(sum(unknown_text_rates),0),'media_unknown_cost',coalesce(sum(media_unknown_cost),0),
 'unresolved_reservations',coalesce(sum(unresolved_reservations),0),'images',coalesce(sum(images),0),'videos',coalesce(sum(videos),0),'media_failed',coalesce(sum(media_failed),0)) from admin_account_rollup),
 'period',(select jsonb_build_object(
 'scans_started',(select count(*) from product_events where created_at>=since and kind in ('scan_started','scan_completed','scan_failed')),
 'scans_completed',(select count(*) from product_events where created_at>=since and kind='scan_completed'),
 'scans_failed',(select count(*) from product_events where created_at>=since and kind='scan_failed'),
 'anonymous_scans',(select count(*) from product_events where created_at>=since and kind='scan_completed' and user_id is null),
 'campaigns',(select count(*) from campaigns where created_at>=since),
 'new_paying',(select count(*) from (select user_id,min(happened_at) first_paid from subscription_history where mrr_usd>0 group by user_id) q where first_paid>=since),
 'cash_collected',(select coalesce(sum(amount_usd),0) from billing_payments where paid_at>=since),
 'refunds_on_period_payments',(select coalesce(sum(refunded_usd),0) from billing_payments where paid_at>=since),
 'text_estimated_usd',(select coalesce(sum(estimated_usd),0) from model_usage where created_at>=since),
 'media_confirmed_usd',(select coalesce(sum(confirmed_credits),0)*0.005 from media_usage where created_at>=since),
 'media_unconfirmed_estimate',(select coalesce(sum(estimated_usd),0) from media_usage where created_at>=since and confirmed_credits is null),
 'images',(select count(*) from media_usage where created_at>=since and media_type='image'),
 'videos',(select count(*) from media_usage where created_at>=since and media_type='video'),
 'media_failed',(select count(*) from media_usage where created_at>=since and state='fail'))),
 'churn',jsonb_build_object('opening_customers',cohort,'lost_customers',lost,'opening_mrr',start_mrr,'lost_mrr',lost_mrr,
 'customer_rate',case when since>=started and cohort>0 then lost::numeric/cohort else null end,
 'revenue_rate',case when since>=started and start_mrr>0 then lost_mrr/start_mrr else null end),
 'plans',(select coalesce(jsonb_agg(q),'[]') from (select coalesce(plan,'free') plan,count(*) accounts,coalesce(sum(mrr_usd),0) mrr from billing_accounts group by plan) q),
 'daily',(select coalesce(jsonb_agg(q order by q.day),'[]') from (select d::date as day,
 (select count(*) from users where created_at>=d and created_at<d+interval '1 day') signups,
 (select count(*) from product_events where kind='scan_completed' and created_at>=d and created_at<d+interval '1 day') scans,
 (select coalesce(sum(estimated_usd),0) from model_usage where created_at>=d and created_at<d+interval '1 day') text_cost,
 (select coalesce(sum(confirmed_credits),0)*0.005 from media_usage where created_at>=d and created_at<d+interval '1 day') media_cost
 from generate_series(date_trunc('day',since),date_trunc('day',now()),interval '1 day') d) q),
 'accounts_total',(select count(*) from users where email ilike '%'||left(p_search,200)||'%'),
 'accounts',(select coalesce(jsonb_agg(q),'[]') from (select * from admin_account_rollup where email ilike '%'||left(p_search,200)||'%' order by case when p_sort='cost' then text_estimated_usd+media_confirmed_usd end desc nulls last,case when p_sort='mrr' then mrr_usd end desc nulls last,created_at desc,id limit 25 offset p_page*25) q),
 'selected',case when p_user is null then null else (select to_jsonb(a) from admin_account_rollup a where id=p_user) end,
 'campaigns',case when p_user is null then '[]'::jsonb else (select coalesce(jsonb_agg(q),'[]') from (select id,title,status,created_at,is_trial,archived_at from campaigns where user_id=p_user order by created_at desc limit 100) q) end,
 'usage',case when p_user is null then '[]'::jsonb else (select coalesce(jsonb_agg(q),'[]') from (select stage,model,count(*) calls,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(estimated_usd) estimated_usd,count(*) filter(where estimated_usd is null) unknown_rates from model_usage where user_id=p_user group by stage,model) q) end,
 'operations',jsonb_build_object('last_tick',(select seen_at from service_heartbeats where name='tick'),'queued_jobs',(select count(*) from scanner_jobs where status='queued'),'stale_jobs',(select count(*) from scanner_jobs where status='running' and coalesce(heartbeat_at,claimed_at)<now()-interval '5 minutes')),'unattributed',(select jsonb_build_object('text_calls',(select count(*) from model_usage where user_id is null),'media_tasks',(select count(*) from media_usage where user_id is null)))
 ) into result;
 return result;
end $$;
revoke all on function public.admin_metrics(int,text,int,uuid,text) from public,anon,authenticated;
grant execute on function public.admin_metrics(int,text,int,uuid,text) to service_role;

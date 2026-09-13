-- Owner approved preserving these two existing public campaigns on 13 Sep 2026.
-- Apply after migration 0027, only to the intended production database.
begin;
do $$
declare matched integer;
begin
 select count(*) into matched from public.campaigns c
 join auth.users u on u.id=c.user_id
 where u.email='david@uconnect.com.au' and c.slug in ('buzz-cleaning','pointtaken');
 if matched<>2 then raise exception 'Expected the two approved owner campaigns; no grants applied'; end if;
 insert into public.campaign_publishing_grants(campaign_id,user_id,reason)
 select c.id,c.user_id,'Owner approved continued publishing without subscription, 2026-09-13'
 from public.campaigns c join auth.users u on u.id=c.user_id
 where u.email='david@uconnect.com.au' and c.slug in ('buzz-cleaning','pointtaken')
 on conflict(campaign_id) do nothing;
end $$;
commit;

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const db=new PGlite({extensions:{pgcrypto}});
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create table auth.users(id uuid primary key,email text,created_at timestamptz default now());
create function auth.uid() returns uuid language sql as 'select null::uuid';
create schema storage; create table storage.buckets(id text primary key,name text,public boolean);`);
for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()){
 try{await db.exec(await readFile(`supabase/migrations/${file}`,'utf8'));}catch(e){console.error('MIGRATION FAILED',file,e.message);process.exit(1);}
}
console.log('All migrations applied to isolated PostgreSQL');
const uid='00000000-0000-4000-8000-000000000001';
await db.query(`insert into auth.users(id,email) values($1,'owner@example.test')`,[uid]);
const first=(await db.query(`insert into campaigns(user_id,title,slug,source_url) values($1,'Trial','trial','https://example.com/product') returning *`,[uid])).rows[0];
assert.equal(first.is_trial,true);
await assert.rejects(db.query(`insert into campaigns(user_id,title,slug,source_url) values($1,'Another','another','https://example.com/product')`,[uid]),/Choose a paid plan/);
const snap={customer_id:'cus_1',subscription_id:'sub_1',plan:'starter',status:'active',mrr_usd:149,period_start:new Date(Date.now()-1000).toISOString(),period_end:new Date(Date.now()+86400000).toISOString(),cancel_at_period_end:false,builds_limit:2,images_limit:2,products_limit:5};
await db.query('select apply_subscription($1,$2,$3,$4)',['evt_1',100,uid,JSON.stringify(snap)]);
assert.equal((await db.query('select apply_subscription($1,$2,$3,$4)',['evt_1',100,uid,JSON.stringify(snap)])).rows[0].apply_subscription,false);
await db.query('select apply_subscription($1,$2,$3,$4)',['evt_old',99,uid,JSON.stringify({...snap,status:'canceled',mrr_usd:0})]);
assert.equal((await db.query('select status from billing_accounts where user_id=$1',[uid])).rows[0].status,'active');
const paid=(await db.query(`insert into campaigns(user_id,title,slug,source_url) values($1,'Paid','paid','https://example.com/product') returning id`,[uid])).rows[0].id;
await db.query(`insert into campaigns(user_id,title,slug,source_url) values($1,'Paid 2','paid-2','https://example.com/product')`,[uid]);
await assert.rejects(db.query(`insert into campaigns(user_id,title,slug,source_url) values($1,'Paid 3','paid-3','https://example.com/product')`,[uid]),/allowance reached/);
const resource=(await db.query(`select reserve_saas_resource($1,'image',1)`,[paid])).rows[0].reserve_saas_resource;
await db.query(`select reserve_saas_resource($1,'image',1)`,[paid]);
await assert.rejects(db.query(`select reserve_saas_resource($1,'image',1)`,[paid]),/allowance reached/);
await db.query('select settle_saas_resource($1,true)',[resource]);
await db.query(`select reserve_saas_resource($1,'image',1)`,[paid]);
await db.query('select apply_video_purchase($1,$2,$3,$4,$5)',['evt_video',101,'cs_video',uid,59]);
await db.query('select apply_video_purchase($1,$2,$3,$4,$5)',['evt_video_duplicate',102,'cs_video',uid,59]);
assert.equal((await db.query('select video_balance from billing_accounts where user_id=$1',[uid])).rows[0].video_balance,10);
const metrics=(await db.query('select admin_metrics()')).rows[0].admin_metrics;
assert.equal(metrics.overview.users,1);assert.equal(metrics.overview.mrr,149);assert.equal(metrics.accounts[0].campaigns,3);assert.equal(metrics.churn.customer_rate,null);

// Independent ledger aggregation must not multiply costs across multiple rows.
await db.query(`insert into model_usage(response_id,campaign_id,stage,model,input_tokens,cached_tokens,output_tokens,estimated_usd,response_status)
 values('r1',$1,'brief','gpt-5.5',100,10,20,1,'completed'),('r2',$1,'base','gpt-5.5',100,0,50,2,'completed')`,[paid]);
await db.query(`insert into media_usage(task_id,user_id,campaign_id,media_type,role,model,state,estimated_usd,confirmed_credits,created_at)
 values('m1',$1,$2,'image','preview','image','success',0.02,4,now()),('m2',$1,$2,'video','ad','video','success',1.24,248,now()),('m3',$1,$2,'image','ad','image','fail',0.02,null,now())`,[uid,paid]);
const account=(await db.query('select * from admin_account_rollup where id=$1',[uid])).rows[0];
assert.equal(Number(account.text_estimated_usd),3);assert.equal(Number(account.media_confirmed_usd),1.26);assert.equal(Number(account.media_unknown_cost),1);
// A refunded credit pack cannot keep granting credits; replay is harmless.
await db.query("select apply_refund('re_1',$1,'cs_video',59,'succeeded',now())",[uid]);
await db.query("select apply_refund('re_1',$1,'cs_video',59,'succeeded',now())",[uid]);
assert.equal((await db.query('select video_balance from billing_accounts where user_id=$1',[uid])).rows[0].video_balance,0);
// Metrics pagination must not silently truncate an account's list.
for(let n=2;n<=28;n++)await db.query('insert into auth.users(id,email) values($1,$2)',[`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,`person${n}@example.test`]);
const pageTwo=(await db.query("select admin_metrics(30,'',1,null,'cost')")).rows[0].admin_metrics;
assert.equal(pageTwo.accounts_total,28);assert.equal(pageTwo.accounts.length,3);
// Publishing cannot be reached through the anonymous RPC for a free account.
assert.equal((await db.query("select get_public_page('trial',null)")).rows[0].get_public_page,null);
// Concurrent budget consumers serialize against one account balance.
const races=await Promise.allSettled([db.query("select reserve_saas_resource($1,'text',6)",[paid]),db.query("select reserve_saas_resource($1,'text',6)",[paid])]);
assert.equal(races.filter(r=>r.status==='fulfilled').length,1);
assert.equal(races.filter(r=>r.status==='rejected').length,1);
// Churn is computed from the opening cohort, not all signups in the period.
await db.exec("update analytics_config set started_at=now()-interval '100 days'");
await db.query(`insert into subscription_history(user_id,event_id,happened_at,plan,status,mrr_usd,previous_mrr_usd,cancel_at_period_end)
 values($1,'old-open',now()-interval '40 days','starter','active',149,0,false)`,[uid]);
await db.query('select apply_subscription($1,$2,$3,$4)',['evt_cancel',200,uid,JSON.stringify({...snap,status:'canceled',mrr_usd:0})]);
const churn=(await db.query('select admin_metrics()')).rows[0].admin_metrics.churn;
assert.equal(churn.opening_customers,1);assert.equal(churn.lost_customers,1);assert.equal(churn.customer_rate,1);
// Owner publishing grants are campaign-scoped and never grant paid resources.
await db.query(`insert into base_pages(campaign_id,page_title,hero_headline,reasons,offer_headline,cta_button_text,cta_url)
 values($1,'Owner page','Owner headline','[]','Offer','Visit','https://example.com')`,[paid]);
assert.equal((await db.query("select get_public_page('paid',null)")).rows[0].get_public_page,null);
await db.query("insert into campaign_publishing_grants(campaign_id,user_id,reason) values($1,$2,'Approved owner campaign')",[paid,uid]);
assert.equal((await db.query("select get_public_page('paid',null)")).rows[0].get_public_page.page_title,'Owner page');
assert.equal((await db.query("select get_public_page('trial',null)")).rows[0].get_public_page,null);
assert.equal(Number((await db.query('select mrr_usd from billing_accounts where user_id=$1',[uid])).rows[0].mrr_usd),0);
await assert.rejects(db.query("select reserve_saas_resource($1,'image',1)",[paid]),/active subscription/);
await db.query('update campaigns set archived_at=now() where id=$1',[paid]);
assert.equal((await db.query("select get_public_page('paid',null)")).rows[0].get_public_page,null);
await db.query('update campaigns set archived_at=null where id=$1',[paid]);
await db.query('delete from campaign_publishing_grants where campaign_id=$1',[paid]);
assert.equal((await db.query("select get_public_page('paid',null)")).rows[0].get_public_page,null);
// Only one active background attempt may exist for the same owner/action.
const attempts=await Promise.allSettled([1,2].map(()=>db.query("insert into background_jobs(user_id,fingerprint,path) values($1,'same-action','/api/campaigns/example/advance') returning id",[uid])));
assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
assert.equal(attempts.filter(x=>x.status==='rejected').length,1);
const job=attempts.find(x=>x.status==='fulfilled').value.rows[0].id;
const claims=await Promise.all([1,2].map(()=>db.query("update background_jobs set state='running' where id=$1 and state='queued' returning id",[job])));
assert.equal(claims.reduce((n,x)=>n+x.rows.length,0),1);
await db.query("update background_jobs set state='completed',http_status=200,result='{}' where id=$1",[job]);
await db.query("insert into background_jobs(user_id,fingerprint,path) values($1,'same-action','/api/campaigns/example/advance')",[uid]);
console.log('PASS background operation deduplication, atomic claim, and explicit subsequent operation');
await db.exec('set role anon');
await assert.rejects(db.query('select * from billing_accounts'),/permission denied/);
await assert.rejects(db.query('select * from background_jobs'),/permission denied/);
await assert.rejects(db.query('select * from campaign_publishing_grants'),/permission denied/);
await assert.rejects(db.query('select admin_metrics()'),/permission denied/);
await db.exec('reset role');
console.log('PASS: signup sync, single trial, build/image limits, refunds, payment idempotency, stale events, ledger aggregation, refund replay, pagination, concurrent budgets, churn cohorts, admin isolation');
await db.close();

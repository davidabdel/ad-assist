// Real local Supabase integration: Auth, PostgREST permissions and app routes.
// Refuses remote targets. Never creates customers or purchases on hosted services.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
const local = JSON.parse(execFileSync('npm', ['exec','--yes','--package=supabase','--','supabase','status','-o','json'], { encoding:'utf8', stdio:['ignore','pipe','ignore'] }));
const url = new URL(local.API_URL);
assert.ok(['127.0.0.1','localhost'].includes(url.hostname), 'Local Supabase required');
const svc = createClient(local.API_URL,local.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const anon = () => createClient(local.API_URL,local.ANON_KEY,{auth:{persistSession:false}});
const password=randomBytes(24).toString('hex'), salt=randomBytes(16).toString('hex');
const origin='http://127.0.0.1:3106';
const env={...process.env,NEXT_PUBLIC_SITE_URL:origin,NEXT_PUBLIC_SUPABASE_URL:local.API_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY:local.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:local.SERVICE_ROLE_KEY,ADMIN_PASSWORD_HASH:`${salt}:${scryptSync(password,salt,64).toString('hex')}`,ADMIN_SESSION_SECRET:randomBytes(32).toString('hex'),FREE_SCAN_SECRET:randomBytes(32).toString('hex'),OPENAI_API_KEY:'',KIE_API_KEY:'',STRIPE_SECRET_KEY:'',STRIPE_WEBHOOK_SECRET:''};
delete env.VERCEL;
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--webpack','--hostname','127.0.0.1','--port','3106'],{env,stdio:'ignore'});
const users=[];
async function request(path,token,body,method=body?'POST':'GET',cookie){
 return fetch(origin+path,{method,headers:{Origin:origin,...(token?{Authorization:`Bearer ${token}`} :{}),...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
}
try {
 let ready=false;
 for(let n=0;n<90;n++) { try {if((await fetch(origin+'/api/admin/metrics')).status===401){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,1000)); }
 assert.ok(ready,'Local app must start');
 const tokens=[];
 for(let n=0;n<2;n++){
  const email=`launch-${randomBytes(8).toString('hex')}@example.test`;
  const {data,error}=await svc.auth.admin.createUser({email,password,email_confirm:true});
  assert.ifError(error);users.push(data.user.id);
  const signed=await anon().auth.signInWithPassword({email,password});assert.ifError(signed.error);tokens.push(signed.data.session.access_token);
  const account=await svc.from('billing_accounts').select('user_id').eq('user_id',data.user.id).single();assert.ifError(account.error);
 }
 console.log('PASS real Auth login and signup-to-billing synchronization');
 const create=await request('/api/campaigns',tokens[0],{title:'Local integration product',source_url:'https://example.com/product'});
 assert.equal(create.status,201,await create.clone().text());const body=await create.json();const campaign=body.campaign??body;
 assert.ok(campaign.id,'Campaign ID returned');
 assert.equal((await request(`/api/campaigns/${campaign.id}`,tokens[1])).status,404);
 assert.equal((await request('/api/billing')).status,401);
 const billing=await request('/api/billing',tokens[0]);assert.equal(billing.status,200);assert.equal((await billing.json()).account.plan,null);
 console.log('PASS campaign ownership isolation and customer billing access');
 const publicClient=anon();
 for(const table of ['billing_accounts','model_usage','media_usage','users']){
  const result=await publicClient.from(table).select('*');assert.ok(result.error || result.data.length===0,`${table} must not disclose rows`);
 }
 assert.ok((await publicClient.rpc('admin_metrics')).error);
 const other=anon();await other.auth.setSession({access_token:tokens[1],refresh_token:'unused'});
 const direct=await other.from('campaigns').select('id').eq('id',campaign.id);assert.ok(direct.error || direct.data.length===0);
 console.log('PASS anonymous and authenticated Data API isolation');
 assert.equal((await request('/api/admin/metrics',tokens[0])).status,401);
 assert.equal((await request('/api/admin/session',null,{password:'incorrect'})).status,401);
 const login=await request('/api/admin/session',null,{password});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const metrics=await request('/api/admin/metrics',null,null,'GET',cookie);assert.equal(metrics.status,200);assert.ok((await metrics.json()).overview.users>=2);
 const logout=await request('/api/admin/session',null,null,'DELETE',cookie);assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0|1970/);
 console.log('PASS admin password login, metrics access and logout cookie clearing');
} finally {
 for(const id of users)await svc.auth.admin.deleteUser(id);
 server.kill('SIGTERM');
 await new Promise(resolve=>{server.once('exit',resolve);setTimeout(resolve,5000).unref();});
}

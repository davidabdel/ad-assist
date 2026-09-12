'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

type Account = {
 id: string; email: string; created_at: string; last_seen_at: string|null; plan: string|null; status: string;
 mrr_usd: number; cancel_at_period_end: boolean; period_end: string|null; campaigns: number; active_products: number;
 scans: number; images: number; videos: number; media_failed: number; media_unknown_cost: number;
 media_confirmed_usd: number; media_confirmed_credits: number; media_unconfirmed_estimate: number;
 text_estimated_usd: number; unknown_text_rates: number; paid_usd: number; refunded_usd: number;
 builds_used: number; builds_limit: number; images_used: number; images_limit: number; text_budget_used: number;
 video_balance: number; input_tokens: number; output_tokens: number; cached_tokens: number;
};
type Dashboard = {
 as_of: string; since: string; tracking_started_at: string; history_complete: boolean;
 overview: Record<string,number>; period: Record<string,number>;
 churn: { opening_customers: number; lost_customers: number; opening_mrr: number; lost_mrr: number; customer_rate: number|null; revenue_rate: number|null };
 plans: {plan: string;accounts: number;mrr: number}[];
 daily: {day: string;signups: number;scans: number;text_cost: number;media_cost: number}[];
 accounts: Account[]; accounts_total: number; selected: Account|null;
 campaigns: {id:string;title:string;status:string;is_trial:boolean;archived_at:string|null}[];
 usage: {stage:string;model:string;calls:number;input_tokens:number;output_tokens:number;estimated_usd:number|null;unknown_rates:number}[];
 operations: {last_tick:string|null;queued_jobs:number;stale_jobs:number};
 unattributed: {text_calls:number;media_tasks:number};
};
const money = (n: number|null|undefined) => n == null ? 'Unknown' : new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n);
const count = (n: number) => new Intl.NumberFormat('en-US').format(n);
const rate = (n:number|null) => n === null ? 'Not yet available' : `${(n*100).toFixed(1)}%`;
const field = 'rounded-xl border border-slate-300 bg-white px-4 py-3 text-base';
function Stat({label,value,note}:{label:string;value:string;note:string}) {
 return <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-sm font-medium text-slate-500">{label}</p><p className="my-3 text-3xl font-bold tracking-tight text-slate-950">{value}</p><p className="text-sm leading-relaxed text-slate-500">{note}</p></div>;
}
export function AdminDashboard() {
 const [data,setData]=useState<Dashboard|null>(null),[auth,setAuth]=useState(false),[password,setPassword]=useState('');
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[days,setDays]=useState(30);
 const [search,setSearch]=useState(''),[filter,setFilter]=useState(''),[page,setPage]=useState(0),[user,setUser]=useState('');
 const [sort,setSort]=useState('newest');
 const [refresh,setRefresh]=useState(0);
 useEffect(()=>{
   const controller=new AbortController(); let running=false;
   async function load(){
     if(running || document.visibilityState==='hidden') return; running=true;
     try {
       const query=new URLSearchParams({days:String(days),page:String(page),search:filter,sort,...(user?{user}:{})});
       const res=await fetch(`/api/admin/metrics?${query}`,{cache:'no-store',signal:controller.signal});
       if(res.status===401){setAuth(false);setData(null);return;}
       const body=await res.json(); if(!res.ok) throw new Error(body.error);
       setData(body);setAuth(true);setError('');
     }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Could not refresh');}
     finally{running=false;}
   }
   void load(); const timer=setInterval(load,30000);document.addEventListener('visibilitychange',load);
   return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',load);};
 },[days,page,filter,user,refresh,sort]);
 async function login(e:React.FormEvent){
   e.preventDefault();setBusy(true);setError('');
   try{const res=await fetch('/api/admin/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});const b=await res.json();if(!res.ok)throw new Error(b.error);setPassword('');setAuth(true);setRefresh(v=>v+1);}
   catch(e){setError(e instanceof Error?e.message:'Sign-in failed');}finally{setBusy(false);}
 }
 const logout=useCallback(async()=>{const res=await fetch('/api/admin/session',{method:'DELETE'});if(res.ok){setAuth(false);setData(null);setPassword('');}else setError('Could not sign out. Try again.');},[]);
 if(!auth)return <main className="site flex min-h-screen items-center justify-center bg-navy px-5 text-white"><form onSubmit={login} className="w-full max-w-md rounded-3xl border border-white/15 bg-white/5 p-8"><Link href="/" className="text-xl font-bold">adtocart.cc</Link><h1 className="mt-8 text-3xl font-bold">Owner dashboard</h1><p className="mt-3 leading-relaxed text-slate-300">Sign in with your admin password to view business and customer data.</p><label className="mt-7 block text-sm font-bold">Admin password<input autoComplete="current-password" type="password" required value={password} onChange={e=>setPassword(e.target.value)} className={`${field} mt-2 w-full text-slate-900`} /></label>{error&&<p role="alert" className="mt-4 text-orange-200">{error}</p>}<button disabled={busy} className="bg-brand-gradient mt-6 w-full rounded-xl p-4 font-bold disabled:opacity-50">{busy?'Signing in…':'Open dashboard'}</button></form></main>;
 const o=data?.overview,p=data?.period,a=data?.selected;
 return <main className="site min-h-screen bg-[#F4F7FB] text-slate-900">
  <header className="border-b border-slate-800 bg-navy px-5 py-5 text-white"><div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4"><div><Link href="/" className="text-xl font-extrabold">adtocart.cc</Link><span className="ml-4 text-sm text-teal">Owner dashboard</span></div><button onClick={logout} className="rounded-lg border border-white/30 px-4 py-2 text-sm">Sign out of admin</button></div></header>
  <div className="mx-auto max-w-[1440px] px-5 py-9 sm:px-8">
   <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-3xl font-bold sm:text-4xl">Your business, at a glance.</h1><p className="mt-3 text-sm text-slate-500">{data?`Updated ${new Date(data.as_of).toLocaleTimeString()} · refreshes every 30 seconds while visible`:'Loading live data…'}</p></div><label className="text-sm font-semibold">Reporting period<select value={days} onChange={e=>setDays(Number(e.target.value))} className={`${field} ml-3`}>{[7,30,90,365].map(d=><option key={d} value={d}>Last {d} days</option>)}</select></label></div>
   {error&&<p role="alert" className="mb-6 rounded-xl bg-orange-100 p-4 text-orange-900">{error} {data?'The last successful data is still shown.':''}</p>}
   {data&&o&&p&&<>
    {!data.history_complete&&<p className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">Subscription history starts {new Date(data.tracking_started_at).toLocaleDateString()}. This period is not fully covered, so churn is unavailable. Historical costs may also be incomplete.</p>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
     <Stat label="Monthly recurring revenue" value={money(o.mrr)} note="Current subscription run rate; includes past-due accounts. Excludes credit packs and tax." />
     <Stat label="Paying accounts" value={count(o.paying)} note={`${count(o.users)} registered accounts · ${rate(o.users?o.paying/o.users:0)} currently on paid subscriptions`} />
     <Stat label="New accounts" value={count(o.new_users)} note={`During the selected period · ${count(o.active_30d)} used the app in the last 30 days`} />
     <Stat label="Cash collected" value={money(p.cash_collected)} note={`Paid invoices and video packs in this period. ${money(p.refunds_on_period_payments)} refunds recorded.`} />
    </div>
    <p className="mt-4 text-sm text-slate-500">Background processing: {data.operations.last_tick?`last tick ${new Date(data.operations.last_tick).toLocaleString()}`:'no heartbeat recorded'} · {data.operations.queued_jobs} queued browser jobs · {data.operations.stale_jobs} stale running jobs.</p>
    <h2 className="mb-4 mt-9 text-xl font-bold">Retention and uptake</h2>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
     <Stat label="Customer churn" value={rate(data.churn.customer_rate)} note={`${data.churn.lost_customers} opening-cohort customers lost · ${data.churn.opening_customers} at period start. Reactivated accounts excluded.`} />
     <Stat label="Churned recurring revenue" value={rate(data.churn.revenue_rate)} note={`${money(data.churn.lost_mrr)} lost from the opening cohort. Downgrades are not included.`} />
     <Stat label="Cancellation scheduled" value={count(o.cancel_scheduled)} note={`${count(o.past_due)} accounts past due. Scheduled cancellation is not yet churn.`} />
     <Stat label="Activated accounts" value={count(o.activated)} note={`Created at least one campaign. ${count(o.active_24h)} active in 24h · ${count(o.active_7d)} in 7 days.`} />
    </div>
    <div className="mt-7 grid gap-5 lg:grid-cols-[2fr_1fr]">
     <section className="rounded-2xl border border-slate-200 bg-white p-6"><h2 className="text-xl font-bold">Daily product scans</h2><p className="mt-2 text-sm text-slate-500">Completed scans · UTC calendar days</p><div role="img" aria-label="Daily completed product scans. Exact counts are available by hovering each bar." className="mt-6 flex h-36 items-end gap-1 overflow-hidden">{data.daily.map(d=><div title={`${d.day}: ${d.scans} scans, ${d.signups} signups`} key={d.day} className="min-w-px flex-1 rounded-t bg-teal" style={{height:`${Math.max(2,100*d.scans/Math.max(1,...data.daily.map(x=>x.scans)))}%`}} />)}</div><div className="mt-3 flex justify-between text-xs text-slate-500"><span>{data.daily[0]?.day}</span><span>{data.daily.at(-1)?.day}</span></div><details className="mt-4 text-sm"><summary className="cursor-pointer font-semibold">View daily figures</summary><div className="mt-3 max-h-60 overflow-auto"><table className="w-full text-left"><thead><tr><th>Date</th><th>Scans</th><th>Signups</th><th>AI cost*</th></tr></thead><tbody>{data.daily.map(d=><tr key={d.day}><td>{d.day}</td><td>{d.scans}</td><td>{d.signups}</td><td>{money(d.text_cost+d.media_cost)}</td></tr>)}</tbody></table></div></details></section>
     <section className="rounded-2xl border border-slate-200 bg-white p-6"><h2 className="text-xl font-bold">Subscription mix</h2><div className="mt-5 space-y-5">{data.plans.map(plan=><div key={plan.plan} className="flex justify-between border-b border-slate-100 pb-3"><div><p className="font-bold capitalize">{plan.plan}</p><p className="text-sm text-slate-500">{plan.accounts} accounts</p></div><p className="font-bold">{money(plan.mrr)}<span className="block text-right text-xs font-normal text-slate-500">MRR</span></p></div>)}</div></section>
    </div>
    <h2 className="mb-4 mt-9 text-xl font-bold">Production and AI costs · selected period</h2>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
     <Stat label="Products scanned" value={count(p.scans_completed)} note={`${p.scans_started} attempts · ${p.scans_failed} failed · ${p.anonymous_scans} not linked to an account`} />
     <Stat label="Images / videos submitted" value={`${count(p.images)} / ${count(p.videos)}`} note={`${p.media_failed} failed tasks. Images include previews and video opening frames. Retries count separately.`} />
     <Stat label="Confirmed media cost" value={money(p.media_confirmed_usd)} note={`Provider-reported credits × $0.005. ${money(p.media_unconfirmed_estimate)} additional unconfirmed estimate.`} />
     <Stat label="Estimated text cost" value={money(p.text_estimated_usd)} note="Actual provider token counts at configured rates. Includes reasoning; this is not a reconciled invoice total." />
    </div>
    <p className="mt-4 text-sm leading-relaxed text-slate-500">* AI cost combines estimated text cost and confirmed media cost; it excludes hosting, support, payment fees and unknown charges. {o.unresolved_reservations} reservations have remained unresolved for over 10 minutes. {o.unknown_text_rates} calls have unknown pricing; {o.media_unknown_cost} media tasks have unconfirmed cost. {data.unattributed.text_calls} text calls and {data.unattributed.media_tasks} media tasks are not linked to an account.</p>
    <section className="mt-9 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
     <div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-xl font-bold">Accounts</h2><p className="mt-1 text-sm text-slate-500">Lifetime usage and recorded costs · select an account for detail</p></div><label className="text-sm">Sort <select value={sort} onChange={e=>{setSort(e.target.value);setPage(0);}} className={field}><option value="newest">Newest accounts</option><option value="cost">Highest AI cost</option><option value="mrr">Highest MRR</option></select></label><form onSubmit={e=>{e.preventDefault();setFilter(search);setPage(0);}} className="flex gap-2"><input aria-label="Search accounts by email" className={field} placeholder="Search email" value={search} onChange={e=>setSearch(e.target.value)} /><button className="rounded-xl bg-navy px-4 font-bold text-white">Search</button></form></div>
     <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="border-b border-slate-200 text-slate-500"><tr>{['Account','Plan / status','MRR','Scans','Images / videos','Text estimate','Media confirmed','Paid to date'].map(h=><th key={h} className="px-3 py-3 font-medium">{h}</th>)}</tr></thead><tbody>{data.accounts.map(row=><tr key={row.id} className="border-b border-slate-100 hover:bg-slate-50"><td className="px-3 py-4"><button onClick={()=>setUser(row.id)} className="text-left font-bold text-accent underline underline-offset-4">{row.email}</button><p className="mt-1 text-xs text-slate-500">Joined {new Date(row.created_at).toLocaleDateString()}</p></td><td className="px-3 capitalize">{row.plan??'Free'}<p className="text-xs text-slate-500">{row.status}</p></td><td className="px-3">{money(row.mrr_usd)}</td><td className="px-3">{row.scans}</td><td className="px-3">{row.images} / {row.videos}</td><td className="px-3">{money(row.text_estimated_usd)}</td><td className="px-3">{money(row.media_confirmed_usd)}</td><td className="px-3">{money(row.paid_usd)}</td></tr>)}</tbody></table>{!data.accounts.length&&<p className="py-8 text-slate-500">No accounts match this search.</p>}</div>
     <div className="mt-5 flex justify-between text-sm"><span>{data.accounts_total} accounts · page {page+1}</span><div className="flex gap-5"><button disabled={page===0} onClick={()=>setPage(v=>v-1)} className="font-bold disabled:opacity-30">Previous</button><button disabled={(page+1)*25>=data.accounts_total} onClick={()=>setPage(v=>v+1)} className="font-bold disabled:opacity-30">Next</button></div></div>
    </section>
    {a&&<section aria-label="Account details" className="mt-7 rounded-2xl border-2 border-accent/30 bg-white p-6"><div className="flex items-start justify-between gap-4"><div><h2 className="break-all text-2xl font-bold">{a.email}</h2><p className="mt-2 text-slate-500">{a.plan??'Free'} · {a.status} · {a.period_end?`Billing period ends ${new Date(a.period_end).toLocaleDateString()}`:'No subscription'}</p></div><button onClick={()=>setUser('')} className="text-sm font-bold">Close details</button></div>
     <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Stat label="Campaign allowance" value={`${a.builds_used} / ${a.builds_limit}`} note={`${a.active_products} active products · ${a.campaigns} campaigns total`} /><Stat label="Image allowance" value={`${a.images_used} / ${a.images_limit}`} note={`${a.video_balance} video credits remaining`} /><Stat label="Recorded AI cost*" value={money(Number(a.text_estimated_usd)+Number(a.media_confirmed_usd))} note={`${money(a.media_unconfirmed_estimate)} media estimate not included; ${a.unknown_text_rates} unpriced model calls`} /><Stat label="Media provider credits" value={count(a.media_confirmed_credits)} note={`${a.media_unknown_cost} tasks still have unconfirmed costs; credits are provider units, not customer video credits`} /></div>
     <p className="mt-5 text-base">Lifetime cash received: <strong>{money(a.paid_usd)}</strong> · refunds: <strong>{money(a.refunded_usd)}</strong> · cash less refunds and recorded AI cost*: <strong>{money(a.paid_usd-a.refunded_usd-a.text_estimated_usd-a.media_confirmed_usd)}</strong>. This is not profit.</p><p className="mt-5 text-sm text-slate-500">Input tokens: {count(a.input_tokens)} · cached: {count(a.cached_tokens)} · output, including reasoning: {count(a.output_tokens)}. Monthly text budget consumed: {money(a.text_budget_used)}.</p>
     <div className="mt-6 overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th className="py-3">Generation stage / model</th><th>Calls</th><th>Estimated text cost</th></tr></thead><tbody>{data.usage.map(u=><tr className="border-t border-slate-100" key={`${u.stage}:${u.model}`}><td className="py-3">{u.stage}<span className="ml-3 text-slate-500">{u.model}</span></td><td>{u.calls}</td><td>{money(u.estimated_usd)}{u.unknown_rates?' + unknown pricing':''}</td></tr>)}</tbody></table></div>
     <h3 className="mt-6 font-bold">Recent campaigns (up to 100)</h3><div className="mt-3 grid gap-3 sm:grid-cols-2">{data.campaigns.map(c=><div key={c.id} className="rounded-xl bg-slate-50 p-4"><p className="font-semibold">{c.title}</p><p className="mt-1 text-sm text-slate-500">{c.status} {c.is_trial?'· Trial':''} {c.archived_at?'· Archived':''}</p></div>)}</div>
    </section>}
   </>}
  </div>
 </main>;
}

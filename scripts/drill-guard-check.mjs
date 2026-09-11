/**
 * Proof that a check-script campaign never opens Chrome on this Mac, and that a
 * real one still does.
 *
 * WHY THIS EXISTS. The other check scripts seed real campaigns and drive the
 * real routes — deliberately, because asserting against a mock of advance() is
 * how two holes got shipped. But `pages_built` queues real ad_scan rows, and
 * the launchd worker drains that table within five seconds by opening a Chrome
 * window and driving the Meta Ad Library in it. So running a check hijacked the
 * machine, and it was reported as the app re-scanning a finished campaign.
 *
 * A guard that skips work is the dangerous kind: get it slightly wrong and real
 * scans stop silently. So the control here matters more than the assertion —
 * a non-drill job must still try to open Chrome. It is pointed at a CHROME_PATH
 * that does not exist, so the real path is proven by the launch failing rather
 * than by a browser window opening over whatever David is doing.
 *
 *   launchctl bootout gui/$UID/com.uconnect.adassist.worker   # it drives --once itself
 *   node scripts/drill-guard-check.mjs
 *   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.uconnect.adassist.worker.plist
 *
 * Nothing here bills: no KIE call, no model call, no Facebook page load.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}});
let fails = 0;
const check = (name, ok, detail='') => { console.log(`${ok?'✓':'✗'} ${name}${ok?'':'  → '+detail}`); if(!ok) fails++; };

const {data:{users}} = await db.auth.admin.listUsers();
const userId = users[0].id;

async function seed(title, isDrill) {
  const {data,error} = await db.from('campaigns').insert({
    user_id: userId, title, slug: `${title}-${Date.now()}`,
    source_url: 'https://example.com/thing', region: 'AU', persona_target: 2,
    status: 'scanning', is_drill: isDrill,
    scraped_data: { raw:{}, brief:{product_name:'Thing'} },
  }).select('id').single();
  if (error) throw new Error(error.message);
  const {data:job,error:je} = await db.from('scanner_jobs').insert({
    campaign_id: data.id, kind:'ad_scan', region:'AU', media_type:'image',
    search_terms:['zzz-drill-check-never-searched'],
  }).select('id').single();
  if (je) throw new Error(je.message);
  return { campaign: data.id, job: job.id };
}

function runWorkerOnce(extraEnv) {
  // stdout AND stderr: the worker reports a job failure with console.error, so
  // reading only stdout is how an assertion about a failure passes on nothing.
  const r = spawnSync('/opt/homebrew/bin/node', ['scanner/src/worker.js','--once'],
    { env: { ...process.env, ...extraEnv, TICK_URL: '' }, encoding: 'utf8', timeout: 120000 });
  return (r.stdout ?? '') + (r.stderr ?? '');
}
const portAlive = async () => {
  try { const r = await fetch('http://127.0.0.1:9333/json/version', {signal:AbortSignal.timeout(1500)}); return r.ok; }
  catch { return false; }
};

// ── 1. a drill job is closed without a browser ────────────────────────
const drill = await seed('drill-guard-check', true);
const out1 = runWorkerOnce({});
console.log(out1.trim().split('\n').map(l=>'   '+l).join('\n'));
check('the drill job was claimed', out1.includes('▶ ad_scan'), out1);
check('and closed without opening Chrome', out1.includes('closed without opening Chrome'), out1);
check('no Chrome debug port came up', !(await portAlive()));
const {data:d1} = await db.from('scanner_jobs').select('status,notes').eq('id', drill.job).single();
check('the row reads completed', d1.status === 'completed', d1.status);
check('and says why', /drill campaign/.test(d1.notes ?? ''), String(d1.notes));

// ── 2. CONTROL: a real job is NOT skipped ─────────────────────────────
// Chrome is pointed at a path that does not exist, so the real path is proven
// by the launch failing rather than by a window opening on David's screen.
const real = await seed('drill-guard-control', false);
const out2 = runWorkerOnce({ CHROME_PATH: '/nonexistent/Chrome' });
console.log(out2.trim().split('\n').map(l=>'   '+l).join('\n'));
check('the real job was NOT treated as a drill', !out2.includes('closed without opening Chrome'), out2);
check('it tried to open Chrome and could not', /could not start Chrome/.test(out2), out2);
check('the worker survived the broken Chrome', !/Unhandled 'error' event/.test(out2), out2);
const {data:d2} = await db.from('scanner_jobs').select('status,notes,error_message').eq('id', real.job).single();
check('the real row was not completed', d2.status !== 'completed', d2.status);
check('the failure was recorded on the row', /could not start Chrome/.test(d2.error_message ?? ''), String(d2.error_message));
check('and it went back in the queue to retry', d2.status === 'queued', d2.status);
check('and carries no drill note', !/drill campaign/.test(d2.notes ?? ''), String(d2.notes));

// ── 3. the campaign an operator actually has is not a drill ───────────
const {data:pt} = await db.from('campaigns').select('title,is_drill').eq('id','3f6198bc-3635-46ec-bcf5-e55f1d3e048f').single();
check('Pointtaken is not a drill', pt.is_drill === false, JSON.stringify(pt));

await db.from('campaigns').delete().in('id',[drill.campaign, real.campaign]);
const {data:left} = await db.from('campaigns').select('id,title,is_drill');
console.log('\ncampaigns left:', JSON.stringify(left));
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

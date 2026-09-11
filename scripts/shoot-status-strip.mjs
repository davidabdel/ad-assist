/**
 * Look at the thing.
 *
 * The status strip is a pure function with checks on it, but the complaint it
 * answers was about a SCREEN — so the screen gets looked at rather than
 * reasoned about. Seeds throwaway campaigns in the states that matter, signs a
 * real browser in, and writes a PNG of each.
 *
 *   BASE=http://localhost:3100 node scripts/shoot-status-strip.mjs
 *
 * Chrome notes paid for elsewhere and repeated here so they are not re-earned:
 * a dedicated --user-data-dir (Chrome 136+ refuses CDP on the default profile,
 * and a stale --no-startup-window Chrome holds the port with zero tabs), PUT to
 * /json/new, and never --virtual-time-budget, which kills the session mid-run.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
// Node's own WebSocket. `ws` is not a dependency of this app and adding one for
// a screenshot script would be a dependency nobody asked for.

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const BASE = process.env.BASE ?? 'http://localhost:3100';
const PORT = 9333;
const OUT = new URL('../.shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const EMAIL = `shot+${Date.now()}@uconnect.com.au`;
const PASSWORD = `shot-${Date.now()}`;
const { data: created, error: uErr } = await db.auth.admin.createUser({
  email: EMAIL, password: PASSWORD, email_confirm: true,
});
if (uErr) throw new Error(uErr.message);
const userId = created.user.id;
await db.from('users').upsert({ id: userId, email: EMAIL });

/** One campaign per state worth looking at. */
async function seed(title, patch) {
  const { data, error } = await db.from('campaigns').insert({
    user_id: userId,
    title,
    is_drill: true,
    slug: `${title.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}`,
    source_url: 'https://example.com/thing',
    region: 'AU',
    persona_target: 2,
    scraped_data: { raw: { url: 'https://example.com/thing' }, brief: { product_name: 'Thing' } },
    ...patch,
  }).select('id').single();
  if (error) throw new Error(`${title}: ${error.message}`);
  return data.id;
}

const stopped = await seed('Stopped run', {
  status: 'failed',
  error_message: 'Persona batch failed: the model returned nothing three times running.',
});
const finished = await seed('Finished run', { status: 'ideas_ready' });

// The approval gate. `advance()` returns terminal here without calling a model,
// so opening this screen costs nothing.
const waitingForYou = await seed('Waiting on you', { status: 'base_review' });
const { error: bpErr } = await db.from('base_pages').insert({
  campaign_id: waitingForYou,
  page_title: 'Thing',
  hero_headline: 'The thing, for people who have had enough of the other thing',
  hero_subheadline: 'One line under it.',
  reasons: [1, 2, 3, 4].map((n) => ({
    number: n, title: `Reason ${n}`, body: 'Why this matters to the buyer.', image_url: null,
  })),
  testimonials: [],
  offer_headline: 'Start free',
  offer_body: 'No card.',
  cta_button_text: 'Start free',
  cta_url: 'https://example.com/thing',
});
if (bpErr) throw new Error(`base page: ${bpErr.message}`);

// The Mac wait. Seeded as `running` with a claim on it, so the worker on this
// machine will not pick it up — `claim_job` only takes `queued` rows. A shot
// that costs ten minutes of somebody's Chrome is not a shot worth taking.
const onTheMac = await seed('Reading the ad library', { status: 'scanning' });
const { error: jErr } = await db.from('scanner_jobs').insert([
  { campaign_id: onTheMac, kind: 'ad_scan', status: 'completed', region: 'AU', media_type: 'image', search_terms: ['50% off'], items_found: 15, items_qualified: 6, completed_at: new Date(Date.now() - 60_000).toISOString() },
  { campaign_id: onTheMac, kind: 'ad_scan', status: 'running', region: 'AU', media_type: 'video', search_terms: ['before and after'], items_found: 0, items_qualified: 0, claimed_at: new Date().toISOString() },
]);
if (jErr) throw new Error(`scan jobs: ${jErr.message}`);

const ids = {
  stopped, finished, 'waiting-for-you': waitingForYou, 'waiting-for-mac': onTheMac,
};

// ── a real browser ─────────────────────────────────────────────────
// A Chrome left over from a previous run holds this port with no usable tab and
// looks exactly like "not running". Clear it rather than debug it again.
// Unconditional, not "if one seems to be there": a half-dead Chrome answers
// /json/version perfectly well and still hands out tabs that never load a page.
// Three runs were spent diagnosing that as an app fault.
spawn('pkill', ['-f', 'adassist-shots-profile'], { stdio: 'ignore' });
await delay(2000);
rmSync('/tmp/adassist-shots-profile', { recursive: true, force: true });

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/adassist-shots-profile',
  '--window-size=430,1400',          // a phone, which is where he saw it
  '--no-first-run', '--no-default-browser-check',
], { stdio: 'ignore' });
await delay(2500);

const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');

// ── sign in ────────────────────────────────────────────────────────
await send('Page.navigate', { url: `${BASE}/` });
// The app renders "Loading…" until the Supabase session resolves, so the form
// does not exist yet. A fixed wait here silently filled nothing and cost two
// runs — wait for the field itself.
for (let i = 0; i < 40; i += 1) {
  await delay(1000);
  if (await evaluate('Boolean(document.querySelector("input[type=email]"))')) break;
  if (i === 39) throw new Error('the sign-in form never appeared');
}
await evaluate(`(() => {
  const set = (el, v) => {
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set(document.querySelector('input[type=email]'), ${JSON.stringify(EMAIL)});
  set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)});
  document.querySelector('form').requestSubmit();
  return true;
})()`);
await delay(5000);

const who = await evaluate('document.body.innerText.slice(0, 120)');
console.log('after sign-in:', JSON.stringify(who));

// ── one shot per state ─────────────────────────────────────────────
for (const [name, id] of Object.entries(ids)) {
  await send('Page.navigate', { url: `${BASE}/campaigns/${id}` });
  // Dev compiles a route on its first hit, so a fixed wait is a coin toss.
  // Wait for the screen to stop saying "Loading…" instead.
  for (let i = 0; i < 40; i += 1) {
    await delay(1000);
    const body = await evaluate('document.body.innerText');
    if (body && !body.includes('Loading…')) break;
    if (i === 39) console.log('  still loading after 40s');
  }
  await delay(2000);
  const strip = await evaluate(`(() => {
    const h = [...document.querySelectorAll('p')].map((p) => p.innerText.trim());
    return h.slice(0, 6).join(' | ');
  })()`);
  console.log(`${name}: ${strip}`);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(`${OUT}${name}.png`, Buffer.from(shot.result.data, 'base64'));
  console.log(`  wrote .shots/${name}.png`);
}

ws.close();
chrome.kill();
for (const id of Object.values(ids)) await db.from('campaigns').delete().eq('id', id);
await db.auth.admin.deleteUser(userId);
console.log('\ndone');

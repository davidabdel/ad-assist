/**
 * Proof that a campaign does not stop dead once its pages are live, and that
 * the screen can never again claim to be working while nothing is driving it.
 *
 * Two failures, one cause. `advance()` returned `terminal: true` when the last
 * landing page landed, which stopped the browser loop ONE CALL BEFORE the state
 * that queues the ad-library scan. The campaign then sat at `pages_built` with
 * zero scanner jobs — while the header, which picked its wording from the
 * campaign status alone, said "Now reading Meta's ad library". Eight minutes of
 * a screen confidently describing work that had not been handed to anybody.
 *
 * So this checks both halves:
 *
 *   - the pure status function, against every state including the one that went
 *     wrong: a stopped loop over a `pages_built` campaign
 *   - the real HTTP route, against a real campaign seeded at `pages_built`:
 *     one advance must queue the searches, move to `scanning`, and NOT be
 *     terminal
 *
 * Nothing here calls a model or KIE. It bills nothing.
 *
 *   BASE=http://localhost:3100 node scripts/keep-going-check.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { describeLive, humanDuration } from '../src/lib/campaign-live.ts';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const BASE = process.env.BASE ?? 'http://localhost:3100';
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const SVC = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const db = createClient(URL_, SVC, { auth: { persistSession: false } });

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ── the status strip, with no browser and no database ──────────────
console.log('\nthe one line that answers "is it frozen"');

/** Everything healthy and mid-run, unless a case below says otherwise. */
const RUNNING = {
  running: true,
  inFlightMs: 2_000,
  sinceTickMs: 3_000,
  sinceChangeMs: 4_000,
  stepTitle: 'Writing 20 landing pages',
  failed: false,
  errorMessage: null,
  finished: false,
  awaitingApproval: false,
  waitingOnMac: false,
  scanJobsDone: 0,
  scanJobsTotal: 0,
};

const working = describeLive(RUNNING);
check('a live loop says Working', working.kind === 'working', working.headline);
check('and names the step it is on',
  working.detail.includes('landing pages'), working.detail);
check('and counts the step, not the poll',
  working.clock.includes('2 seconds'), working.clock);

const betweenUnits = describeLive({ ...RUNNING, inFlightMs: null });
check('between units it counts the last check',
  betweenUnits.clock === 'Checked 3 seconds ago.', betweenUnits.clock);

// THE ONE THAT WENT WRONG. A campaign whose status sounds busy, with nothing
// driving it. Before the fix this rendered as "Now reading Meta's ad library".
const stalled = describeLive({
  ...RUNNING,
  running: false,
  inFlightMs: null,
  sinceTickMs: 480_000,
  sinceChangeMs: 480_000,
  stepTitle: 'Studying ads that already work',
});
check('a stopped loop says Not running, whatever the campaign says',
  stalled.kind === 'stopped' && stalled.headline === 'Not running', stalled.headline);
check('and never claims to be reading anything',
  !/reading|working on|studying/i.test(stalled.detail), stalled.detail);
check('and says how long it has been still',
  stalled.clock === 'Nothing has moved for 8 minutes.', stalled.clock);

const mac = describeLive({
  ...RUNNING, waitingOnMac: true, inFlightMs: null,
  sinceTickMs: 5_000, sinceChangeMs: 240_000, scanJobsDone: 2, scanJobsTotal: 6,
});
check('a Mac wait says so and counts the searches',
  mac.kind === 'waiting-for-mac' && mac.detail.startsWith('2 of 6'), mac.detail);
check('a long search is not mistaken for a hang',
  // The four-minute figure is the change clock and must NOT be what is shown:
  // a single ad-library search legitimately takes minutes.
  mac.clock === 'Checked 5 seconds ago.', mac.clock);

const approval = describeLive({ ...RUNNING, running: false, awaitingApproval: true });
check('an approval gate outranks the stopped loop',
  approval.kind === 'waiting-for-you', approval.kind);

const dead = describeLive({
  ...RUNNING, running: false, failed: true, errorMessage: 'Persona batch failed: timeout',
});
check('a failure outranks everything', dead.kind === 'stopped', dead.kind);
check('and points at the reason rather than repeating it',
  // The full message and a Try again button already sit right below the strip.
  !dead.detail.includes('timeout') && dead.detail.includes('just below'), dead.detail);

const over = describeLive({ ...RUNNING, running: false, finished: true });
check('a finished run is finished, not stopped', over.kind === 'finished', over.kind);

check('durations read as words', humanDuration(1000) === '1 second'
  && humanDuration(90_000) === '1 minute'
  && humanDuration(3_900_000) === '1 hour 5 minutes',
  [humanDuration(1000), humanDuration(90_000), humanDuration(3_900_000)].join(' / '));

// ── the real route, against a real campaign at pages_built ─────────
console.log('\nthe pipeline does not stop when the pages go live');

const EMAIL = `keep-going+${Date.now()}@uconnect.com.au`;
const PASSWORD = `keep-${Date.now()}`;

const { data: created, error: userError } = await db.auth.admin.createUser({
  email: EMAIL, password: PASSWORD, email_confirm: true,
});
if (userError) throw new Error(`could not create the throwaway user: ${userError.message}`);
const userId = created.user.id;
await db.from('users').upsert({ id: userId, email: EMAIL });

const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
const { data: session, error: signInError } = await anon.auth.signInWithPassword({
  email: EMAIL, password: PASSWORD,
});
if (signInError) throw new Error(`could not sign in: ${signInError.message}`);
const token = session.session.access_token;

const slug = `keep-going-${Date.now()}`;
// persona_target 2 so two rows is a finished set — the pages stage is not what
// is under test here, the handover after it is.
const { data: campaign, error: cErr } = await db.from('campaigns').insert({
  user_id: userId,
  title: 'Keep going check',
  slug,
  source_url: 'https://example.com/thing',
  region: 'AU',
  status: 'pages_built',
  persona_target: 2,
  scraped_data: { raw: { url: 'https://example.com/thing' }, brief: { product_name: 'Thing' } },
}).select('id').single();
if (cErr) throw new Error(`could not seed the campaign: ${cErr.message}`);

const { error: pErr } = await db.from('personas').insert([1, 2].map((n) => ({
  campaign_id: campaign.id,
  persona_index: n,
  slug: `buyer-${n}`,
  persona_name: `Buyer ${n}`,
  primary_pain_point: 'x',
  core_desire: 'y',
  angle_hook: 'z',
  custom_hero_headline: 'h',
  custom_reasons: [],
})));
if (pErr) throw new Error(`could not seed personas: ${pErr.message}`);

const advance = async () => {
  const res = await fetch(`${BASE}/api/campaigns/${campaign.id}/advance`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
};

const first = await advance();
check('advance is 200', first.status === 200, JSON.stringify(first.body).slice(0, 200));
check('pages_built is NOT the end of the run', first.body.terminal === false,
  `terminal=${first.body.terminal}`);
check('it moved on to the scan', first.body.status === 'scanning', first.body.status);
check('and says it is now the Mac\'s turn', first.body.waiting === true,
  `waiting=${first.body.waiting}`);

const { data: queued } = await db.from('scanner_jobs')
  .select('id, status, media_type').eq('campaign_id', campaign.id).eq('kind', 'ad_scan');
check('searches were actually queued', (queued?.length ?? 0) > 0, `${queued?.length ?? 0} jobs`);
check('statics and video both', new Set((queued ?? []).map((j) => j.media_type)).size === 2,
  [...new Set((queued ?? []).map((j) => j.media_type))].join(', '));

const { data: moved } = await db.from('campaigns')
  .select('status').eq('id', campaign.id).single();
check('the campaign row moved too', moved.status === 'scanning', moved.status);

// Idempotent: a second call must not double the searches. The loop calls this
// every eight seconds while the Mac works.
const second = await advance();
check('a second call does not stop either', second.body.terminal === false,
  `terminal=${second.body.terminal}`);
const { data: again } = await db.from('scanner_jobs')
  .select('id').eq('campaign_id', campaign.id).eq('kind', 'ad_scan');
check('and does not queue a second set', again.length === queued.length,
  `${queued.length} → ${again.length}`);

// ── tidy up ────────────────────────────────────────────────────────
await db.from('campaigns').delete().eq('id', campaign.id);
await db.auth.admin.deleteUser(userId);

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);

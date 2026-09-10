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
  drivenElsewhere: false,
  macReading: false,
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
  scanJobsRunning: 0,
  readingMs: null,
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

// THE ONE THAT WOULD GO WRONG NEXT. Same campaign, same dead tab — but the
// server is driving it now, which is the entire point of the tick. A screen
// that called this "Not running" would be the same lie pointing the other way.
const elsewhere = describeLive({
  ...RUNNING,
  running: false,
  drivenElsewhere: true,
  inFlightMs: null,
  sinceTickMs: null,
  sinceChangeMs: 6_000,
  stepTitle: 'Writing 20 landing pages',
});
check('a run driven by the server is Working, not Not running',
  elsewhere.kind === 'working', `${elsewhere.kind} / ${elsewhere.headline}`);
check('and says it does not need the screen',
  /without this screen/i.test(elsewhere.detail), elsewhere.detail);
check('and clocks the campaign rather than this tab\'s own idle loop',
  elsewhere.clock === 'Last moved 6 seconds ago.', elsewhere.clock);

// A claimed search carries on with no tab open at all, so it outranks the
// "nothing is driving this" sentence rather than being hidden behind it.
const readingNoTab = describeLive({
  ...RUNNING,
  running: false,
  drivenElsewhere: false,
  macReading: true,
  waitingOnMac: true,
  inFlightMs: null,
  sinceTickMs: null,
  scanJobsDone: 0,
  scanJobsTotal: 2,
  scanJobsRunning: 1,
  readingMs: 200_000,
});
check('a search being read outranks a dead tab',
  readingNoTab.kind === 'waiting-for-mac' && readingNoTab.headline === 'Reading on your Mac',
  readingNoTab.headline);
check('and "0 of 2" never again means nothing is happening',
  readingNoTab.detail.includes('reading another one right now'), readingNoTab.detail);
check('and counts the reading, not the polling',
  readingNoTab.clock === 'Reading for 3 minutes.', readingNoTab.clock);

// The opposite case, which wants the opposite advice: queued, and nothing has
// picked it up.
const unclaimed = describeLive({
  ...RUNNING,
  waitingOnMac: true,
  inFlightMs: null,
  scanJobsDone: 0,
  scanJobsTotal: 2,
  scanJobsRunning: 0,
});
check('an unclaimed search says nothing has picked it up',
  unclaimed.headline === 'Waiting on your Mac' && /has picked/.test(unclaimed.detail),
  unclaimed.detail);

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

// ── the same work, with no browser anywhere near it ────────────────
//
// The tab is no longer the engine. This is the proof: a campaign is driven from
// nothing but a POST carrying a shared secret — no session, no access token, no
// page open — which is what makes a locked phone stop mattering.
console.log('\nit runs with no screen open');

/** Seeds a fresh campaign at pages_built with its pages already written. */
async function seedAtPagesBuilt(label) {
  const { data: c, error } = await db.from('campaigns').insert({
    user_id: userId,
    title: label,
    slug: `${label}-${Date.now()}`,
    source_url: 'https://example.com/thing',
    region: 'AU',
    status: 'pages_built',
    persona_target: 2,
    scraped_data: { raw: { url: 'https://example.com/thing' }, brief: { product_name: 'Thing' } },
  }).select('id').single();
  if (error) throw new Error(`could not seed ${label}: ${error.message}`);
  const { error: e2 } = await db.from('personas').insert([1, 2].map((n) => ({
    campaign_id: c.id,
    persona_index: n,
    slug: `buyer-${n}`,
    persona_name: `Buyer ${n}`,
    primary_pain_point: 'x',
    core_desire: 'y',
    angle_hook: 'z',
    custom_hero_headline: 'h',
    custom_reasons: [],
  })));
  if (e2) throw new Error(`could not seed ${label} personas: ${e2.message}`);
  return c.id;
}

/**
 * Always scoped to one campaign. An unscoped tick drives everything drivable,
 * which on this database means somebody's real campaigns and real model calls.
 */
const tick = async (campaignId, secret = SVC) => {
  const res = await fetch(`${BASE}/api/tick`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ campaign_id: campaignId }),
  });
  return { status: res.status, body: await res.json() };
};

const tickId = await seedAtPagesBuilt('tick-check');

const noAuth = await fetch(`${BASE}/api/tick`, { method: 'POST' });
check('the tick refuses an unsigned request', noAuth.status === 401, `${noAuth.status}`);
const wrongAuth = await tick(tickId, 'not-the-secret');
check('and a wrong secret', wrongAuth.status === 401, `${wrongAuth.status}`);

const ticked = await tick(tickId);
check('the tick is 200', ticked.status === 200, JSON.stringify(ticked.body).slice(0, 200));
const drove = (ticked.body.driven ?? []).find((d) => d.id === tickId);
check('it drove the campaign with no session at all', Boolean(drove),
  JSON.stringify(ticked.body).slice(0, 200));
check('from pages_built to scanning', drove?.to === 'scanning', drove?.to);
check('and stopped because the Mac has it now, not because it ran out',
  drove?.stopped === 'waiting', drove?.stopped);

const { data: tickJobs } = await db.from('scanner_jobs')
  .select('id').eq('campaign_id', tickId).eq('kind', 'ad_scan');
check('the searches were queued by the tick', (tickJobs?.length ?? 0) > 0,
  `${tickJobs?.length ?? 0} jobs`);

// The Mac pokes this every ten seconds forever. A tick that queued a second set
// each time would be six duplicate scans a minute.
await tick(tickId);
const { data: tickJobsAgain } = await db.from('scanner_jobs')
  .select('id').eq('campaign_id', tickId).eq('kind', 'ad_scan');
check('a second tick does not queue a second set',
  tickJobsAgain.length === tickJobs.length, `${tickJobs.length} → ${tickJobsAgain.length}`);

// ── the approval gate still stops it ───────────────────────────────
//
// The whole point of the tick is that it does not need permission to carry on.
// The base page is the one place it must ask anyway.
const { data: parked, error: parkErr } = await db.from('campaigns').insert({
  user_id: userId,
  title: 'tick-gate-check',
  slug: `tick-gate-${Date.now()}`,
  source_url: 'https://example.com/thing',
  region: 'AU',
  status: 'base_review',
  persona_target: 2,
  scraped_data: { raw: { url: 'https://example.com/thing' }, brief: { product_name: 'Thing' } },
}).select('id').single();
if (parkErr) throw new Error(`could not seed the parked campaign: ${parkErr.message}`);
const { error: bpErr } = await db.from('base_pages').insert({
  campaign_id: parked.id,
  page_title: 'Thing',
  hero_headline: 'A thing',
  reasons: [],
  offer_headline: 'Buy the thing',
  cta_button_text: 'Buy',
  cta_url: 'https://example.com/thing',
});
if (bpErr) throw new Error(`could not seed the base page: ${bpErr.message}`);

const gated = await tick(parked.id);
check('a page waiting for approval is left alone',
  (gated.body.driven ?? []).length === 0, JSON.stringify(gated.body).slice(0, 200));
const { data: stillParked } = await db.from('campaigns')
  .select('status').eq('id', parked.id).single();
check('and stays exactly where it is', stillParked.status === 'base_review', stillParked.status);

// ── a finished campaign whose ads cannot be made ───────────────────
//
// `ideas_ready` was terminal AND absent from DRIVABLE, so the step that writes a
// picture for an ad that has no photograph could never reach the campaign it was
// written for: Pointtaken finished before that step existed and sat on sixty
// unmakeable ads. Two things are asserted here — that such a campaign is now
// visited and rewound, and that a finished campaign with nothing wrong with it
// is still left completely alone, because the tick sees it every ten seconds.
//
// NO MODEL CALL. The brief is deliberately absent, so the picture step refuses
// at its first line. That is enough: reaching that refusal is itself the proof
// that a terminal status rewound into the gap-filling branch.
async function seedFinished(label, { withGap, withBrief = false }) {
  const { data: c, error } = await db.from('campaigns').insert({
    user_id: userId,
    title: label,
    slug: `${label}-${Date.now()}`,
    source_url: 'https://example.com/thing',
    region: 'AU',
    status: 'ideas_ready',
    persona_target: 1,
    scraped_data: withBrief
      ? { raw: {}, brief: { brand_name: 'Thing', product_name: 'Thing' } }
      : { raw: {} },
  }).select('id').single();
  if (error) throw new Error(`could not seed ${label}: ${error.message}`);

  const { data: p, error: perr } = await db.from('personas').insert({
    campaign_id: c.id,
    persona_index: 1,
    slug: 'buyer',
    persona_name: 'Buyer',
    primary_pain_point: 'It hurts',
    core_desire: 'It should not',
    angle_hook: 'Stop it hurting',
    custom_hero_headline: 'It should not hurt',
    custom_reasons: [],
  }).select('id').single();
  if (perr) throw new Error(`could not seed the buyer for ${label}: ${perr.message}`);

  const { error: ierr } = await db.from('ad_ideas').insert({
    campaign_id: c.id,
    persona_id: p.id,
    idea_index: 1,
    media_type: 'image',
    angle: 'Stop it hurting',
    hook: 'It hurts',
    headline: 'It should not hurt',
    primary_text: 'It really should not.',
    cta_label: 'Learn more',
    visual_concept: 'Something',
    kie_model: 'google/nano-banana-edit',
    kie_prompt: 'Keep the product exactly as photographed.',
    est_credits: 4,
    est_usd: 0.02,
    destination_url: 'https://example.com/thing',
    // The gap: no photograph of theirs, and no picture described either.
    source_image_url: withGap ? null : 'https://example.com/photo.jpg',
  });
  if (ierr) throw new Error(`could not seed the ad for ${label}: ${ierr.message}`);
  return c.id;
}

const healthyId = await seedFinished('tick-finished-ok', { withGap: false });
const healthy = await tick(healthyId);
check('a finished campaign with nothing to fix is not driven at all',
  (healthy.body.driven ?? []).length === 0, JSON.stringify(healthy.body).slice(0, 200));
const { data: untouched } = await db.from('campaigns')
  .select('status').eq('id', healthyId).single();
check('and stays finished', untouched.status === 'ideas_ready', untouched.status);

const stuckId = await seedFinished('tick-finished-unmakeable', { withGap: true });
const healed = await tick(stuckId);
const healRun = (healed.body.driven ?? []).find((d) => d.id === stuckId);
check('a finished campaign with an unmakeable ad IS driven',
  Boolean(healRun), JSON.stringify(healed.body).slice(0, 200));
check('it rewinds out of the finished status',
  healRun?.from === 'ideas_ready' && healRun?.to !== 'ideas_ready',
  `${healRun?.from} → ${healRun?.to}`);
check('and reaches the step that writes the missing picture',
  (healRun?.last ?? '').includes('no photograph'), healRun?.last);
const { data: rewound } = await db.from('campaigns')
  .select('status').eq('id', stuckId).single();
check('the row itself left ideas_ready', rewound.status !== 'ideas_ready', rewound.status);

// ── tidy up ────────────────────────────────────────────────────────
await db.from('campaigns').delete()
  .in('id', [campaign.id, tickId, parked.id, healthyId, stuckId]);
await db.auth.admin.deleteUser(userId);

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);

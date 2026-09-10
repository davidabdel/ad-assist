// The Mac-side worker. Claims jobs from Supabase, runs them in real Chrome,
// writes results back. This is the entire interface between the Vercel app and
// this machine — there is no inbound connection, no port, no tunnel.
//
//   npm start                # claim jobs forever
//   npm start -- --once      # claim one job, run it, exit
//
// Two things it does that are easy to get wrong:
//
// 1. IT HEARTBEATS WHILE WORKING. reap_stale_jobs reclaims a 'running' job when
//    the heartbeat goes quiet, not when the claim gets old — so a genuinely slow
//    scan is never stolen from a worker that is still alive. That only holds if
//    the worker actually reports in, which is what the interval below does.
//
// 2. IT NEVER RETRIES IN-PROCESS. A failed job goes back with its error and the
//    attempt count on the row decides what happens next. Retrying here would
//    hide a Chrome that has stopped working from every dashboard.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

// The worker needs the same Supabase project the app uses. Read scanner/.env if
// it exists, then fall back to the app's .env.local, so there is one set of keys
// on this machine rather than two that can drift apart.
const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, '../.env'), quiet: true });
dotenv.config({ path: resolve(here, '../../.env.local'), quiet: true });

import { ingestProduct } from './ingest.js';
import { scanAdLibrary } from './adlibrary.js';

const WORKER_ID = process.env.SCANNER_WORKER_ID || `mac-${process.pid}`;
const POLL_MS = Number(process.env.SCANNER_POLL_MS || 5000);
const HEARTBEAT_MS = 30_000;
/**
 * How many jobs this worker runs at once.
 *
 * One at a time meant a campaign's two searches took eight minutes rather than
 * four, with the second sitting untouched — and the screen had no word for a
 * queued-but-unclaimed job, so it read as a stall. Each job is its own Chrome
 * tab in the one shared browser, so the cost of a second is a tab, not a
 * browser.
 *
 * Three rather than more because they are all reading the same site: Meta
 * throttles, and a worker that trips that turns a slow scan into a failed one.
 */
const CONCURRENCY = Math.max(1, Number(process.env.SCANNER_CONCURRENCY || 3));
const ONCE = process.argv.includes('--once');

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    // The service role is not optional here: claim_job is service-role only, on
    // purpose — the anon key is shipped in the browser on every public page.
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. '
      + 'Copy the app\'s .env.local, or make a scanner/.env with the same two values.');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── driving the pipeline ──────────────────────────────────────────────
/**
 * The app's pipeline used to be driven by whatever browser tab was open on it.
 * Lock a phone and that tab freezes mid-wait, with no error, and the run stops
 * until somebody looks at the screen again.
 *
 * So this machine drives it instead. Not by doing the work — the work stays on
 * the server, where the keys and the models are — but by saying "keep going"
 * every few seconds, which is all the tab was ever doing. This is the right
 * machine for it because it is already the one that never sleeps and is already
 * compulsory for the ad-library scan: the run's dependency on it is not new.
 *
 * Vercel's own scheduler would be the obvious home for this and cannot be: the
 * project is on the Hobby plan, where a cron job fires once a day. See the note
 * in src/app/api/tick/route.ts.
 */
const TICK_URL = process.env.TICK_URL;
const TICK_EVERY_MS = Number(process.env.TICK_EVERY_MS || 10_000);
/**
 * The service role key, which this worker already holds — so switching the
 * driver on took no new secret at either end. The route accepts CRON_SECRET
 * too, for the day Vercel's scheduler does the poking instead.
 */
const TICK_SECRET = process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;

let ticking = null;
let tickedAt = 0;
let tickWarned = false;

/**
 * Ask the server to move every campaign along.
 *
 * Never awaited by the caller. A tick can legitimately run for minutes — it is
 * writing landing pages — and blocking the job loop behind it would mean a
 * queued scan sat untouched while the pipeline thought. The in-flight guard is
 * what keeps this to one driver at a time; the server holds a per-campaign lock
 * as well, so an overlap is safe rather than merely unlikely.
 */
function pokeTick() {
  if (ticking || Date.now() - tickedAt < TICK_EVERY_MS) return;
  if (!TICK_URL || !TICK_SECRET) {
    if (!tickWarned) {
      tickWarned = true;
      console.warn('  TICK_URL is not set, so campaigns still only run while a browser tab is '
        + 'open on them. Set it to https://<your-app>/api/tick in .env.local.');
    }
    return;
  }

  tickedAt = Date.now();
  ticking = fetch(TICK_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${TICK_SECRET}` },
  })
    .then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        console.warn(`  tick failed: ${res.status} ${body?.error ?? ''}`);
        return;
      }
      // Printed because this window is the only place the run is visible once
      // the phone is in a pocket. Silence when nothing moved, so an idle
      // machine does not scroll all night.
      for (const c of body?.driven ?? []) {
        console.log(`  ${c.title}: ${c.last}`);
      }
    })
    .catch((e) => console.warn(`  tick failed: ${e.message}`))
    .finally(() => { ticking = null; });
}

function beat(client, jobId) {
  const timer = setInterval(async () => {
    const { error } = await client.from('scanner_jobs')
      .update({ heartbeat_at: new Date().toISOString() })
      .eq('id', jobId).eq('claimed_by', WORKER_ID);
    if (error) console.warn(`  heartbeat failed: ${error.message}`);
  }, HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ── ingest ────────────────────────────────────────────────────────────
async function runIngest(client, job) {
  const payload = await ingestProduct(job.target_url);

  // Merge, don't overwrite: the brief may already be there from a re-run, and
  // clobbering it would silently throw away a completed stage.
  const { data: campaign } = await client.from('campaigns')
    .select('scraped_data').eq('id', job.campaign_id).maybeSingle();

  const { error } = await client.from('campaigns').update({
    scraped_data: { ...(campaign?.scraped_data ?? {}), raw: payload },
  }).eq('id', job.campaign_id);
  if (error) throw new Error(`could not save the scrape: ${error.message}`);

  return {
    items_found: payload.reviews.length,
    items_qualified: payload.structured ? 1 : 0,
    notes: payload.warnings.length ? payload.warnings.join(' · ') : null,
    summary: `${payload.structured?.product_name ?? payload.page_title} — `
      + `${payload.reviews.length} reviews, source ${payload.structured_source ?? 'page text only'}`,
  };
}

// ── ad library scan ───────────────────────────────────────────────────
async function runAdScan(client, job) {
  const found = [];
  const notes = [];
  for (const term of job.search_terms) {
    const result = await scanAdLibrary({
      region: job.region, mediaType: job.media_type, term,
      ceiling: Number(process.env.SCANNER_AD_CEILING || 300),
    });
    notes.push(...result.notes.map((n) => `"${term}": ${n}`));
    found.push(...result.ads);
  }

  // Meta reruns the same creative across terms; the unique index would reject
  // the batch, so collapse here where we can keep the better-dated copy.
  const byId = new Map();
  for (const ad of found) {
    const prev = byId.get(ad.meta_ad_id);
    if (!prev || (ad.days_running ?? -1) > (prev.days_running ?? -1)) byId.set(ad.meta_ad_id, ad);
  }

  const rows = [...byId.values()].map((a) => ({
    job_id: job.id,
    campaign_id: job.campaign_id,
    meta_ad_id: a.meta_ad_id,
    advertiser_name: a.advertiser ?? null,
    // The card carries the advertiser's NAME but not a link to their page.
    // Left null rather than guessed at from a search URL.
    advertiser_page_url: null,
    region: job.region,
    media_type: job.media_type,
    is_active: a.is_active ?? null,
    started_running: a.started_running,
    days_running: a.days_running,
    qualified: a.qualified,
    variant_count: a.variant_count,
    primary_text: a.primary_text ?? null,
    headline: a.headline ?? null,
    description: a.description ?? null,
    cta_label: a.cta_label ?? null,
    landing_url: a.landing_url ?? null,
    raw_payload: a,
  }));

  if (rows.length) {
    const { error } = await client.from('scanned_ads')
      .upsert(rows, { onConflict: 'campaign_id,meta_ad_id,region' });
    if (error) throw new Error(`could not save scanned ads: ${error.message}`);
  }

  return {
    items_found: rows.length,
    items_qualified: rows.filter((r) => r.qualified).length,
    notes: notes.length ? notes.join(' · ') : null,
    summary: `${rows.length} creatives, ${rows.filter((r) => r.qualified).length} qualifying`,
  };
}

// ── the loop ──────────────────────────────────────────────────────────
async function claimOne(client) {
  const { data, error } = await client.rpc('claim_job', { worker_id: WORKER_ID });
  if (error) throw new Error(`claim_job failed: ${error.message}`);
  return data?.[0] ?? null;
}

async function runJob(client, job) {
  const started = Date.now();
  console.log(`\n▶ ${job.kind} ${job.id.slice(0, 8)} (attempt ${job.attempts})`);
  const stop = beat(client, job.id);
  try {
    const result = job.kind === 'ingest'
      ? await runIngest(client, job)
      : await runAdScan(client, job);

    await client.from('scanner_jobs').update({
      status: 'completed',
      items_found: result.items_found,
      items_qualified: result.items_qualified,
      notes: result.notes,
      error_message: null,
      completed_at: new Date().toISOString(),
    }).eq('id', job.id);

    console.log(`✓ ${result.summary} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (e) {
    const message = e?.message ?? String(e);
    // 3 strikes is the reaper's rule too; keeping it in one place means a job
    // cannot be failed here and requeued there.
    const terminal = job.attempts >= 3;
    await client.from('scanner_jobs').update({
      status: terminal ? 'failed' : 'queued',
      error_message: message,
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: null,
      completed_at: terminal ? new Date().toISOString() : null,
    }).eq('id', job.id);
    console.error(`✗ ${message}${terminal ? ' (giving up)' : ' (will retry)'}`);
  } finally {
    stop();
  }
}

async function main() {
  const client = db();
  console.log(`ad-assist worker "${WORKER_ID}" — ${ONCE ? 'single job' : `polling, up to ${CONCURRENCY} at once`}`);
  console.log('Chrome runs headful, so leave the Mac awake while jobs are queued.');
  if (!ONCE) {
    console.log(TICK_URL
      ? `Driving campaigns at ${TICK_URL} every ${Math.round(TICK_EVERY_MS / 1000)}s — `
        + 'they keep running with no browser open.'
      : 'Not driving campaigns: TICK_URL is unset.');
  }
  console.log('');

  let idle = 0;
  // Jobs in flight right now. Each is its own Chrome tab and its own
  // heartbeat, so they neither block nor steal from one another.
  const active = new Set();

  for (;;) {
    // Free anything a dead worker left holding before looking for new work.
    // PostgrestBuilder is thenable but not a Promise — it has no .catch(), so
    // this has to be awaited and checked rather than chained.
    const { data: reaped, error: reapError } = await client
      .rpc('reap_stale_jobs', { max_silence: '5 minutes' });
    if (reapError) console.warn(`  reap failed: ${reapError.message}`);
    else if (reaped) console.log(`  requeued ${reaped} stale job(s)`);

    // Deliberately not awaited, and deliberately before the claim: this is the
    // thing that queues the ad-library searches in the first place, so poking
    // it first is what turns a fresh campaign into work for the loop below.
    if (!ONCE) pokeTick();

    // Fill up to the cap. claim_job hands back one row at a time and takes it
    // atomically, so calling it in a loop is safe with other workers running —
    // which is the normal case here, launchd's and a Terminal one.
    let claimed = 0;
    while (active.size < (ONCE ? 1 : CONCURRENCY)) {
      const job = await claimOne(client);
      if (!job) break;
      claimed += 1;
      // runJob never rejects — it records the failure on the row — so this
      // needs no catch, and must not have one that could swallow a real bug.
      const p = runJob(client, job).finally(() => active.delete(p));
      active.add(p);
      if (ONCE) break;
    }

    if (ONCE) {
      if (!active.size) console.log('Nothing queued.');
      await Promise.all(active);
      return;
    }

    if (claimed) { idle = 0; continue; }

    if (active.size) {
      // At capacity, or waiting out the last one. Wake the moment a slot frees
      // rather than sitting through a full poll interval with work queued.
      await Promise.race([...active, sleep(POLL_MS)]);
      continue;
    }

    if (idle % 12 === 0) process.stdout.write(`\rwaiting for work… ${new Date().toLocaleTimeString()}   `);
    idle += 1;
    await sleep(POLL_MS);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\nworker stopped: ${e.message}`);
  process.exit(1);
});

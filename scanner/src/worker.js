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
  console.log(`ad-assist worker "${WORKER_ID}" — ${ONCE ? 'single job' : 'polling'}`);
  console.log('Chrome runs headful, so leave the Mac awake while jobs are queued.\n');

  let idle = 0;
  for (;;) {
    // Free anything a dead worker left holding before looking for new work.
    // PostgrestBuilder is thenable but not a Promise — it has no .catch(), so
    // this has to be awaited and checked rather than chained.
    const { data: reaped, error: reapError } = await client
      .rpc('reap_stale_jobs', { max_silence: '5 minutes' });
    if (reapError) console.warn(`  reap failed: ${reapError.message}`);
    else if (reaped) console.log(`  requeued ${reaped} stale job(s)`);

    const job = await claimOne(client);
    if (job) {
      idle = 0;
      await runJob(client, job);
      if (ONCE) return;
      continue;
    }
    if (ONCE) {
      console.log('Nothing queued.');
      return;
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

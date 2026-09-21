// Shared job execution for local and serverless scanner hosts.
import { ingestProduct } from './ingest.js';
import { scanAdLibrary } from './adlibrary.js';

// ── ingest ────────────────────────────────────────────────────────────
export async function runIngest(client, job) {
  const payload = await ingestProduct(job.target_url);
  if (!payload.http_status || payload.http_status >= 400) {
    throw new Error('The store refused the browser request. Check the product address.');
  }

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
export async function runAdScan(client, job) {
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

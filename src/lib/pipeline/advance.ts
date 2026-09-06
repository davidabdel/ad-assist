import { serviceClient } from '@/lib/supabase';
import { ingestProductFromServer } from '@/lib/ingest/cloud';
import { buildProductBrief, buildProductBriefFromText } from './brief';
import { buildBasePage } from './base-page';
import { generatePersonaBatch, type ExistingPersona } from './personas';
import type { BasePage, ProductBrief } from './schemas';

/**
 * The pipeline driver. One call does ONE unit of work and returns.
 *
 * Why not run the whole thing in one request: the twenty pages take several
 * minutes of model time end to end, which is longer than a serverless function
 * is allowed to live. Splitting it into units that each finish in well under a
 * minute means the work survives a timeout, a deploy, or a closed laptop — the
 * next call picks up from whatever is already in the database. There is no
 * in-memory progress anywhere; `campaigns.status` plus what rows exist IS the
 * progress.
 *
 * Everything here is idempotent. Calling advance() twice on the same state
 * either does the same unit again harmlessly or reports "waiting".
 */

const PERSONA_TARGET = 20;
const PERSONA_BATCH = 5;
/** A batch can come back entirely duplicated. Retry, then stop rather than spin. */
const MAX_EMPTY_BATCHES = 3;

export type AdvanceResult = {
  status: string;
  /** What this call did, in words meant for the operator, not the log. */
  did: string;
  /** false while there is more work; true when the campaign has its 20 live pages. */
  done: boolean;
  /** true when we are waiting on the Mac-side worker rather than on ourselves. */
  waiting: boolean;
  /**
   * true when calling advance() again changes nothing — finished, or failed and
   * needing a human. Without this a poller sees `done: false` on a failed
   * campaign and retries forever.
   */
  terminal: boolean;
  /**
   * true when the stop is a deliberate checkpoint rather than an ending. The
   * screen shows an approval card instead of "finished" or "stopped".
   */
  awaitingApproval?: boolean;
  personas?: number;
  notes?: string[];
};

type CampaignRow = {
  id: string;
  user_id: string;
  slug: string;
  source_url: string | null;
  raw_input_text: string | null;
  checkout_url: string | null;
  current_offer: string | null;
  status: string;
  base_page_guidance: string | null;
  scraped_data: { raw?: Record<string, unknown>; brief?: ProductBrief } | null;
};

async function fail(id: string, message: string): Promise<AdvanceResult> {
  await serviceClient().from('campaigns')
    .update({ status: 'failed', error_message: message }).eq('id', id);
  return { status: 'failed', did: message, done: false, waiting: false, terminal: true };
}

export async function advance(campaign: CampaignRow): Promise<AdvanceResult> {
  const db = serviceClient();

  switch (campaign.status) {
    // ── read the product page ───────────────────────────────────────────
    case 'pending': {
      if (!campaign.source_url) {
        // Pasted text needs no page read at all.
        await db.from('campaigns').update({ status: 'scraping' }).eq('id', campaign.id);
        return {
          status: 'scraping', done: false, waiting: false, terminal: false,
          did: 'No URL to read — using the pasted product text instead.',
        };
      }

      // A Mac job may already be queued from an earlier call. Leave it alone
      // rather than racing it with a second read of the same page.
      const { data: existing } = await db.from('scanner_jobs')
        .select('id, status').eq('campaign_id', campaign.id).eq('kind', 'ingest')
        .in('status', ['queued', 'running', 'completed']).maybeSingle();

      if (existing) {
        await db.from('campaigns').update({ status: 'scraping' }).eq('id', campaign.id);
        return {
          status: 'scraping', done: false, waiting: true, terminal: false,
          did: 'This page is already with the Mac worker. Waiting on it.',
        };
      }

      // The normal path: read the page here, on the server. No browser, no Mac,
      // about a second. Only the stores that refuse a plain fetch fall through.
      let cloud;
      try {
        cloud = await ingestProductFromServer(campaign.source_url);
      } catch (e) {
        cloud = { payload: null, usable: false, reason: (e as Error).message };
      }

      if (cloud.usable && cloud.payload) {
        const { error } = await db.from('campaigns').update({
          // Merge: a re-run must not wipe a brief that already exists.
          scraped_data: { ...(campaign.scraped_data ?? {}), raw: cloud.payload },
          status: 'scraping',
        }).eq('id', campaign.id);
        if (error) return fail(campaign.id, `Could not save the page read: ${error.message}`);

        const s = cloud.payload.structured as { product_name?: string } | null;
        return {
          status: 'scraping', done: false, waiting: false, terminal: false,
          notes: cloud.payload.warnings,
          did: `Read the product page: ${s?.product_name ?? cloud.payload.page_title} — `
            + `${cloud.payload.reviews.length} customer reviews, `
            + `source ${cloud.payload.structured_source ?? 'page text only'}.`,
        };
      }

      // Falling back. The reason is written onto the job so the wizard can say
      // WHY the Mac is involved, rather than just that it is.
      const reason = cloud.reason ?? 'the server could not read the page';
      const { error } = await db.from('scanner_jobs').insert({
        campaign_id: campaign.id,
        kind: 'ingest',
        target_url: campaign.source_url,
        notes: `server read failed, handed to the Mac: ${reason}`,
      });
      if (error) return fail(campaign.id, `Could not queue the scrape: ${error.message}`);

      await db.from('campaigns').update({ status: 'scraping' }).eq('id', campaign.id);
      return {
        status: 'scraping', done: false, waiting: true, terminal: false,
        notes: [reason],
        did: 'This store will not be read by a plain request, so it has been handed to '
          + 'Chrome on the Mac. The Mac has to be awake for this one.',
      };
    }

    // ── wait for the scrape, then write the brief ───────────────────────
    case 'scraping': {
      if (!campaign.scraped_data?.raw && campaign.source_url) {
        const { data: job } = await db.from('scanner_jobs')
          .select('status, error_message, notes')
          .eq('campaign_id', campaign.id).eq('kind', 'ingest')
          .order('created_at', { ascending: false }).limit(1).maybeSingle();

        if (!job) return fail(campaign.id, 'The ingest job vanished before it ran.');
        if (job.status === 'queued' || job.status === 'running') {
          return {
            status: 'scraping', done: false, waiting: true, terminal: false,
            did: `Scrape is ${job.status}. Waiting on the Mac-side worker.`,
          };
        }
        if (job.status === 'failed') {
          if (!campaign.raw_input_text) {
            return fail(campaign.id,
              `The scrape failed and there is no pasted text to fall back on: ${job.error_message}`);
          }
          // A blocked storefront should cost a paragraph of typing, not the run.
        }
      }

      if (!campaign.scraped_data?.raw && !campaign.raw_input_text?.trim()) {
        return fail(campaign.id,
          'The scrape reported success but left no payload, and there is no pasted text. '
          + 'Nothing to build a brief from.');
      }

      let brief: ProductBrief;
      let notes: string[] = [];
      try {
        const raw = campaign.scraped_data?.raw;
        const result = raw
          ? await buildProductBrief(raw, {
            checkoutUrl: campaign.checkout_url, currentOffer: campaign.current_offer,
          })
          : await buildProductBriefFromText(campaign.raw_input_text ?? '', {
            checkoutUrl: campaign.checkout_url, currentOffer: campaign.current_offer,
          });
        brief = result.brief;
        notes = brief.gaps ?? [];
      } catch (e) {
        return fail(campaign.id, `Could not build the product brief: ${(e as Error).message}`);
      }

      await db.from('campaigns').update({
        scraped_data: { ...(campaign.scraped_data ?? {}), brief },
        status: 'base_review',
        error_message: null,
      }).eq('id', campaign.id);

      return {
        status: 'base_review', done: false, waiting: false, terminal: false, notes,
        did: `Product brief written: ${brief.product_name} — `
          + `${brief.features.length} features, ${brief.review_snippets.length} real review quotes.`,
      };
    }

    // ── write the base page, then STOP for approval ─────────────────────
    // Reasons 4-10 of this page are copied unchanged onto all twenty persona
    // pages, so a wrong base page is twenty wrong pages. It is the one artefact
    // in the run worth a human's thirty seconds, and the only place a mistake is
    // cheap to fix.
    case 'base_review': {
      const brief = campaign.scraped_data?.brief;
      if (!brief) return fail(campaign.id, 'Reached the base page stage with no product brief.');

      const { data: existingBase } = await db.from('base_pages')
        .select('hero_headline').eq('campaign_id', campaign.id).maybeSingle();

      if (existingBase) {
        return {
          status: 'base_review', done: false, waiting: false, terminal: true,
          awaitingApproval: true,
          did: 'The main page is written and waiting for you to read it. '
            + 'Nothing else runs until you approve it.',
        };
      }

      let page: BasePage;
      try {
        ({ page } = await buildBasePage(brief, campaign.base_page_guidance));
      } catch (e) {
        return fail(campaign.id, `Could not write the base page: ${(e as Error).message}`);
      }
      const { error } = await db.from('base_pages').insert({
        campaign_id: campaign.id,
        page_title: page.page_title,
        meta_description: page.meta_description,
        hero_headline: page.hero_headline,
        hero_subheadline: page.hero_subheadline,
        reasons: page.reasons,
        testimonials: page.testimonials,
        offer_headline: page.offer_headline,
        offer_body: page.offer_body,
        cta_button_text: page.cta_button_text,
        // The CTA is the operator's checkout. Falling back to the product page
        // is better than a dead button, and is stated rather than silent.
        cta_url: campaign.checkout_url || campaign.source_url || '#',
      });
      if (error) return fail(campaign.id, `Could not save the base page: ${error.message}`);

      const notes: string[] = [];
      if (!campaign.checkout_url) {
        notes.push('No checkout URL set, so the CTA points at the product page. '
          + 'Set one before running ads.');
      }
      // Said here rather than left for him to notice: an empty testimonials array
      // means every one of the twenty pages ships with no proof section, and the
      // usual cause is a brief built from a home page instead of a product page.
      if (!page.testimonials.length) {
        notes.push('No real customer reviews were found, so this page has no testimonials '
          + 'and neither will the twenty. If the product page has reviews on it, point the '
          + 'campaign at that page rather than the home page and run it again.');
      }

      return {
        status: 'base_review', done: false, waiting: false, terminal: true,
        awaitingApproval: true,
        did: `Main page written: "${page.hero_headline}" — 10 reasons, `
          + `${page.testimonials.length} real testimonials. Read it and approve it.`,
        notes,
      };
    }

    // ── personas, five at a time ────────────────────────────────────────
    case 'personas': {
      const brief = campaign.scraped_data?.brief;
      if (!brief) return fail(campaign.id, 'Reached the persona stage with no product brief.');

      const { data: basePage } = await db.from('base_pages')
        .select('*').eq('campaign_id', campaign.id).maybeSingle();

      // Only reachable by approving a base page, so a missing one is a real
      // inconsistency rather than "not written yet". Send it back to be written.
      if (!basePage) {
        await db.from('campaigns').update({ status: 'base_review' }).eq('id', campaign.id);
        return {
          status: 'base_review', done: false, waiting: false, terminal: false,
          did: 'The approved main page is missing. Writing it again.',
        };
      }

      // One driver per campaign. Two tabs, or a phone and a laptop, are two
      // drivers: without this they both read the same count, both write the same
      // persona_index, and the loser dies on the unique constraint after paying
      // for a full batch. Claimed BEFORE the model call so the loser pays
      // nothing. See 0007_persona_batch_lock.sql.
      const { data: claimed, error: claimError } = await db
        .rpc('claim_persona_batch', { p_campaign: campaign.id });
      if (claimError) return fail(campaign.id, `Could not claim the batch: ${claimError.message}`);
      if (!claimed) {
        return {
          status: 'personas', done: false, waiting: true, terminal: false,
          did: 'Another window is already writing this batch. Waiting for it rather than '
            + 'writing the same pages twice.',
        };
      }

      try {
        // Read under the claim, not before it: a count taken outside the lock is
        // the stale read this whole mechanism exists to prevent.
        const { data: existingRows } = await db.from('personas')
          .select('persona_index, persona_name, primary_pain_point, slug')
          .eq('campaign_id', campaign.id).order('persona_index');
        const existing: ExistingPersona[] = existingRows ?? [];

        if (existing.length >= PERSONA_TARGET) {
          await db.from('campaigns').update({ status: 'pages_built' }).eq('id', campaign.id);
          return {
            status: 'pages_built', done: true, waiting: false, terminal: true,
            personas: existing.length,
            did: `All ${existing.length} persona pages are live.`,
          };
        }

        const want = Math.min(PERSONA_BATCH, PERSONA_TARGET - existing.length);
        const rejectedNotes: string[] = [];
        let added = 0;

        for (let attempt = 1; attempt <= MAX_EMPTY_BATCHES && added === 0; attempt += 1) {
          let batch;
          try {
            // Rebuild the shape rather than pass the row: ids and timestamps in the
            // prompt are tokens spent on nothing, and invite the model to echo them.
            const forPrompt: BasePage = {
              page_title: basePage.page_title,
              meta_description: basePage.meta_description ?? '',
              hero_headline: basePage.hero_headline,
              hero_subheadline: basePage.hero_subheadline ?? '',
              reasons: basePage.reasons,
              testimonials: basePage.testimonials,
              offer_headline: basePage.offer_headline,
              offer_body: basePage.offer_body ?? '',
              cta_button_text: basePage.cta_button_text,
            };
            batch = await generatePersonaBatch(brief, forPrompt, existing, want);
          } catch (e) {
            return fail(campaign.id, `Persona batch failed: ${(e as Error).message}`);
          }
          for (const r of batch.rejected) {
            rejectedNotes.push(`dropped "${r.persona_name}": ${r.reason}`);
          }
          if (!batch.personas.length) continue;

          const nextIndex = (existingRows?.at(-1)?.persona_index ?? 0) + 1;
          const rows = batch.personas.slice(0, want).map((p, i) => ({
            campaign_id: campaign.id,
            persona_index: nextIndex + i,
            slug: p.slug,
            persona_name: p.persona_name,
            primary_pain_point: p.primary_pain_point,
            core_desire: p.core_desire,
            angle_hook: p.angle_hook,
            custom_topbar_notice: p.custom_topbar_notice || null,
            custom_hero_headline: p.custom_hero_headline,
            custom_reasons: p.custom_reasons,
            // An empty quote means no real review fitted. Store null, not an empty
            // testimonial — the page renders nothing rather than an empty card.
            proof_quote: p.proof_quote.quote.trim() ? p.proof_quote : null,
          }));
          const { error } = await db.from('personas').insert(rows);
          if (error) return fail(campaign.id, `Could not save personas: ${error.message}`);
          added = rows.length;
        }

        if (added === 0) {
          return fail(campaign.id,
            `Ran ${MAX_EMPTY_BATCHES} persona batches and every persona duplicated an existing `
            + `pain point. Stopped at ${existing.length} of ${PERSONA_TARGET} rather than shipping `
            + 'near-identical pages. The product may not support 20 genuinely different buyers.');
        }

        const total = existing.length + added;
        if (total >= PERSONA_TARGET) {
          await db.from('campaigns').update({ status: 'pages_built' }).eq('id', campaign.id);
        }
        return {
          status: total >= PERSONA_TARGET ? 'pages_built' : 'personas',
          done: total >= PERSONA_TARGET,
          waiting: false,
          terminal: total >= PERSONA_TARGET,
          personas: total,
          did: `Wrote ${added} persona${added === 1 ? '' : 's'} (${total}/${PERSONA_TARGET}).`,
          notes: rejectedNotes,
        };
      } finally {
        // Every path above returns, including the fail() ones. Releasing here
        // rather than at each return is what keeps the next call from waiting out
        // the five-minute expiry after an ordinary failure.
        await db.rpc('release_persona_batch', { p_campaign: campaign.id });
      }
    }

    case 'pages_built':
      return {
        status: 'pages_built', done: true, waiting: false, terminal: true,
        did: 'Pages are built. The ad-library scan is the next stage and is not wired up yet.',
      };

    case 'failed':
      return {
        status: 'failed', done: false, waiting: false, terminal: true,
        did: 'This campaign failed. Clear error_message and reset status to retry.',
      };

    default:
      return {
        status: campaign.status, done: false, waiting: false, terminal: true,
        did: `Nothing to do at status "${campaign.status}" — that stage is not built yet.`,
      };
  }
}

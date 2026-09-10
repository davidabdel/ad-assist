import { serviceClient } from '@/lib/supabase';
import { ingestProductFromServer } from '@/lib/ingest/cloud';
import { ingestPdfFromUrl } from '@/lib/ingest/pdf';
import { spec, type ProductType } from '@/lib/product-type';
import { buildProductBrief, buildProductBriefFromText } from './brief';
import { buildBasePage } from './base-page';
import { readBrand } from './brand';
import type { BrandKit } from '@/lib/brand';
import {
  applyImages, libraryForPrompt, planImages, resolveImages,
} from './images';
import { generatePersonaBatch, type ExistingPersona } from './personas';
import { extractFormats } from './formats';
import {
  generateIdeasForPersona, planIdeas,
  type FormatForPrompt, type ImageForPrompt, type PersonaForPrompt,
} from './ideas';
import { estimatedScanMinutes, MEDIA_TYPES, planScanJobs } from './search-terms';
import type { BasePage, ProductBrief } from './schemas';
import type { Reason } from '@/lib/page-data';
import { noteForStep } from './guidance';

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

/**
 * How many pages a campaign gets is a property of what is being sold and is
 * frozen onto the row at creation (see `lib/product-type.ts`): twenty for
 * anything with unlimited supply, five for one specific vehicle. Read from the
 * campaign rather than from the table so a campaign halfway through writing its
 * pages cannot change target under itself.
 */
function personaTarget(campaign: CampaignRow): number {
  return campaign.persona_target ?? 20;
}
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
  product_type: ProductType;
  persona_target: number;
  source_url: string | null;
  raw_input_text: string | null;
  /** The ebook itself, in storage. Read instead of a page. */
  source_file_url: string | null;
  /** The operator's own photographs. On a vehicle these are the only ones. */
  uploaded_image_urls: string[] | null;
  checkout_url: string | null;
  contact_phone: string | null;
  contact_name: string | null;
  current_offer: string | null;
  /** 'AU' | 'US' | 'GB' | 'ALL'. Decides how many ad-library scans get queued. */
  region: string;
  /** Media types the extraction has run for, empty results included. */
  formats_extracted: string[] | null;
  /** How many of a buyer's three ideas are statics and how many are video. */
  media_split: { static?: number; video?: number } | null;
  status: string;
  base_page_guidance: string | null;
  /**
   * What the operator said was wrong with a step, keyed by the step key the
   * progress screen uses. Folded into that stage's prompt on every run of it
   * from now on, not only the next one. See lib/pipeline/redo.ts.
   */
  step_guidance: Record<string, string> | null;
  scraped_data: { raw?: Record<string, unknown>; brief?: ProductBrief } | null;
  brand: BrandKit | null;
};

/**
 * Where the page's button sends people.
 *
 * A vehicle has no cart. There is one of it, and the buyer rings — so the
 * button is a tel: link and the enquiry form underneath it is the other half.
 * `tel:` is stripped of everything a dialler cannot use, because a number typed
 * as "0412 345 678 (after 6pm)" makes a link that fails silently on a phone,
 * which is the one device that matters here.
 */
function ctaUrlFor(campaign: CampaignRow): string {
  if (spec(campaign.product_type).ctaKind === 'contact') {
    const dialable = (campaign.contact_phone ?? '').replace(/[^\d+]/g, '');
    return dialable ? `tel:${dialable}` : '#enquire';
  }
  return campaign.checkout_url || campaign.source_url || '#';
}

async function fail(id: string, message: string): Promise<AdvanceResult> {
  await serviceClient().from('campaigns')
    .update({ status: 'failed', error_message: message }).eq('id', id);
  return { status: 'failed', did: message, done: false, waiting: false, terminal: true };
}

/**
 * One unit of work, under a per-campaign driver lock.
 *
 * The lock used to be taken inside the two stages that write rows with a unique
 * index on them, because a second driver was an accident — two tabs open on one
 * campaign. It is no longer an accident. A campaign is now driven by the screen
 * AND by the server tick (see `app/api/tick`), on purpose, so that closing the
 * tab does not stop the run — which makes two drivers the normal case rather
 * than the odd one, and leaves every OTHER stage exposed: two drivers at
 * `scraping` is two paid-for briefs, and two at `base_review` is two base pages
 * where the rest of the code expects at most one.
 *
 * So the whole unit is inside it, and the stages hold nothing of their own.
 *
 * The lock is `claim_persona_batch` (0007), whose name is now narrower than its
 * job. Deliberately not renamed: a rename is a two-step deploy where in-flight
 * old code calls a function that no longer exists, and the cost of that is a
 * failed campaign rather than a confusing name.
 */
export async function advance(campaign: CampaignRow): Promise<AdvanceResult> {
  const db = serviceClient();

  const { data: claimed, error: claimError } = await db
    .rpc('claim_persona_batch', { p_campaign: campaign.id });
  if (claimError) return fail(campaign.id, `Could not claim the campaign: ${claimError.message}`);
  if (!claimed) {
    // `waiting` rather than an error: the other driver is doing the work, and
    // every caller already knows how to back off and ask again.
    return {
      status: campaign.status, done: false, waiting: true, terminal: false,
      did: 'Something else is already working on this campaign. Waiting for it rather than '
        + 'doing the same step twice.',
    };
  }

  try {
    // Read the row again, under the claim. The one this was called with was
    // fetched before the lock was held — by an auth check, or by a tick that
    // listed campaigns a minute ago — so its status can already be a stage out
    // of date, and acting on a stale status is how a stage runs twice.
    const { data: fresh } = await db.from('campaigns')
      .select('*').eq('id', campaign.id).maybeSingle();
    return await unit((fresh as CampaignRow | null) ?? campaign, db);
  } finally {
    // Every path inside returns, including the fail() ones. Releasing here
    // rather than at each return is what keeps the next call from waiting out
    // the five-minute expiry after an ordinary failure.
    await db.rpc('release_persona_batch', { p_campaign: campaign.id });
  }
}

async function unit(
  campaign: CampaignRow,
  db: ReturnType<typeof serviceClient>,
): Promise<AdvanceResult> {
  switch (campaign.status) {
    // ── read the product page ───────────────────────────────────────────
    case 'pending': {
      // An ebook's source is the file, not a page. Read here on the server:
      // it is one download and one text extraction, no browser, no Mac.
      if (campaign.source_file_url && !campaign.scraped_data?.raw) {
        const pdf = await ingestPdfFromUrl(campaign.source_file_url);
        if (!pdf.usable || !pdf.payload) {
          // No silent fallback to the Mac: Chrome cannot read a PDF's text
          // either, so handing it over would only move the same failure
          // somewhere the operator cannot see it.
          return fail(campaign.id, `The ebook could not be read — ${pdf.reason}`);
        }
        const { error } = await db.from('campaigns').update({
          scraped_data: { ...(campaign.scraped_data ?? {}), raw: pdf.payload },
          status: 'scraping',
        }).eq('id', campaign.id);
        if (error) return fail(campaign.id, `Could not save the ebook read: ${error.message}`);

        return {
          status: 'scraping', done: false, waiting: false, terminal: false,
          notes: pdf.payload.warnings as string[],
          did: `Read the ebook: ${pdf.payload.page_count} pages, `
            + `${(pdf.payload.markdown as string).length.toLocaleString()} characters of text.`,
        };
      }

      if (!campaign.source_url) {
        // Pasted text needs no page read at all, and an already-read file needs
        // no second one.
        await db.from('campaigns').update({ status: 'scraping' }).eq('id', campaign.id);
        return {
          status: 'scraping', done: false, waiting: false, terminal: false,
          did: campaign.scraped_data?.raw
            ? 'The file has already been read. Moving on to the brief.'
            : 'No URL to read — using the pasted description instead.',
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
        const extra = {
          productType: campaign.product_type,
          checkoutUrl: campaign.checkout_url,
          currentOffer: campaign.current_offer,
          guidance: noteForStep(campaign, 'brief'),
        };
        const result = raw
          ? await buildProductBrief(raw, extra)
          : await buildProductBriefFromText(campaign.raw_input_text ?? '', extra);
        brief = result.brief;
        notes = brief.gaps ?? [];
      } catch (e) {
        return fail(campaign.id, `Could not build the product brief: ${(e as Error).message}`);
      }

      // ── the brand, in the same unit as the brief ───────────────────
      // Before the base page is written, not after: the operator has to review
      // the words wearing the clothes the buyer will see them in. Approving a
      // grey page and discovering the paint afterwards is a second review.
      //
      // In this unit rather than its own status because it is one fetch and one
      // small call — a stage of its own would cost an enum value, a migration
      // and a round trip to save nothing. It cannot fail the campaign: readBrand
      // returns the neutral kit for every failure it has, and the pages render
      // exactly as they did before this existed.
      let brandNote: string | null = null;
      let brand = campaign.brand;
      // A pasted-text campaign has no site to read a brand off, and that is a
      // neutral page rather than a failure worth a note.
      if (!brand && campaign.source_url) {
        const { brand: kit, branded } = await readBrand(campaign.source_url);
        brand = kit;
        notes = [...notes, ...kit.notes];
        brandNote = branded
          ? `Brand read from ${new URL(kit.source_url).hostname}: `
            + `${kit.primary}${kit.accent !== kit.primary ? ` and ${kit.accent}` : ''}`
            + `${kit.google_fonts.length ? `, ${kit.google_fonts.join(' and ')}` : ''}`
            + `${kit.logo_url ? ', logo placed' : ', no logo found'}`
            + `${kit.confidence === 'low' ? ' — LOW CONFIDENCE, check it against your site' : ''}.`
          : 'No brand could be read from the source, so the pages stay neutral.';
      }

      await db.from('campaigns').update({
        scraped_data: { ...(campaign.scraped_data ?? {}), brief },
        brand,
        status: 'base_review',
        error_message: null,
      }).eq('id', campaign.id);

      return {
        status: 'base_review', done: false, waiting: false, terminal: false, notes,
        did: `Product brief written: ${brief.product_name} — `
          + `${brief.features.length} features, ${brief.review_snippets.length} real review quotes.`
          + `${brandNote ? ` ${brandNote}` : ''}`,
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
        ({ page } = await buildBasePage(brief, campaign.product_type, campaign.base_page_guidance));
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
        // A checkout link, or a tel: for the kinds of sale that close on a call.
        // Falling back to the product page is better than a dead button, and is
        // stated rather than silent.
        cta_url: ctaUrlFor(campaign),
      });
      if (error) return fail(campaign.id, `Could not save the base page: ${error.message}`);

      const notes: string[] = [];
      if (spec(campaign.product_type).ctaKind === 'checkout' && !campaign.checkout_url) {
        notes.push('No checkout URL set, so the CTA points at the product page. '
          + 'Set one before running ads.');
      }
      // Said here rather than left for him to notice: an empty testimonials array
      // means every one of the twenty pages ships with no proof section, and the
      // usual cause is a brief built from a home page instead of a product page.
      //
      // For an ebook or a vehicle it is the expected answer rather than a
      // symptom, so it is said differently: nobody publishes customer reviews
      // inside their own book, and one second-hand ute has never been reviewed.
      // Telling him to re-point the campaign there would be advice that cannot
      // work.
      if (!page.testimonials.length) {
        const target = personaTarget(campaign);
        notes.push(campaign.product_type === 'ecom'
          ? 'No real customer reviews were found, so this page has no testimonials and '
            + `neither will the ${target}. If the product page has reviews on it, point the `
            + 'campaign at that page rather than the home page and run it again.'
          : 'No customer reviews, which is normal for this kind of sale — the pages carry '
            + 'no testimonials rather than invented ones. Real quotes from past buyers are '
            + 'the one thing that would lift these pages, if you have any.');
      }

      return {
        status: 'base_review', done: false, waiting: false, terminal: true,
        awaitingApproval: true,
        did: `Main page written: "${page.hero_headline}" — 10 reasons, `
          + `${page.testimonials.length} real testimonials. Read it and approve it.`,
        notes,
      };
    }

    // ── pictures, once the words are approved ───────────────────────────
    // Deliberately after the gate. The base page is reviewed as slots — every
    // reason shows where its picture goes and what the copy expects to see in
    // it — so nothing is illustrated until the words it illustrates are agreed.
    case 'images': {
      const brief = campaign.scraped_data?.brief;
      if (!brief) return fail(campaign.id, 'Reached the image stage with no product brief.');

      const { data: basePage } = await db.from('base_pages')
        .select('id, reasons, hero_image_url').eq('campaign_id', campaign.id).maybeSingle();
      if (!basePage) {
        await db.from('campaigns').update({ status: 'base_review' }).eq('id', campaign.id);
        return {
          status: 'base_review', done: false, waiting: false, terminal: false,
          did: 'The approved main page is missing. Writing it again.',
        };
      }

      // The operator's own uploads come FIRST and are never subject to the
      // model having noticed them: a vehicle has no storefront gallery and an
      // ebook has no images at all, so on those two kinds this list is the
      // whole library. Deduped because a listing page that scrapes cleanly can
      // legitimately return a photo the operator also uploaded.
      const urls = [...new Set([
        ...(campaign.uploaded_image_urls ?? []),
        ...(brief.image_urls ?? []),
      ])];
      if (!urls.length) {
        await db.from('campaigns').update({ status: 'personas' }).eq('id', campaign.id);
        return {
          status: 'personas', done: false, waiting: false, terminal: false,
          did: 'No photographs were found, so the pages ship without them.',
          notes: [campaign.product_type === 'ecom'
            ? 'Nothing here generates a picture. If the pages should have images, point the '
              + 'campaign at a page that has product photos on it.'
            : 'Nothing here generates a picture. Upload your own photographs on a new '
              + 'campaign — for this kind of thing they are the only possible source.'],
        };
      }

      // Idempotent: a library that already exists means this unit ran. Re-running
      // it would pay for a second look at the same photographs and could move a
      // picture the operator has already seen.
      const { count } = await db.from('campaign_images')
        .select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id);
      if (count && count > 0) {
        await db.from('campaigns').update({ status: 'personas' }).eq('id', campaign.id);
        return {
          status: 'personas', done: false, waiting: false, terminal: false,
          did: 'Pictures were already chosen for this campaign. Moving on to the pages.',
        };
      }

      const reasons = basePage.reasons as Reason[];
      let resolved;
      try {
        const { plan, unreadable } = await planImages(
          brief, reasons, urls, noteForStep(campaign, 'images'),
        );
        resolved = resolveImages(plan, urls, unreadable);
      } catch (e) {
        return fail(campaign.id, `Could not choose the pictures: ${(e as Error).message}`);
      }

      const { error: libError } = await db.from('campaign_images').insert(
        resolved.library.map((i) => ({ ...i, campaign_id: campaign.id })),
      );
      if (libError) return fail(campaign.id, `Could not save the image library: ${libError.message}`);

      const { error: pageError } = await db.from('base_pages').update({
        reasons: applyImages(reasons, resolved.bySlot),
        hero_image_url: resolved.hero?.url ?? null,
        hero_image_alt: resolved.hero?.alt ?? null,
      }).eq('id', basePage.id);
      if (pageError) return fail(campaign.id, `Could not save the pictures: ${pageError.message}`);

      await db.from('campaigns').update({ status: 'personas', error_message: null })
        .eq('id', campaign.id);

      const filled = resolved.bySlot.size + (resolved.hero ? 1 : 0);
      const usable = resolved.library.filter((i) => i.usable).length;
      const notes = [...resolved.notes];
      // An empty slot is a decision, not a miss, and saying so is what stops it
      // being read as a bug the way the first run's blank pages were.
      const empty = reasons.length - resolved.bySlot.size;
      if (empty > 0) {
        notes.push(`${empty} of ${reasons.length} reasons have no picture: none of your photos `
          + 'genuinely show what they claim. They render as text on the live pages rather than '
          + 'as an unrelated photo.');
      }

      return {
        status: 'personas', done: false, waiting: false, terminal: false, notes,
        did: `Looked at ${resolved.library.length} photos, `
          + `${usable} usable as editorial, and placed ${filled} on the main page.`,
      };
    }

    // ── personas, five at a time ────────────────────────────────────────
    case 'personas': {
      const brief = campaign.scraped_data?.brief;
      if (!brief) return fail(campaign.id, 'Reached the persona stage with no product brief.');
      const target = personaTarget(campaign);

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

      // The driver lock advance() holds for the whole unit is what makes the
      // count below safe to read. Two drivers on one campaign — a tab and the
      // server tick, or a phone and a laptop — would otherwise both read
      // "15 personas exist", both write index 16, and the loser would die on
      // the unique constraint after paying for a full batch.
      // Read under the claim, not before it: a count taken outside the lock is
      // the stale read this whole mechanism exists to prevent.
      // Live pages only. A superseded page is one a redo replaced but could
      // not delete because a finished ad points at its URL — it is history,
      // not part of this campaign's twenty, and counting it here would make
      // the run believe it had already written pages it is about to write.
      const { data: existingRows } = await db.from('personas')
        .select('persona_index, persona_name, primary_pain_point, slug')
        .eq('campaign_id', campaign.id).is('superseded_at', null)
        .order('persona_index');
      const existing: ExistingPersona[] = existingRows ?? [];

      // Slugs are the exception, and they are read across ALL pages including
      // superseded ones. A slug is the page's public address; two rows
      // sharing one would make /p/<campaign>/<slug> ambiguous, and the row
      // that lost is the one a live ad is pointing at.
      const { data: allSlugRows } = await db.from('personas')
        .select('slug').eq('campaign_id', campaign.id);
      const takenSlugs = new Set((allSlugRows ?? []).map((r) => r.slug as string));

      // The persona call is text-only and batched, so it can never see a
      // photograph. Captions written by the image stage are the whole of what
      // it has to choose from, which is why they are written for that purpose
      // rather than as alt text.
      const { data: libraryRows } = await db.from('campaign_images')
        .select('position, source_url, caption, usable')
        .eq('campaign_id', campaign.id).order('position');

      // A persona page is its own three reasons followed by the base page's
      // reasons 4-10, so anything already showing in that locked tail — or in
      // the base hero, when the persona inherits it — would appear twice on
      // the finished page. Withhold those rather than ask the model not to
      // pick them. Reasons 1-3 are replaced wholesale, so whatever illustrated
      // them on the base page is free again.
      const spokenFor = new Set<string>([
        ...(basePage.hero_image_url ? [basePage.hero_image_url as string] : []),
        ...((basePage.reasons as Reason[]) ?? [])
          .filter((r) => r.number > 3 && r.image_url)
          .map((r) => r.image_url as string),
      ]);
      const library = (libraryRows ?? [])
        .filter((l) => !spokenFor.has(l.source_url));

      if (existing.length >= target) {
        await db.from('campaigns').update({ status: 'pages_built' }).eq('id', campaign.id);
        return {
          // NOT terminal. The pages being live is the milestone the operator
          // came for, but it is not the end of the run — the ad scan comes
          // next and `pages_built` is the state that queues it. This used to
          // return terminal, which stopped the driving loop one call BEFORE
          // the scan was ever handed to the Mac. The campaign then sat at
          // `pages_built` indefinitely while the screen said it was reading
          // the ad library, and only a page reload restarted it.
          status: 'pages_built', done: true, waiting: false, terminal: false,
          personas: existing.length,
          did: `All ${existing.length} persona pages are live.`,
        };
      }

      const want = Math.min(PERSONA_BATCH, target - existing.length);
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
          batch = await generatePersonaBatch(
            brief, forPrompt, existing, want, libraryForPrompt(library),
            campaign.product_type, target, noteForStep(campaign, 'pages'),
          );
        } catch (e) {
          return fail(campaign.id, `Persona batch failed: ${(e as Error).message}`);
        }
        for (const r of batch.rejected) {
          rejectedNotes.push(`dropped "${r.persona_name}": ${r.reason}`);
        }
        if (!batch.personas.length) continue;

        const nextIndex = (existingRows?.at(-1)?.persona_index ?? 0) + 1;
        const rows = batch.personas.slice(0, want).map((p, i) => {
          // A picked index is only ever a number in the model's answer. Turn
          // it into a URL here, against the row we actually stored, and refuse
          // an index that is out of range, was marked unusable, or is already
          // on this buyer's page. The used-set is per persona: two personas
          // sharing a photo is fine and expected, the same photo twice on one
          // page is the thing that reads as broken.
          const used = new Set<number>();
          const pick = (index: number) => {
            if (index < 0 || used.has(index)) return null;
            const image = library.find((l) => l.position === index);
            if (!image?.usable) return null;
            used.add(index);
            return image;
          };
          const hero = pick(p.hero_image_index);
          // Suffix rather than reject: the model cannot see superseded pages
          // and has no way to avoid their slugs, so a collision is its fault
          // in name only. `-2`, then `-3`, so the address stays readable.
          let slug = p.slug;
          for (let n = 2; takenSlugs.has(slug); n += 1) slug = `${p.slug}-${n}`;
          takenSlugs.add(slug);

          return {
            campaign_id: campaign.id,
            persona_index: nextIndex + i,
            slug,
            persona_name: p.persona_name,
            primary_pain_point: p.primary_pain_point,
            core_desire: p.core_desire,
            angle_hook: p.angle_hook,
            custom_topbar_notice: p.custom_topbar_notice || null,
            custom_hero_headline: p.custom_hero_headline,
            // Null inherits the main page's hero, which is the common case.
            custom_hero_image_url: hero?.source_url ?? null,
            custom_hero_image_alt: hero?.caption ?? null,
            custom_reasons: p.custom_reasons.map((r) => {
              const image = pick(r.image_index);
              return {
                number: r.number,
                title: r.title,
                body: r.body,
                image_prompt: r.image_prompt,
                image_url: image?.source_url ?? null,
                image_alt: image?.caption ?? null,
              };
            }),
            // An empty quote means no real review fitted. Store null, not an empty
            // testimonial — the page renders nothing rather than an empty card.
            proof_quote: p.proof_quote.quote.trim() ? p.proof_quote : null,
          };
        });
        const { error } = await db.from('personas').insert(rows);
        if (error) return fail(campaign.id, `Could not save personas: ${error.message}`);
        added = rows.length;
      }

      if (added === 0) {
        return fail(campaign.id,
          `Ran ${MAX_EMPTY_BATCHES} persona batches and every persona duplicated an existing `
          + `pain point. Stopped at ${existing.length} of ${target} rather than shipping `
          + 'near-identical pages. The product may not support 20 genuinely different buyers.');
      }

      const total = existing.length + added;
      if (total >= target) {
        await db.from('campaigns').update({ status: 'pages_built' }).eq('id', campaign.id);
      }
      return {
        status: total >= target ? 'pages_built' : 'personas',
        done: total >= target,
        waiting: false,
        // Same reason as above: the last batch landing is not an ending, it
        // is the handover to the scan.
        terminal: false,
        personas: total,
        did: `Wrote ${added} persona${added === 1 ? '' : 's'} (${total}/${target}).`,
        notes: rejectedNotes,
      };
    }

    // ── queue the ad-library scan ───────────────────────────────────────
    //
    // No approval gate here, unlike the base page. The scan spends nothing,
    // publishes nothing and changes nothing that is already live — it reads a
    // public library and writes rows only this dashboard sees. The checkpoint
    // that matters comes later, at the ideas table, where approving a row is
    // what starts costing money.
    case 'pages_built': {
      const { data: existing } = await db.from('scanner_jobs')
        .select('id').eq('campaign_id', campaign.id).eq('kind', 'ad_scan')
        .in('status', ['queued', 'running', 'completed']);

      if (existing?.length) {
        // Already queued by an earlier call. Move the status without inserting
        // a second set — six duplicate scans would be an hour of the Mac's time
        // for rows the unique index would reject anyway.
        await db.from('campaigns').update({ status: 'scanning' }).eq('id', campaign.id);
        return {
          status: 'scanning', done: false, waiting: true, terminal: false,
          did: `The ad-library scan is already queued (${existing.length} searches). Waiting on the Mac.`,
        };
      }

      const plan = planScanJobs({ campaignId: campaign.id, region: campaign.region });
      const { error } = await db.from('scanner_jobs').insert(plan.map((job) => ({
        campaign_id: campaign.id,
        kind: 'ad_scan',
        region: job.region,
        media_type: job.mediaType,
        search_terms: job.searchTerms,
      })));
      if (error) return fail(campaign.id, `Could not queue the ad scan: ${error.message}`);

      await db.from('campaigns').update({ status: 'scanning', error_message: null })
        .eq('id', campaign.id);

      const regions = [...new Set(plan.map((j) => j.region))].join(', ');
      return {
        status: 'scanning', done: false, waiting: true, terminal: false,
        did: `Queued ${plan.length} ad-library searches across ${regions}, statics and video. `
          + `About ${estimatedScanMinutes(plan.length)} minutes of Chrome on your Mac, and it `
          + 'costs nothing.',
        notes: [
          'The searches are ad-copy phrases, not your product category — the point is to '
          + 'see how winning ads are BUILT, and that travels between categories.',
          'Your Mac has to be awake and the worker running for this stage.',
        ],
      };
    }

    // ── wait for the scan ───────────────────────────────────────────────
    case 'scanning': {
      const { data: jobs } = await db.from('scanner_jobs')
        .select('id, status, region, media_type, items_found, items_qualified, notes, error_message, attempts')
        .eq('campaign_id', campaign.id).eq('kind', 'ad_scan');

      if (!jobs?.length) {
        // Nothing to wait for. Rewind rather than sit here: pages_built queues
        // the set, and it is idempotent.
        await db.from('campaigns').update({ status: 'pages_built' }).eq('id', campaign.id);
        return {
          status: 'pages_built', done: false, waiting: false, terminal: false,
          did: 'No scan jobs exist for this campaign. Queueing them.',
        };
      }

      const pending = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
      const failed = jobs.filter((j) => j.status === 'failed');
      const completed = jobs.filter((j) => j.status === 'completed');

      if (pending.length) {
        const found = completed.reduce((n, j) => n + (j.items_found ?? 0), 0);
        return {
          status: 'scanning', done: false, waiting: true, terminal: false,
          did: `${completed.length} of ${jobs.length} searches done`
            + (found ? `, ${found} ads so far` : '')
            + '. Waiting on Chrome on your Mac.',
          notes: failed.length
            ? [`${failed.length} search(es) failed and will not be retried: `
              + failed.map((j) => j.error_message).filter(Boolean).join(' · ')]
            : undefined,
        };
      }

      // Every job has finished one way or the other. A partial scan still
      // extracts — three regions' worth of ads is not required to see a shape,
      // and stopping the campaign because one search hit a consent wall would
      // throw away work that is already done and already good enough.
      if (!completed.length) {
        return fail(campaign.id, 'Every ad-library search failed. '
          + (failed[0]?.error_message ?? 'No reason was recorded.')
          + ' The most common cause is that Chrome on the Mac has no signed-in '
          + 'Facebook session yet.');
      }

      const qualified = completed.reduce((n, j) => n + (j.items_qualified ?? 0), 0);
      if (!qualified) {
        return fail(campaign.id, 'The scan finished but not one ad qualified — nothing found '
          + 'was both still running and between 90 days and a year old. Nothing was '
          + 'extracted rather than '
          + 'lowering the bar to fill the table.');
      }

      await db.from('campaigns').update({ status: 'extracting' }).eq('id', campaign.id);
      const found = completed.reduce((n, j) => n + (j.items_found ?? 0), 0);
      const scanNotes = completed.flatMap((j) => (j.notes ? [j.notes] : []));
      return {
        status: 'extracting', done: false, waiting: false, terminal: false,
        did: `Scan finished: ${found} ads read, ${qualified} live between 90 days and a year. `
          + 'Working out what shape they share.',
        notes: [
          ...(failed.length ? [`${failed.length} of ${jobs.length} searches failed; extracting `
            + 'from the rest.'] : []),
          ...scanNotes,
        ],
      };
    }

    // ── turn the ads into format specs ──────────────────────────────────
    //
    // One media type per call. Statics and video are separate crafts and get
    // separate prompts, and splitting them also keeps each unit well inside the
    // function's time limit.
    case 'extracting': {
      // What has been ATTEMPTED, not what produced rows. "No formats" is a real
      // answer — too few usable ads to see a pattern — and reading progress off
      // format_specs instead would make an empty result repeat forever.
      const attempted = new Set(campaign.formats_extracted ?? []);

      // Which types actually have ads to read. A campaign whose video searches
      // all failed must not sit here waiting for video formats that cannot come.
      const { data: scanned } = await db.from('scanned_ads')
        .select('media_type').eq('campaign_id', campaign.id).eq('qualified', true);
      const available = new Set((scanned ?? []).map((r) => r.media_type as string));

      const next = MEDIA_TYPES.find((m) => available.has(m) && !attempted.has(m));

      if (next) {
        let result;
        try {
          result = await extractFormats({ campaignId: campaign.id, mediaType: next });
        } catch (e) {
          return fail(campaign.id, `Could not work out the ${next} formats: ${(e as Error).message}`);
        }

        // Marked before anything else, so a crash on the line after this cannot
        // cause the same extraction to be paid for twice.
        const { error } = await db.from('campaigns')
          .update({ formats_extracted: [...attempted, next] }).eq('id', campaign.id);
        if (error) return fail(campaign.id, `Could not record the extraction: ${error.message}`);

        return {
          status: 'extracting', done: false, waiting: false, terminal: false,
          did: result.written
            ? `Found ${result.written} ${next} format${result.written === 1 ? '' : 's'} `
              + `across ${result.adsSampled} winning ads.`
            : `No ${next} formats — not enough usable ads to show a pattern.`,
          notes: result.notes,
        };
      }

      const { count } = await db.from('format_specs')
        .select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id);

      // No formats at all is the one result that cannot go forward. Every idea
      // is built on an observed shape; with none observed, this stage would be
      // a copywriter with no brief pretending to have one.
      if (!count) {
        return fail(campaign.id, 'The scan produced no formats at all, so there is nothing for '
          + 'the ad ideas to be built on. Run the scan again — a wider region, or all three — '
          + 'rather than writing ideas from nothing.');
      }

      await db.from('campaigns').update({ status: 'writing_ideas' }).eq('id', campaign.id);
      return {
        status: 'writing_ideas', done: false, waiting: false, terminal: false,
        did: `${count} format${count === 1 ? '' : 's'} extracted. Writing the ad ideas.`,
      };
    }

    // ── write the ad ideas ──────────────────────────────────────────────
    //
    // ONE BUYER PER CALL. Same shape as the persona batches and for the same
    // reasons: it finishes well inside a function's life, a failure costs one
    // buyer rather than twenty, and "this persona has ideas or it does not" is
    // the whole of the progress state.
    //
    // Nothing here spends money. Ideas are text; the first charge is the
    // operator clicking Approve on a row.
    case 'writing_ideas': {
      const { data: personaData } = await db.from('personas')
        .select('id, persona_index, slug, persona_name, primary_pain_point, core_desire, '
          + 'angle_hook, custom_hero_headline, custom_reasons')
        .eq('campaign_id', campaign.id).is('superseded_at', null)
        .order('persona_index');

      // Through `unknown`, as everywhere else in this file: the client carries
      // no generated schema, so a select string resolves to the driver's error
      // placeholder rather than to a row type. Asserted rather than pretended
      // to be checked.
      const personas = (personaData ?? []) as unknown as (PersonaForPrompt & { slug: string })[];
      if (!personas.length) {
        return fail(campaign.id, 'There are no landing pages to write ads for.');
      }

      // Live ideas only, for the same reason as the pages above: a buyer whose
      // only ideas were superseded by a redo has none, and has to be written
      // again. Counting the superseded ones would skip that buyer forever.
      const { data: existing } = await db.from('ad_ideas')
        .select('persona_id').eq('campaign_id', campaign.id).is('superseded_at', null);
      const done = new Set(
        ((existing ?? []) as unknown as { persona_id: string }[]).map((r) => r.persona_id),
      );

      const next = personas.find((p) => !done.has(p.id));
      if (!next) {
        await db.from('campaigns').update({ status: 'ideas_ready' }).eq('id', campaign.id);
        const { count: ideaCount } = await db.from('ad_ideas')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', campaign.id).is('superseded_at', null);
        return {
          status: 'ideas_ready', done: true, waiting: false, terminal: true,
          did: `${ideaCount ?? 0} ad ideas written across ${personas.length} buyers. `
            + 'Nothing has been generated and nothing has been charged — that starts when you '
            + 'approve a row.',
        };
      }

      const { data: formats } = await db.from('format_specs')
        .select('id, media_type, format_name, description, hook_pattern, visual_recipe, '
          + 'offer_placement, observed_count, median_days_running')
        .eq('campaign_id', campaign.id).order('observed_count', { ascending: false });
      const formatRows = (formats ?? []) as unknown as FormatForPrompt[];

      const { plan, note } = planIdeas({
        split: campaign.media_split,
        hasImageFormats: formatRows.some((f) => f.media_type === 'image'),
        hasVideoFormats: formatRows.some((f) => f.media_type === 'video'),
      });
      if (!plan.length) {
        return fail(campaign.id, note ?? 'There are no formats to build ad ideas on.');
      }

      const brief = campaign.scraped_data?.brief;
      if (!brief) return fail(campaign.id, 'The product brief is missing, so no ad can be written.');

      // Usable photographs only. A wordmark or a banner is not something an ad
      // can be built out of, and the picture stage already made that judgement.
      const { data: images } = await db.from('campaign_images')
        .select('position, source_url, caption')
        .eq('campaign_id', campaign.id).eq('usable', true).order('position');

      // Same driver lock as everywhere else, held by advance() around this whole
      // unit: without it two drivers both read "this buyer has no ideas" and the
      // loser pays for a generation the unique index then rejects.
      // An ad's destination has to be an absolute URL — Meta will not accept a
      // path, and a relative one written into sixty rows is sixty ads pointing
      // nowhere. Better to stop here than to write them.
      const site = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '');
      if (!/^https?:\/\//.test(site)) {
        return fail(campaign.id, 'NEXT_PUBLIC_SITE_URL is not set to a full address, so the ad '
          + 'ideas have nowhere to point. Every ad\'s destination is that buyer\'s live page, '
          + 'and Meta will not take a relative link.');
      }
      try {
        const result = await generateIdeasForPersona({
          campaignId: campaign.id,
          productType: campaign.product_type,
          brief,
          persona: next,
          formats: formatRows,
          images: (images ?? []) as unknown as ImageForPrompt[],
          plan,
          // The buyer's own page. This is the reason the pages exist: one ad,
          // one buyer, one destination written for them. Editable per row on
          // the table for anyone who wants to send a particular ad elsewhere.
          destinationUrl: `${site}/p/${campaign.slug}/${next.slug}`,
          currentOffer: campaign.current_offer,
          guidance: noteForStep(campaign, 'ideas'),
        });

        if (!result.rows.length) {
          return fail(campaign.id, `No usable ad ideas came back for ${next.persona_name}: `
            + (result.rejected.map((r) => r.reason).join('; ') || 'the model returned nothing.'));
        }

        // ignoreDuplicates rather than a plain insert: the lock above is the
        // real guard, but it expires, and a slow driver coming back to life
        // must not kill a campaign on a unique-key violation.
        // No named conflict target. Since 0016 the unique key on (persona_id,
        // idea_index) is a PARTIAL index — it applies to live rows only, so a
        // superseded attempt 1 does not stop the replacement being called 1 —
        // and Postgres will not accept a partial index as an arbiter unless the
        // predicate is named too, which PostgREST cannot express. A bare ON
        // CONFLICT DO NOTHING is legal against any index and absorbs a superset
        // of what the named target did, which is the right direction for a
        // guard whose whole job is to swallow a duplicate from a driver that
        // woke up after its lock expired.
        const { error } = await db.from('ad_ideas')
          .upsert(result.rows, { ignoreDuplicates: true });
        if (error) return fail(campaign.id, `Could not save the ad ideas: ${error.message}`);

        const written = personas.filter((p) => done.has(p.id)).length + 1;
        return {
          status: 'writing_ideas', done: false, waiting: false, terminal: false,
          did: `${result.rows.length} ad ideas for ${next.persona_name} `
            + `(${written} of ${personas.length} buyers).`,
          notes: [
            ...(note ? [note] : []),
            ...result.rejected.map((r) => `Idea ${r.idea_index} was dropped: ${r.reason}`),
          ],
        };
      } catch (e) {
        return fail(campaign.id, `Could not write the ideas for ${next.persona_name}: `
          + (e as Error).message);
      }
    }

    case 'ideas_ready': {
      // A campaign that reached here before this stage existed has no ideas at
      // all. Rewind rather than show an empty table: `writing_ideas` is
      // idempotent and will fill it in.
      const { count } = await db.from('ad_ideas')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaign.id).is('superseded_at', null);
      if (!count) {
        await db.from('campaigns').update({ status: 'writing_ideas' }).eq('id', campaign.id);
        return {
          status: 'writing_ideas', done: false, waiting: false, terminal: false,
          did: 'This campaign finished before the ad ideas stage existed. Writing them now.',
        };
      }
      return {
        status: 'ideas_ready', done: true, waiting: false, terminal: true,
        did: `${count} ad ideas are waiting for you. Nothing is generated or charged until you `
          + 'approve a row.',
      };
    }

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

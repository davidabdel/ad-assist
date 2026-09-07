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
import type { BasePage, ProductBrief } from './schemas';
import type { Reason } from '@/lib/page-data';

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
  status: string;
  base_page_guidance: string | null;
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

export async function advance(campaign: CampaignRow): Promise<AdvanceResult> {
  const db = serviceClient();

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
        const { plan, unreadable } = await planImages(brief, reasons, urls);
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
            status: 'pages_built', done: true, waiting: false, terminal: true,
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
              campaign.product_type, target,
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
            return {
              campaign_id: campaign.id,
              persona_index: nextIndex + i,
              slug: p.slug,
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
          terminal: total >= target,
          personas: total,
          did: `Wrote ${added} persona${added === 1 ? '' : 's'} (${total}/${target}).`,
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

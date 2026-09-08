import { serviceClient } from '@/lib/supabase';
import { generate } from '@/lib/llm';
import { FormatSpecBatchSchema } from './schemas';

/**
 * The extraction pass: scanned ads in, format specs out.
 *
 * This is the firewall the whole design rests on. Raw competitor ad copy
 * reaches THIS prompt and no other one — what leaves here is a description of
 * structure, and that description is all the copywriting stage ever sees. The
 * reason is not politeness: a model handed forty winning ads and asked to write
 * a forty-first will produce a collage of their sentences, and those sentences
 * belong to somebody else and were written for somebody else's product.
 *
 * Run once per media type. Statics and video are separate crafts — a hook that
 * works as a line of overlaid text is not the same object as a hook that is the
 * first second and a half of a video — so mixing them produces formats that are
 * true of neither.
 */

/**
 * How many ads the prompt sees.
 *
 * Not a cost limit — sixty short ad records is a couple of thousand tokens.
 * It is a QUALITY limit: the list is sorted longest-running first, so the top
 * sixty are the ads with the most evidence behind them, and appending the next
 * two hundred marginal ones would dilute the patterns rather than sharpen them.
 * Whatever is left out is reported, never dropped silently.
 */
const SAMPLE_SIZE = 60;

/**
 * Below this there is nothing to extract. Three ads cannot show a pattern —
 * anything a model reported from them would be a description of three ads
 * wearing the word "format".
 */
const MIN_ADS = 8;

export type ScannedAdRow = {
  id: string;
  meta_ad_id: string;
  advertiser_name: string | null;
  days_running: number | null;
  variant_count: number | null;
  primary_text: string | null;
  headline: string | null;
  description: string | null;
  cta_label: string | null;
};

const SYSTEM = `You study advertising formats.

You are given real ads that are still live and have been running for between
ninety days and one year. Long run time is the only performance signal Meta
publishes for commercial ads — no impressions, no spend, no reach — so treat it
as the single piece of evidence it is: these ads pay for themselves, and
something about how they are built is doing that work.

Your job is to name the SHAPES you can see repeating across them.

The one rule that matters: describe what an ad DOES, never what it SAYS. Your
output is read by a writer who must not see the source copy, because their
product is not these products and their customer is not these customers. "Opens
on the failure state before the product exists" is useful to that writer.
"Tired of razor burn?" is somebody else's sentence and is useless to them.

So: no quoted phrases, no brand names, no product names, no borrowed sentences.
If you find yourself reaching for an advertiser's wording, you have stopped
describing structure and started transcribing.

Report the patterns that are actually there. Four real formats beat seven where
three were rounded up to fill the list, and an ad that matches nothing belongs
in unclassified_indexes rather than in the nearest format.`;

function renderAd(ad: ScannedAdRow, index: number): string {
  const parts = [
    `[${index}] running ${ad.days_running ?? '?'} days`
    + (ad.variant_count && ad.variant_count > 1 ? `, ${ad.variant_count} variants` : ''),
  ];
  if (ad.headline) parts.push(`  headline: ${ad.headline}`);
  if (ad.primary_text) parts.push(`  body: ${ad.primary_text.slice(0, 600)}`);
  if (ad.description) parts.push(`  description: ${ad.description}`);
  if (ad.cta_label) parts.push(`  button: ${ad.cta_label}`);
  return parts.join('\n');
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export type ExtractResult = {
  mediaType: 'image' | 'video';
  written: number;
  adsConsidered: number;
  adsSampled: number;
  notes: string[];
};

export async function extractFormats(input: {
  campaignId: string;
  mediaType: 'image' | 'video';
}): Promise<ExtractResult> {
  const db = serviceClient();
  const notes: string[] = [];

  // Qualifying only: active, 90–365 days, not badged as a low-impression trickle.
  // The scanner already made that judgement and wrote it onto the row — redoing
  // it here would be a second definition of "winning" that could drift from the
  // one the operator sees on screen.
  const { data: qualifying, error } = await db.from('scanned_ads')
    .select('id, meta_ad_id, advertiser_name, days_running, variant_count, '
      + 'primary_text, headline, description, cta_label')
    .eq('campaign_id', input.campaignId)
    .eq('media_type', input.mediaType)
    .eq('qualified', true)
    .order('days_running', { ascending: false, nullsFirst: false });
  if (error) throw new Error(`Could not read the scanned ads: ${error.message}`);

  // Through `unknown`: the Supabase client here carries no generated schema, so
  // the select string resolves to the driver's error placeholder rather than to
  // a row type. The shape is asserted rather than proven either way — this just
  // says so instead of pretending the driver checked it.
  const all = (qualifying ?? []) as unknown as ScannedAdRow[];

  // An ad whose card carried no readable text is a row with a run time and
  // nothing to learn from. Counted, then excluded, then said out loud.
  const withCopy = all.filter((a) => a.primary_text || a.headline || a.description);
  if (withCopy.length < all.length) {
    notes.push(`${all.length - withCopy.length} of ${all.length} ${input.mediaType} ads had no `
      + 'readable copy on the card and could not be classified.');
  }

  if (withCopy.length < MIN_ADS) {
    notes.push(`Only ${withCopy.length} usable ${input.mediaType} ads — fewer than the `
      + `${MIN_ADS} it takes to see a pattern, so no ${input.mediaType} formats were written. `
      + 'This is left empty rather than filled with a guess.');
    return {
      mediaType: input.mediaType, written: 0,
      adsConsidered: all.length, adsSampled: 0, notes,
    };
  }

  const sample = withCopy.slice(0, SAMPLE_SIZE);
  if (withCopy.length > SAMPLE_SIZE) {
    notes.push(`Read the ${SAMPLE_SIZE} longest-running of ${withCopy.length} qualifying `
      + `${input.mediaType} ads.`);
  }

  const listing = sample.map((ad, i) => renderAd(ad, i)).join('\n\n');
  const { data: batch } = await generate({
    system: SYSTEM,
    prompt: `${sample.length} ${input.mediaType} ads, longest-running first.\n\n`
      + `${listing}\n\n`
      + `Name the formats you can see repeating across these ${sample.length} ads. `
      + 'Assign every ad to exactly one format, or to unclassified_indexes.',
    schema: FormatSpecBatchSchema,
    maxTokens: 8000,
    effort: 'high',
  });

  // The model's indexes are positions in the list it was shown. Anything out of
  // range is dropped rather than clamped — clamping would silently attribute an
  // ad to a format it was never assigned to.
  const rows = [];
  let dropped = 0;
  for (const format of batch.formats) {
    const ads = format.ad_indexes
      .filter((i) => {
        const ok = Number.isInteger(i) && i >= 0 && i < sample.length;
        if (!ok) dropped++;
        return ok;
      })
      .map((i) => sample[i]);
    if (!ads.length) continue;

    rows.push({
      campaign_id: input.campaignId,
      media_type: input.mediaType,
      format_name: format.format_name,
      description: format.description,
      hook_pattern: format.hook_pattern,
      visual_recipe: format.visual_recipe,
      offer_placement: format.offer_placement || null,
      // Counted here, not asked for: the model reports which ads it assigned,
      // and arithmetic over that assignment is the one part of this that has a
      // right answer.
      observed_count: ads.length,
      median_days_running: median(
        ads.map((a) => a.days_running).filter((d): d is number => d != null),
      ),
      example_ad_ids: ads.map((a) => a.id),
      // NULL, and deliberately so. Pacing means cut count, shot length and
      // where the hook ends, and those are MEASUREMENTS — they come from
      // decoding the video file, which nothing in this pipeline does yet. The
      // scanner harvests the video's URL and never downloads it. A model asked
      // to estimate them from ad copy would return plausible numbers with
      // nothing behind them, which is worse than an empty column, because a
      // number on a screen gets believed.
      pacing: null,
    });
  }

  if (dropped) {
    notes.push(`${dropped} ad references pointed outside the list and were ignored.`);
  }
  if (batch.unclassified_indexes.length) {
    notes.push(`${batch.unclassified_indexes.length} of ${sample.length} ads followed no shared `
      + 'shape and were left unclassified.');
  }
  if (input.mediaType === 'video') {
    notes.push('Video pacing (cut count, shot length, where the hook ends) is blank: it has to '
      + 'be measured from the video file, and nothing downloads them yet.');
  }

  if (rows.length) {
    // Replace rather than append. Re-running extraction on the same campaign is
    // a legitimate thing to do after a wider scan, and appending would leave the
    // old specs sitting next to the new ones with no way to tell which sample
    // each came from.
    await db.from('format_specs')
      .delete().eq('campaign_id', input.campaignId).eq('media_type', input.mediaType);
    const { error: writeError } = await db.from('format_specs').insert(rows);
    if (writeError) throw new Error(`Could not save the formats: ${writeError.message}`);
  }

  return {
    mediaType: input.mediaType,
    written: rows.length,
    adsConsidered: all.length,
    adsSampled: sample.length,
    notes,
  };
}

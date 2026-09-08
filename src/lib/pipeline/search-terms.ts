/**
 * What to type into the Meta Ad Library.
 *
 * The obvious approach — search the product's own category — is wrong, and it
 * gets worse the more specific the product is. The Ad Library matches the term
 * against the text INSIDE the ad and the advertiser's page name, so a niche
 * term returns a niche: "eco cleaning products" comes back with a handful of
 * ads from a handful of advertisers, several of them the same company. A scan
 * like that measures one corner of one market and calls it what works.
 *
 * We are not looking for competitors. We are looking for FORMAT — the hook, the
 * order the argument arrives in, where the offer sits — and format is the part
 * of an ad that travels between categories. So the search is for the LANGUAGE
 * that long-running direct-response ads share whatever they happen to sell.
 *
 *   "Search by ad-copy phrases, not product class. If you only want
 *    hook/pacing/structure, search for the language that winning DTC ads
 *    almost always contain."  — David, 8 Sep 2026
 *
 * The four categories below are his, and the phrases are his words, kept
 * verbatim rather than paraphrased into something that reads better. They are
 * search strings, not copy: what matters is that real ads contain them.
 *
 * The consequence to be aware of: this makes the scan almost independent of
 * what the campaign sells. Two different campaigns in the same region scanning
 * the same media type will see overlapping ads. That is the intended trade —
 * a broad, category-blind sample of ads that survived 90 days is a better
 * teacher of structure than a narrow sample of the competition.
 */

export type PhraseCategory = 'offer' | 'testimonial' | 'problem' | 'cta';

export const PHRASE_LIBRARY: Record<PhraseCategory, readonly string[]> = {
  /** What the ad gives you. Present in almost every offer-led ad. */
  offer: ['free shipping', 'money back guarantee', 'limited time', '50% off'],
  /** Someone talking about their own experience. The UGC opener. */
  testimonial: ['I was skeptical', 'TikTok made me buy', "I've tried everything", "here's why"],
  /** A problem named before anything is sold. */
  problem: ['stop doing this', 'the truth about', 'before and after'],
  /** Generic ecommerce calls to action. Catches the plain performance ad. */
  cta: ['shop now', 'get yours', 'sold out'],
};

export const CATEGORY_LABEL: Record<PhraseCategory, string> = {
  offer: 'Offer language',
  testimonial: 'UGC / testimonial hooks',
  problem: 'Problem / solution hooks',
  cta: 'Generic ecommerce CTAs',
};

/**
 * How many phrases one scan job searches.
 *
 * Each phrase is its own trip through the library and takes about eighty
 * seconds to reach the 300-ad ceiling, so this number is a straight multiplier
 * on how long the Mac is busy. Two is enough because volume is not the
 * constraint: one phrase alone returns roughly a hundred ads that pass the
 * 90-day filter, and the extraction pass reads sixty. What extra phrases buy is
 * VARIETY of structure, and that is bought more cheaply by giving different
 * jobs different phrases than by piling them into one — see `termsForJob`.
 */
export const TERMS_PER_JOB = 2;

/**
 * The phrases in one flat round-robin: offer, testimonial, problem, cta, offer,
 * testimonial, … Interleaving the categories rather than concatenating them is
 * what makes a two-phrase slice contain two DIFFERENT kinds of ad, and makes
 * consecutive jobs differ from each other instead of both drawing from `offer`.
 */
export const ROTATION: readonly { category: PhraseCategory; phrase: string }[] = (() => {
  const categories = Object.keys(PHRASE_LIBRARY) as PhraseCategory[];
  const longest = Math.max(...categories.map((c) => PHRASE_LIBRARY[c].length));
  const out: { category: PhraseCategory; phrase: string }[] = [];
  for (let i = 0; i < longest; i++) {
    for (const category of categories) {
      const phrase = PHRASE_LIBRARY[category][i];
      if (phrase) out.push({ category, phrase });
    }
  }
  return out;
})();

/**
 * A small stable hash. Only needs to spread campaign ids across the rotation,
 * so FNV-1a is more than enough — and being written out here rather than
 * imported means it cannot change under us between two calls of `advance()`.
 */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The phrases for one region × media-type job.
 *
 * DETERMINISTIC, which is the point. `advance()` is called repeatedly and has
 * to be idempotent; if this returned a random pick then a re-queued job would
 * search different phrases from the one it replaced, and the two runs could not
 * be compared or deduplicated. Same campaign and same job always produce the
 * same terms, and different campaigns start at different places in the rotation
 * so the whole library gets used across a few campaigns rather than the first
 * two phrases being searched forever.
 */
export function termsForJob(input: {
  campaignId: string;
  region: string;
  mediaType: 'image' | 'video';
  /** Which job this is within the campaign's set. Drives the rotation step. */
  jobIndex: number;
}): string[] {
  const start = (hash(input.campaignId) + input.jobIndex * TERMS_PER_JOB) % ROTATION.length;
  const out: string[] = [];
  for (let i = 0; i < TERMS_PER_JOB; i++) {
    out.push(ROTATION[(start + i) % ROTATION.length].phrase);
  }
  return out;
}

/** `ALL` is the three markets, anything else is itself. */
export function regionsToScan(region: string): string[] {
  return region === 'ALL' ? ['AU', 'US', 'GB'] : [region];
}

/**
 * Both media types, always. The idea stage writes a mix of statics and video
 * per persona (`campaigns.media_split`), so a scan that covered only one of
 * them would leave half the ideas with no observed format to be built on.
 */
export const MEDIA_TYPES = ['image', 'video'] as const;

/** Every job a campaign's scan consists of, in the order they get queued. */
export function planScanJobs(input: { campaignId: string; region: string }) {
  const jobs: {
    region: string; mediaType: 'image' | 'video'; searchTerms: string[];
  }[] = [];
  for (const region of regionsToScan(input.region)) {
    for (const mediaType of MEDIA_TYPES) {
      jobs.push({
        region,
        mediaType,
        searchTerms: termsForJob({
          campaignId: input.campaignId, region, mediaType, jobIndex: jobs.length,
        }),
      });
    }
  }
  return jobs;
}

/**
 * Roughly how long the Mac will be busy, in minutes. One worker runs jobs one
 * at a time, and a phrase takes about eighty seconds to reach the ceiling.
 * Stated on screen rather than kept to ourselves: a scan that looks stuck for
 * a quarter of an hour is the thing most likely to get killed halfway.
 */
export const SECONDS_PER_TERM = 80;

export function estimatedScanMinutes(jobCount: number): number {
  return Math.max(1, Math.round((jobCount * TERMS_PER_JOB * SECONDS_PER_TERM) / 60));
}

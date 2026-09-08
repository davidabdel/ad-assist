/**
 * Turns `campaigns.status` into the row of steps the progress screen draws.
 *
 * Every state here is read from the database, never from a timer and never from
 * anything the browser remembers. Refresh the page mid-build and it shows the
 * same thing, because the rows that exist ARE the progress.
 *
 * The last step is marked as not built. That is deliberate: the pipeline
 * genuinely stops after the ad-library scan, and a progress bar that quietly
 * leaves out the part that does not exist is how somebody ends up waiting all
 * afternoon for ad ideas that were never coming.
 */

export type StepState = 'todo' | 'active' | 'done' | 'failed' | 'unbuilt';

export type Step = {
  key: string;
  title: string;
  /** What is happening, in the present tense, for whoever is watching. */
  detail: string;
  state: StepState;
};

/** Order of the statuses `advance()` walks through. Anything else is off-path. */
const RANK: Record<string, number> = {
  pending: 0,
  scraping: 1,
  base_review: 2,
  images: 3,
  personas: 4,
  pages_built: 5,
  scanning: 6,
  extracting: 7,
  ideas_ready: 8,
};

export const STATUS_LABEL: Record<string, string> = {
  pending: 'Not started yet',
  scraping: 'Reading your product page',
  base_review: 'Waiting for you to approve the main page',
  images: 'Choosing photos for your page',
  personas: 'Writing your landing pages',
  // No count here on purpose: the list endpoint does not return one, and a run
  // that stopped short would otherwise be labelled with a number it did not reach.
  pages_built: 'Pages are live — starting the ad scan',
  scanning: 'Reading Meta\'s ad library on your Mac',
  extracting: 'Working out what the winning ads have in common',
  ideas_ready: 'Formats found — ad ideas are the next stage',
  failed: 'Stopped with a problem',
};

/**
 * The fallback only. How many pages a campaign gets is a property of what it
 * sells and lives on the row (see lib/product-type.ts) — a physical product or
 * an ebook gets twenty, one specific vehicle gets five. Used where a target has
 * genuinely not been read yet, never as the answer.
 */
export const DEFAULT_PERSONA_TARGET = 20;

export function buildSteps(input: {
  status: string;
  hasBrief: boolean;
  personaCount: number;
  /** How many pages THIS campaign is writing. */
  personaTarget: number;
  hasSourceUrl: boolean;
  /** The scrape itself reported failure, as opposed to what came after it. */
  ingestFailed: boolean;
  /**
   * The scrape finished. Needed because reading the page and summarising it are
   * two steps inside one `scraping` status — without this both light up at once
   * and the screen claims to be doing two things it is not.
   */
  ingestDone: boolean;
  /**
   * This page fell back to Chrome on the Mac. Almost none do, so the step only
   * mentions the Mac when the Mac is genuinely involved — a screen that always
   * named it taught the operator to expect a dependency that is no longer there.
   */
  usesMac: boolean;
  /** The base page exists. It is the gate, so its presence is its own step. */
  hasBasePage: boolean;
  /**
   * The image library exists, which is the only durable trace that the picture
   * stage ran. Needed to tell a campaign that died choosing photos from one
   * that died writing pages, since `failed` does not rewind the status.
   */
  hasImages: boolean;
  /** How many photos ended up on the main page, hero included. */
  imagesPlaced: number;
  /** Ad-library searches queued for this campaign, and how many have finished. */
  scanJobsTotal: number;
  scanJobsDone: number;
  /** Ads read, and how many were still running after 90+ days. */
  adsFound: number;
  adsQualified: number;
  /** Formats written. Zero after a finished scan is a real answer, not a gap. */
  formatCount: number;
}): Step[] {
  const {
    status, hasBrief, personaCount, personaTarget, hasSourceUrl, ingestFailed, ingestDone,
    usesMac, hasBasePage, hasImages, imagesPlaced,
    scanJobsTotal, scanJobsDone, adsFound, adsQualified, formatCount,
  } = input;
  const failed = status === 'failed';
  const rank = RANK[status] ?? (failed ? -1 : 0);

  // `advance()` marks a campaign failed without rewinding its status, so the
  // step that broke is worked out from what actually made it into the database:
  // a brief means the scrape and the summary both landed, and whether a base
  // page exists says which of the two writing steps was in flight.
  // Checked before the page steps: a campaign that got as far as queueing a
  // scan has its twenty pages, so blaming the writing stage for a scan that
  // broke would send the operator to look at pages that are fine.
  const failedAt = !failed ? -1
    : scanJobsTotal > 0 ? 5
      : personaCount > 0 || hasImages ? 4
        : hasBasePage ? 3
          : hasBrief ? 2
            : ingestFailed ? 0 : 1;

  const mark = (index: number, done: boolean, active: boolean): StepState => {
    if (failed) {
      if (index === failedAt) return 'failed';
      return index < failedAt ? 'done' : 'todo';
    }
    if (done) return 'done';
    return active ? 'active' : 'todo';
  };

  return [
    {
      key: 'read',
      title: hasSourceUrl ? 'Reading your product page' : 'Reading what you typed',
      detail: !hasSourceUrl
        ? 'Taking your description as the source instead of a web page.'
        : usesMac
          ? 'This shop refuses to be read by anything but a browser, so a real Chrome '
            + 'window on your Mac is opening the page and pulling out the price, the '
            + 'features and the customer reviews.'
          : 'Pulling the price, the features, the photos and the customer reviews '
            + 'straight off the page. Takes about a second and needs nothing running '
            + 'on your machine.',
      state: mark(0, ingestDone || hasBrief || rank >= 2, !ingestDone && rank <= 1),
    },
    {
      key: 'brief',
      title: 'Summarising what you sell',
      detail: 'One short, factual summary of the product: what it does, what it costs, what '
        + 'customers actually said about it. Everything after this is written from it.',
      state: mark(1, hasBrief || rank >= 2, ingestDone && !hasBrief && rank <= 1),
    },
    {
      key: 'base',
      title: 'Writing the main page, for you to approve',
      detail: rank > 2 || (failed && failedAt > 2)
        ? `Approved. Seven of its ten reasons appear on every one of the ${personaTarget} pages.`
        : hasBasePage
          ? 'Written and waiting. Read it below — seven of its ten reasons go onto all '
            + `${personaTarget} pages unchanged, so nothing else runs until you approve it.`
          : 'One page written for the broadest buyer. It is the checkpoint: seven of its ten '
            + `reasons are copied onto all ${personaTarget} pages, so a mistake here is a `
            + `mistake ${personaTarget} times.`,
      state: mark(2, rank >= 3, rank === 2),
    },
    {
      key: 'images',
      title: 'Choosing photos from your own site',
      detail: hasImages
        ? `${imagesPlaced} of your own photos are on the main page. Nothing was generated `
          + 'and nothing was paid for — every picture is one that was already on your site.'
        : 'The photos on your product page get read, described, and put against the reasons '
          + 'they actually show. A reason no photo genuinely illustrates keeps its empty slot '
          + 'rather than borrowing an unrelated picture.',
      state: mark(3, rank >= 4, rank === 3),
    },
    {
      key: 'pages',
      title: `Writing ${personaTarget} landing pages`,
      detail: personaCount > 0 && personaCount < personaTarget
        ? `${personaCount} of ${personaTarget} written. Each one is a different kind of buyer, `
          + 'with their own headline and their own reasons to buy.'
        : 'One page per kind of buyer — the nervous first-timer, the gift buyer, the upgrader — '
          + 'each with its own headline, its own reasons and its own pictures.',
      state: mark(4, rank >= 5, rank === 4),
    },
    {
      key: 'scan',
      title: 'Studying ads that already work',
      // Four different sentences, because this step has four genuinely different
      // things to say and the one that matters most is the middle one: it is the
      // only stage besides the first that can be waiting on a sleeping Mac.
      detail: formatCount > 0
        ? `${formatCount} format${formatCount === 1 ? '' : 's'} found across ${adsQualified} ads `
          + 'that have been running 90 days or more. What was kept is the SHAPE of those ads — '
          + 'the hook, the running order, where the offer lands. None of their words travel '
          + 'any further than this screen.'
        : rank >= 8
          ? `${adsFound} ads read, but no repeating shape was clear enough to write down. `
            + 'Left empty rather than filled with a pattern that was not there.'
          : rank >= 6
            ? `${scanJobsDone} of ${scanJobsTotal} searches done`
              + (adsFound ? `, ${adsFound} ads read so far` : '')
              + '. Chrome is doing this on your Mac, so it has to be awake. Costs nothing.'
            : 'Reads Meta\'s public ad library for ads still running after 90 days — the only '
              + 'performance signal Meta publishes — and works out what shape they share. '
              + 'The searches are ad-copy phrases rather than your product category, because '
              + 'structure is the part of an ad that travels between markets.',
      state: mark(5, rank >= 8, rank === 6 || rank === 7),
    },
    {
      key: 'ideas',
      title: 'Writing your ad ideas',
      detail: 'Not built yet. This will write three ad ideas per buyer into a table, and nothing '
        + 'gets made or charged until you approve a row.',
      state: 'unbuilt',
    },
  ];
}

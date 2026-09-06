/**
 * Turns `campaigns.status` into the row of steps the progress screen draws.
 *
 * Every state here is read from the database, never from a timer and never from
 * anything the browser remembers. Refresh the page mid-build and it shows the
 * same thing, because the rows that exist ARE the progress.
 *
 * Two of the five steps are marked as not built. That is deliberate: the
 * pipeline genuinely stops after the landing pages, and a progress bar that
 * quietly leaves out the parts that do not exist is how somebody ends up waiting
 * all afternoon for ad ideas that were never coming.
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
};

export const STATUS_LABEL: Record<string, string> = {
  pending: 'Not started yet',
  scraping: 'Reading your product page',
  base_review: 'Waiting for you to approve the main page',
  images: 'Choosing photos for your page',
  personas: 'Writing your landing pages',
  // No count here on purpose: the list endpoint does not return one, and a run
  // that stopped short would otherwise be labelled with a number it did not reach.
  pages_built: 'Finished — pages are live',
  failed: 'Stopped with a problem',
};

export const PERSONA_TARGET = 20;

export function buildSteps(input: {
  status: string;
  hasBrief: boolean;
  personaCount: number;
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
}): Step[] {
  const {
    status, hasBrief, personaCount, hasSourceUrl, ingestFailed, ingestDone, usesMac, hasBasePage,
    hasImages, imagesPlaced,
  } = input;
  const failed = status === 'failed';
  const rank = RANK[status] ?? (failed ? -1 : 0);

  // `advance()` marks a campaign failed without rewinding its status, so the
  // step that broke is worked out from what actually made it into the database:
  // a brief means the scrape and the summary both landed, and whether a base
  // page exists says which of the two writing steps was in flight.
  const failedAt = !failed ? -1
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
        ? 'Approved. Seven of its ten reasons appear on every one of the twenty pages.'
        : hasBasePage
          ? 'Written and waiting. Read it below — seven of its ten reasons go onto all '
            + `${PERSONA_TARGET} pages unchanged, so nothing else runs until you approve it.`
          : 'One page written for the broadest buyer. It is the checkpoint: seven of its ten '
            + `reasons are copied onto all ${PERSONA_TARGET} pages, so a mistake here is a `
            + `mistake ${PERSONA_TARGET} times.`,
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
      title: `Writing ${PERSONA_TARGET} landing pages`,
      detail: personaCount > 0 && personaCount < PERSONA_TARGET
        ? `${personaCount} of ${PERSONA_TARGET} written. Each one is a different kind of buyer, `
          + 'with their own headline and their own reasons to buy.'
        : 'One page per kind of buyer — the nervous first-timer, the gift buyer, the upgrader — '
          + 'each with its own headline, its own reasons and its own pictures.',
      state: mark(4, rank >= 5, rank === 4),
    },
    {
      key: 'scan',
      title: 'Studying ads that already work',
      detail: 'Not built yet. This will read Meta\'s public ad library for ads in your category '
        + 'that have been running 90 days or more, and work out what shape they share.',
      state: 'unbuilt',
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

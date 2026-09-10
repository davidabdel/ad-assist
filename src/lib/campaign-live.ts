/**
 * The one line that answers "is this frozen".
 *
 * The progress screen already said a great deal about what a campaign HAD done.
 * It said nothing reliable about whether anything was happening RIGHT NOW, and
 * on the one occasion that mattered it said the opposite of the truth: a
 * campaign that had stopped dead at `pages_built` rendered the sentence "Now
 * reading Meta's ad library", because that branch was chosen from the campaign
 * status alone and never asked whether the loop that does the reading was still
 * running.
 *
 * So this is deliberately a pure function of BOTH — where the campaign is, and
 * what the browser loop is actually doing — and it returns exactly one of five
 * states. There is no sixth, no "probably", and no state in which the screen can
 * claim to be working while nothing is driving it.
 *
 * It is pure so it can be checked without a browser. See
 * `scripts/keep-going-check.mjs`.
 */

export type LiveKind =
  /** A unit of work is in flight, or the loop is between units. */
  | 'working'
  /** Nothing will happen until the operator clicks something. */
  | 'waiting-for-you'
  /** Handed to the Mac-side worker. Progress is measured in searches. */
  | 'waiting-for-mac'
  /** Nothing is driving it. The distinction the old screen could not draw. */
  | 'stopped'
  /** The pipeline is over. */
  | 'finished';

export type LiveStatus = {
  kind: LiveKind;
  /** Two or three words. Readable at arm's length on a phone. */
  headline: string;
  /** What is being done, or what is being waited on. */
  detail: string;
  /**
   * The clock. Always the elapsed time of something real — never a fake
   * percentage and never an estimate. Empty when there is nothing honest to
   * count.
   */
  clock: string;
};

export type LiveInput = {
  /** The driving loop is alive. */
  running: boolean;
  /** How long the current advance() call has been outstanding, or null. */
  inFlightMs: number | null;
  /** Since the last advance() call came back. Null before the first one. */
  sinceTickMs: number | null;
  /** Since anything on the screen last actually changed. Null before the first. */
  sinceChangeMs: number | null;
  /** Title of the step currently lit up, for the "working" case. */
  stepTitle: string | null;
  failed: boolean;
  errorMessage: string | null;
  finished: boolean;
  awaitingApproval: boolean;
  waitingOnMac: boolean;
  /** Only meaningful while waiting on the Mac. */
  scanJobsDone: number;
  scanJobsTotal: number;
};

/** "4 seconds" · "2 minutes" · "1 hour 5 minutes". Words, not 00:04. */
export function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return `${h} hour${h === 1 ? '' : 's'}${rem ? ` ${rem} minute${rem === 1 ? '' : 's'}` : ''}`;
}

/**
 * Order matters and is the whole design. A finished or failed campaign is that
 * first, whatever the loop is doing; a stopped loop outranks every "it is
 * working on it" sentence, because that is the case the screen used to get
 * wrong; and only once none of those apply is the campaign allowed to describe
 * itself.
 */
export function describeLive(input: LiveInput): LiveStatus {
  const {
    running, inFlightMs, sinceTickMs, sinceChangeMs, stepTitle,
    failed, errorMessage, finished, awaitingApproval, waitingOnMac,
    scanJobsDone, scanJobsTotal,
  } = input;

  if (failed) {
    return {
      kind: 'stopped',
      headline: 'Stopped',
      // Deliberately does NOT repeat the error. The screen already carries it
      // in full, with the button that picks the run back up, immediately
      // below — two identical red boxes stacked is one message twice.
      detail: errorMessage
        ? 'It stopped, and nothing further happens by itself. The reason and the button that '
          + 'carries on from the last thing that worked are just below.'
        : 'It stopped and no reason was recorded.',
      clock: sinceChangeMs === null ? '' : `Nothing has moved for ${humanDuration(sinceChangeMs)}.`,
    };
  }

  if (finished) {
    return {
      kind: 'finished',
      headline: 'Finished',
      detail: 'Everything that runs by itself has run. Nothing further happens until you '
        + 'approve an ad below.',
      clock: '',
    };
  }

  if (awaitingApproval) {
    return {
      kind: 'waiting-for-you',
      headline: 'Waiting for you',
      detail: 'The main page is written. Read it below and approve it — nothing else runs '
        + 'until you do, and it will wait here as long as you like.',
      clock: sinceChangeMs === null ? '' : `Been waiting ${humanDuration(sinceChangeMs)}.`,
    };
  }

  // Before the campaign gets to describe itself. A screen that is not driving
  // anything must say so even when the campaign's own status sounds busy —
  // this is the exact case that produced "Now reading Meta's ad library" over a
  // campaign that had been motionless for eight minutes.
  if (!running) {
    return {
      kind: 'stopped',
      headline: 'Not running',
      detail: 'The work is driven from this page, and this page is not driving it. Nothing '
        + 'is lost — press Carry on, or reload, and it picks up exactly where it stopped.',
      clock: sinceChangeMs === null ? '' : `Nothing has moved for ${humanDuration(sinceChangeMs)}.`,
    };
  }

  if (waitingOnMac) {
    return {
      kind: 'waiting-for-mac',
      headline: 'Waiting on your Mac',
      detail: scanJobsTotal
        ? `${scanJobsDone} of ${scanJobsTotal} searches done. Meta only shows its ad library `
          + 'to a real browser, so Chrome on your Mac is doing the reading. Costs nothing.'
        : 'Chrome on your Mac is reading a page that refuses a plain request.',
      // Deliberately the time since the last CHECK, not since the last change.
      // A search takes minutes, so "nothing has changed for 4 minutes" would
      // read as broken while it is working perfectly.
      clock: sinceTickMs === null ? '' : `Checked ${humanDuration(sinceTickMs)} ago.`,
    };
  }

  return {
    kind: 'working',
    headline: 'Working',
    detail: stepTitle ?? 'Working through the next step.',
    // Two genuinely different things, and saying which is which is what makes
    // the number trustworthy: a call that has been outstanding four minutes is
    // a long step, not a hang, and the screen should not have to guess.
    clock: inFlightMs !== null
      ? `This step has been going ${humanDuration(inFlightMs)}.`
      : sinceTickMs === null ? 'Starting…' : `Checked ${humanDuration(sinceTickMs)} ago.`,
  };
}

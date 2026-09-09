import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Sending one step of a campaign back to be done again, with a note.
 *
 * THERE IS NO SECOND ENGINE IN HERE. Every stage in advance() decides whether
 * to run by looking for what it produced — no base page means write one, an
 * empty image library means choose some, a buyer with no ideas means write that
 * buyer's ideas. So a redo is two statements and nothing else: delete what the
 * step made, put the status back to the one that makes it. The loop the
 * progress screen is already running rebuilds it, through exactly the code that
 * built it the first time. A redo that had its own path through the pipeline
 * would be a second implementation of every stage, drifting from the first.
 *
 * WHY A STEP TAKES EVERYTHING BELOW IT WITH IT. The stages are not independent;
 * each one is written FROM the one above. The summary is written from the page
 * read, the main page from the summary, twenty landing pages from the main
 * page, the ad ideas from all of it. Correcting the summary and leaving the
 * pages alone would produce a campaign whose pages contradict the brief they
 * claim to come from — the operator would have fixed the one artefact nobody
 * looks at and none of the twenty that are live. So the cascade is the feature,
 * and the confirm dialog naming it is what keeps it from being a surprise.
 *
 * WHAT A REDO IS NOT ALLOWED TO DO. Everything from the page read down to the
 * ad ideas costs tokens and nothing else — no KIE call happens until someone
 * approves a row in the ideas table. The one irreversible thing in this app is
 * a generated file, and the truly irreversible thing is the live ad pointing at
 * a page. So:
 *
 *   - A finished ad is never deleted. It is marked superseded and stays on
 *     screen with its file, its charge and its ledger line.
 *   - The page a finished ad points at is never deleted either. That URL is a
 *     real address that real traffic arrives at, and a live ad landing on a 404
 *     is a worse outcome than any amount of rework. It is superseded too, and
 *     goes on being served, unchanged, with the words the ad was written
 *     against.
 *
 * The replacements are written alongside them.
 */

/** The step keys the progress screen draws, top to bottom. */
export const REDO_ORDER = ['read', 'brief', 'base', 'images', 'pages', 'scan', 'ideas'] as const;

export type RedoStep = typeof REDO_ORDER[number];

export function isRedoStep(key: string): key is RedoStep {
  return (REDO_ORDER as readonly string[]).includes(key);
}

/**
 * What each step is, in the two terms a redo needs: the status that makes
 * `advance()` do it again, and what has to be gone before it will.
 *
 * `note` is where the operator's correction is kept. `base` is the odd one out
 * because it had a note column of its own before this feature existed and the
 * approve route clears it; the rest share one jsonb keyed by step.
 */
type StepPlan = {
  /** Status to rewind the campaign to. */
  rewindTo: string;
  /** Where this step's note lives. */
  note: 'base_page_guidance' | 'step_guidance';
  /** What the step is called on screen, for the confirm dialog. */
  label: string;
  /**
   * Roughly how long the rebuild takes, said in the dialog. Not measured —
   * an order of magnitude, so "this is a coffee" reads differently from
   * "this is a click".
   */
  minutes: string;
};

const PLANS: Record<RedoStep, StepPlan> = {
  read: {
    rewindTo: 'pending',
    note: 'step_guidance',
    label: 'reading your product page',
    minutes: 'about 5 minutes',
  },
  brief: {
    rewindTo: 'scraping',
    note: 'step_guidance',
    label: 'summarising what you sell',
    minutes: 'about 5 minutes',
  },
  base: {
    rewindTo: 'base_review',
    note: 'base_page_guidance',
    label: 'writing the main page',
    minutes: 'about 4 minutes',
  },
  images: {
    rewindTo: 'images',
    note: 'step_guidance',
    label: 'choosing photos',
    minutes: 'about 4 minutes',
  },
  pages: {
    rewindTo: 'personas',
    note: 'step_guidance',
    label: 'writing the landing pages',
    minutes: 'about 3 minutes',
  },
  scan: {
    rewindTo: 'pages_built',
    note: 'step_guidance',
    label: 'studying ads that already work',
    minutes: '20 minutes or more, and your Mac has to stay awake',
  },
  ideas: {
    rewindTo: 'writing_ideas',
    note: 'step_guidance',
    label: 'writing your ad ideas',
    minutes: 'about 2 minutes',
  },
};

export function redoPlan(step: RedoStep): StepPlan {
  return PLANS[step];
}

/**
 * What a redo of this step takes with it.
 *
 * WRITTEN OUT RATHER THAN "EVERYTHING BELOW IT", and the difference is one
 * step: THE AD-LIBRARY SCAN DOES NOT DEPEND ON ANYTHING ABOVE IT. Its searches
 * are generic ad-copy phrases chosen from the campaign id and the region — see
 * termsForJob in search-terms.ts — so nothing it reads off Meta changes because
 * the summary was corrected. Cascading into it would throw away twenty minutes
 * of the Mac's time, and require the Mac to be awake, to fix a price.
 *
 * It runs in the other direction: the FORMATS the scan produces are what every
 * ad idea is built on, so redoing the scan does take the ideas with it.
 */
const DEPENDENTS: Record<RedoStep, RedoStep[]> = {
  read: ['read', 'brief', 'base', 'images', 'pages', 'ideas'],
  brief: ['brief', 'base', 'images', 'pages', 'ideas'],
  base: ['base', 'images', 'pages', 'ideas'],
  // The picture stage writes into the base page's slots and the persona pages
  // choose from the library it builds, so both are downstream of it.
  images: ['images', 'pages', 'ideas'],
  pages: ['pages', 'ideas'],
  scan: ['scan', 'ideas'],
  ideas: ['ideas'],
};

function fromStep(step: RedoStep): RedoStep[] {
  return DEPENDENTS[step];
}

export type RedoEffects = {
  step: RedoStep;
  rewindTo: string;
  /** Plain sentences naming what will be thrown away and rebuilt. */
  rebuilds: string[];
  /**
   * Finished ads that will be kept rather than deleted, and the pages that stay
   * live because those ads point at them. Zero on almost every redo.
   */
  keptAds: number;
  keptPages: number;
  minutes: string;
  /** Nothing below this step has been built yet, so a redo is just a re-run. */
  trivial: boolean;
};

type Counts = {
  hasBrief: boolean;
  hasBasePage: boolean;
  images: number;
  personas: number;
  formats: number;
  scanJobs: number;
  ideas: number;
  /** Ideas with a file attached that was not rejected. These are the paid ones. */
  paidIdeas: number;
  /** Personas those paid ideas point at. */
  paidPersonas: number;
};

/**
 * What exists right now, live rows only. Superseded rows are invisible to every
 * count here on purpose: they are not part of the campaign any more, they are
 * part of its history, and counting them would make a redo describe itself as
 * rebuilding pages it is going to leave exactly where they are.
 */
async function readCounts(db: SupabaseClient, campaignId: string, hasBrief: boolean): Promise<Counts> {
  const head = { count: 'exact' as const, head: true };

  const [base, images, personas, formats, scanJobs, ideas] = await Promise.all([
    db.from('base_pages').select('id', head).eq('campaign_id', campaignId),
    db.from('campaign_images').select('id', head).eq('campaign_id', campaignId),
    db.from('personas').select('id', head).eq('campaign_id', campaignId).is('superseded_at', null),
    db.from('format_specs').select('id', head).eq('campaign_id', campaignId),
    db.from('scanner_jobs').select('id', head).eq('campaign_id', campaignId).eq('kind', 'ad_scan'),
    db.from('ad_ideas').select('id', head).eq('campaign_id', campaignId).is('superseded_at', null),
  ]);

  const paid = await paidRows(db, campaignId);

  return {
    hasBrief,
    hasBasePage: (base.count ?? 0) > 0,
    images: images.count ?? 0,
    personas: personas.count ?? 0,
    formats: formats.count ?? 0,
    scanJobs: scanJobs.count ?? 0,
    ideas: ideas.count ?? 0,
    paidIdeas: paid.ideaIds.length,
    paidPersonas: paid.personaIds.length,
  };
}

/**
 * The ideas that have cost money, and the pages they point at.
 *
 * "COST MONEY" IS BILLED-AT-SUBMIT, NOT FINISHED. KIE charges when a task is
 * created, not when it is collected, so an asset sitting at `submitted` or
 * `generating` has already been paid for and is going to produce a file that
 * this app will want somewhere to put. Deleting its idea mid-flight would take
 * the row the collector writes back to, and the charge would buy nothing.
 *
 * A REJECTED attempt is the one paid thing that does NOT count. Its ledger line
 * stays and its file stays, but the operator has already looked at it and said
 * it is not going to be used — so it is not a reason to keep a landing page
 * alive, which is the only question being asked here.
 */
const PAID_STATES = new Set(['submitted', 'generating', 'success']);

async function paidRows(
  db: SupabaseClient,
  campaignId: string,
): Promise<{ ideaIds: string[]; personaIds: string[] }> {
  const { data } = await db.from('ad_ideas')
    .select('id, persona_id, generated_assets(id, state, rejected_at)')
    .eq('campaign_id', campaignId)
    .is('superseded_at', null);

  const rows = (data ?? []) as unknown as {
    id: string;
    persona_id: string;
    generated_assets: { state: string; rejected_at: string | null }[] | null;
  }[];

  const paid = rows.filter((r) => (r.generated_assets ?? []).some(
    (a) => PAID_STATES.has(a.state) && !a.rejected_at,
  ));

  return {
    ideaIds: paid.map((r) => r.id),
    personaIds: [...new Set(paid.map((r) => r.persona_id))],
  };
}

/**
 * What a redo of this step would do, without doing any of it. This is what the
 * confirm dialog is built from, and it is read live rather than guessed from
 * the status: a campaign that failed halfway through the pages has a different
 * answer from one that finished them.
 */
export async function describeRedo(
  db: SupabaseClient,
  campaign: { id: string; status: string; persona_target: number | null; scraped_data?: { brief?: unknown } | null },
  step: RedoStep,
): Promise<RedoEffects> {
  const counts = await readCounts(db, campaign.id, Boolean(campaign.scraped_data?.brief));
  const affected = fromStep(step);
  const plan = PLANS[step];
  const rebuilds: string[] = [];

  if (affected.includes('read')) rebuilds.push('read your product page again');
  if (affected.includes('brief') && counts.hasBrief) rebuilds.push('write the summary again');
  if (affected.includes('base') && counts.hasBasePage) {
    rebuilds.push('write the main page again, and stop for you to approve it');
  }
  if (affected.includes('images') && counts.images > 0) {
    rebuilds.push(`choose from your ${counts.images} photos again`);
  }
  if (affected.includes('pages') && counts.personas > 0) {
    const kept = counts.paidPersonas;
    rebuilds.push(
      `rewrite ${counts.personas} landing page${counts.personas === 1 ? '' : 's'}`
      + (kept
        ? ` — ${kept} of them ${kept === 1 ? 'stays' : 'stay'} live as well, `
          + 'because finished ads point at ' + (kept === 1 ? 'it' : 'them')
        : ''),
    );
  }
  if (affected.includes('scan') && counts.scanJobs > 0) {
    rebuilds.push(
      `run the ad-library scan again on your Mac and throw away the ${counts.formats} `
      + `format${counts.formats === 1 ? '' : 's'} it found`,
    );
  }
  if (affected.includes('ideas') && counts.ideas > 0) {
    const fresh = counts.ideas - counts.paidIdeas;
    rebuilds.push(
      `write ${fresh} ad idea${fresh === 1 ? '' : 's'} again`
      + (counts.paidIdeas
        ? `, and keep the ${counts.paidIdeas} you have already paid to make`
        : ''),
    );
  }

  return {
    step,
    rewindTo: plan.rewindTo,
    rebuilds,
    keptAds: counts.paidIdeas,
    keptPages: counts.paidPersonas,
    minutes: plan.minutes,
    // Nothing downstream exists, so there is nothing to warn about — the button
    // should read "run it again", not open a dialog about work being thrown
    // away that was never done.
    trivial: rebuilds.length <= 1,
  };
}

/**
 * Do it.
 *
 * Order matters and is deliberate: the survivors are marked BEFORE anything is
 * deleted, so a failure halfway through leaves rows superseded rather than
 * cascaded away. Superseded is recoverable by hand; a cascaded delete of a page
 * a live ad points at is not.
 */
export async function executeRedo(
  db: SupabaseClient,
  campaign: {
    id: string;
    status: string;
    scraped_data: Record<string, unknown> | null;
    step_guidance: Record<string, string> | null;
  },
  step: RedoStep,
  note: string,
): Promise<{ status: string; did: string }> {
  const affected = fromStep(step);
  const plan = PLANS[step];
  const now = new Date().toISOString();
  const { ideaIds, personaIds } = await paidRows(db, campaign.id);

  // ── the survivors, first ───────────────────────────────────────────
  if (affected.includes('ideas') && ideaIds.length) {
    const { error } = await db.from('ad_ideas')
      .update({ superseded_at: now }).in('id', ideaIds);
    if (error) throw new Error(`Could not set the finished ads aside: ${error.message}`);
  }
  // Only when the pages themselves are being rewritten. A redo of the ideas
  // alone leaves every page exactly where it is.
  if (affected.includes('pages') && personaIds.length) {
    const { error } = await db.from('personas')
      .update({ superseded_at: now }).in('id', personaIds);
    if (error) throw new Error(`Could not set the live pages aside: ${error.message}`);
  }

  // ── then the deletes, bottom of the pipeline upwards ───────────────
  // Upwards so that a failure part-way leaves a campaign missing the LOWER
  // artefacts, which is the state every stage is already written to recover
  // from. Deleting downwards could leave ideas hanging off a persona that no
  // longer exists — which the foreign key would prevent, loudly, mid-run.
  if (affected.includes('ideas')) {
    const q = db.from('ad_ideas').delete().eq('campaign_id', campaign.id).is('superseded_at', null);
    const { error } = ideaIds.length ? await q.not('id', 'in', `(${ideaIds.join(',')})`) : await q;
    if (error) throw new Error(`Could not clear the ad ideas: ${error.message}`);
  }
  if (affected.includes('scan')) {
    // scanned_ads hang off the jobs and go with them. format_specs are keyed on
    // the campaign, and `formats_extracted` is the "already attempted" list that
    // would otherwise make the extraction skip itself forever.
    const jobs = await db.from('scanner_jobs').delete()
      .eq('campaign_id', campaign.id).eq('kind', 'ad_scan');
    if (jobs.error) throw new Error(`Could not clear the scan: ${jobs.error.message}`);
    const formats = await db.from('format_specs').delete().eq('campaign_id', campaign.id);
    if (formats.error) throw new Error(`Could not clear the formats: ${formats.error.message}`);
  }
  if (affected.includes('pages')) {
    const q = db.from('personas').delete()
      .eq('campaign_id', campaign.id).is('superseded_at', null);
    const { error } = personaIds.length
      ? await q.not('id', 'in', `(${personaIds.join(',')})`)
      : await q;
    if (error) throw new Error(`Could not clear the landing pages: ${error.message}`);
  }
  if (affected.includes('images')) {
    const { error } = await db.from('campaign_images').delete().eq('campaign_id', campaign.id);
    if (error) throw new Error(`Could not clear the photo library: ${error.message}`);
  }
  if (affected.includes('base')) {
    // Deleted rather than marked: advance() reads "no base page" as the
    // instruction to write one, and base_pages is one row per campaign.
    const { error } = await db.from('base_pages').delete().eq('campaign_id', campaign.id);
    if (error) throw new Error(`Could not clear the main page: ${error.message}`);
  }

  // ── the campaign row itself ────────────────────────────────────────
  const scraped = { ...(campaign.scraped_data ?? {}) };
  if (affected.includes('brief')) delete scraped.brief;
  // The raw page read only goes when the read itself is being redone. Dropping
  // it on a brief redo would send the campaign back to the Mac for a page it
  // has already downloaded.
  if (affected.includes('read')) delete scraped.raw;

  const guidance = { ...(campaign.step_guidance ?? {}) };
  const trimmed = note.trim().slice(0, 2000);
  const update: Record<string, unknown> = {
    status: plan.rewindTo,
    error_message: null,
    scraped_data: scraped,
  };

  if (plan.note === 'base_page_guidance') {
    update.base_page_guidance = trimmed || null;
  } else if (trimmed) {
    guidance[step] = trimmed;
    update.step_guidance = guidance;
  } else {
    // An empty note on a step that has one is an instruction to forget it: the
    // operator is asking for a plain re-roll, and silently keeping the last
    // correction would make that button do something it does not say.
    delete guidance[step];
    update.step_guidance = guidance;
  }

  if (affected.includes('read')) {
    const ingest = await db.from('scanner_jobs').delete()
      .eq('campaign_id', campaign.id).eq('kind', 'ingest');
    if (ingest.error) throw new Error(`Could not clear the page read: ${ingest.error.message}`);
  }
  if (affected.includes('scan')) update.formats_extracted = [];

  const { error } = await db.from('campaigns').update(update).eq('id', campaign.id);
  if (error) throw new Error(`Could not rewind the campaign: ${error.message}`);

  return {
    status: plan.rewindTo,
    did: trimmed
      ? `Doing "${plan.label}" again, with your note: "${trimmed}"`
      : `Doing "${plan.label}" again.`,
  };
}

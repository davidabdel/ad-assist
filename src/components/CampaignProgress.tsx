'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { TopBar } from '@/components/Authed';
import { useSession } from '@/components/Session';
import {
  Button, Callout, Card, CopyButton, Field, Shell, inputClass,
} from '@/components/ui';
import { buildSteps, DEFAULT_PERSONA_TARGET, type Step, type StepState } from '@/lib/campaign-steps';
import { CTA_LABELS } from '@/lib/ad-fields';

/**
 * Watches one campaign and drives it.
 *
 * `advance()` does one unit of work per call by design, so something has to keep
 * calling it — this screen is that something. It is a plain loop rather than an
 * interval: an interval can overlap itself when a unit runs long.
 *
 * THIS TAB IS THE ENGINE. Nothing runs on a server timer, so closing the tab
 * does not lose work — every unit is idempotent and the progress lives in the
 * database — but it does STOP the work until the page is opened again. An
 * earlier version of this screen claimed otherwise and a campaign sat still for
 * eight hours looking like it was thinking. The copy below now says what is
 * true.
 *
 * Two tabs are two engines. They no longer collide: `advance()` claims a
 * per-campaign lock before each batch, so the second one waits instead of
 * writing the same pages twice.
 */

type Persona = {
  id: string;
  persona_index: number;
  slug: string;
  persona_name: string;
  angle_hook: string;
  url: string;
  views_count: number;
  clicks_count: number;
  /**
   * Set when a redo replaced this page but could not delete it, because ads
   * that have been paid for point at its URL. It is still live and still taking
   * traffic, so it is shown rather than hidden — just not counted.
   */
  superseded_at: string | null;
};

type Job = {
  kind: string; status: string; error_message: string | null; notes: string | null;
  region: string | null; media_type: string | null; search_terms: string[] | null;
};

/**
 * The firewall's output. Everything here describes what an ad DOES; none of it
 * is what an ad SAYS, which is why this is the only part of the scan that will
 * be allowed anywhere near the stage that writes copy.
 */
type FormatSpec = {
  id: string;
  media_type: string;
  format_name: string;
  description: string;
  hook_pattern: string;
  visual_recipe: string;
  offer_placement: string | null;
  observed_count: number;
  median_days_running: number | null;
  example_ad_ids: string[];
};

type ScannedAd = {
  id: string;
  meta_ad_id: string;
  advertiser_name: string | null;
  region: string;
  media_type: string;
  days_running: number | null;
  variant_count: number | null;
  primary_text: string | null;
  headline: string | null;
  cta_label: string | null;
  landing_url: string | null;
};

type ScanSummary = {
  jobsTotal: number;
  jobsDone: number;
  jobsFailed: number;
  adsFound: number;
  adsQualified: number;
  terms: string[];
};

type Reason = {
  number: number;
  title: string;
  body: string;
  image_prompt?: string | null;
  image_url?: string | null;
};
type Testimonial = { quote: string; reviewer?: string | null; rating?: number | null };

type ProductBrief = {
  brand_name: string;
  product_name: string;
  category: string;
  one_line_summary: string;
  features: { feature: string; practical_benefit: string }[];
  price: { amount: number; currency: string; offer_structure: string };
  top_objections: string[];
  top_desires: string[];
  review_snippets: { quote: string; reviewer: string; rating: number }[];
  image_urls: string[];
  /** What the source did not say. Written by the stage, not by a failure. */
  gaps: string[];
};
type CampaignImage = {
  position: number;
  source_url: string;
  caption: string | null;
  kind: string;
  usable: boolean;
};

type BasePageView = {
  hero_headline: string;
  hero_subheadline: string | null;
  hero_image_url: string | null;
  reasons: Reason[];
  testimonials: Testimonial[] | null;
  offer_headline: string;
  offer_body: string | null;
  cta_button_text: string;
  cta_url: string;
};

type CampaignView = {
  campaign: {
    id: string; title: string; slug: string; status: string;
    source_url: string | null; error_message: string | null; has_brief: boolean;
    base_page_guidance: string | null;
    /** The note left on each step, keyed by step key. */
    step_guidance: Record<string, string>;
    /** How many pages this one is writing — five for a vehicle, twenty otherwise. */
    persona_target: number | null;
    contact_phone: string | null;
  };
  base_page: BasePageView | null;
  /** Chosen photos. Empty until the picture stage runs, which is after approval. */
  images: CampaignImage[];
  /**
   * The summary every later stage is written from. Was typed as its image list
   * alone, because nothing on screen showed any other field — which was the
   * problem: it is the artefact a mistake propagates furthest from, and it had
   * never once been visible.
   */
  brief: ProductBrief | null;
  personas: Persona[];
  jobs: Job[];
  /** Enquiries from the public pages. Only ever non-empty on a phone-and-form campaign. */
  leads: Lead[];
  formats: FormatSpec[];
  /** Qualifying ads only, longest-running first, capped server-side at 120. */
  ads: ScannedAd[];
  scan: ScanSummary;
  /** Three ads per buyer, with anything generated from them attached. */
  ideas: AdIdea[];
  spend: Spend;
};

/** What KIE made from an approved idea, once it was approved. */
type GeneratedAsset = {
  id: string;
  state: 'submitted' | 'generating' | 'success' | 'fail';
  result_url: string | null;
  /** Our own copy. KIE's link expires; this one does not. */
  stored_url: string | null;
  credits_charged: number | null;
  fail_reason: string | null;
  kie_task_id: string;
  /** Which go this was. 1 for everything made before redo existed. */
  attempt: number | null;
  /** The instruction that made THIS file, frozen at submit. */
  prompt_used: string | null;
  /** Set when it was looked at and sent back. The file is kept regardless. */
  rejected_at: string | null;
  rejected_note: string | null;
};

type AdIdea = {
  id: string;
  persona_id: string;
  persona_name: string | null;
  idea_index: number;
  media_type: 'image' | 'video';
  angle: string;
  hook: string;
  headline: string;
  primary_text: string;
  cta_label: string;
  visual_concept: string;
  them_vs_us: { why_this_works?: string } | null;
  kie_prompt: string | null;
  video_storyboard: { beats?: { at_second: number; on_screen: string }[] } | null;
  est_credits: number;
  est_usd: number | string;
  destination_url: string;
  source_image_url: string | null;
  status: 'draft' | 'approved' | 'generating' | 'generated' | 'failed' | 'rejected';
  rejected_reason: string | null;
  edited_at: string | null;
  /** Which go the row is on now. 2 means one result has been sent back. */
  attempt: number | null;
  /** What was said to be wrong with the last result, in the operator's words. */
  redo_note: string | null;
  generated_assets: GeneratedAsset[];
};

type Spend = {
  total: number;
  ceiling: number;
  remaining: number;
  lines: { id: string; usd: number | string; credits: number; note: string | null; created_at: string }[];
};

type Lead = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  message: string | null;
  created_at: string;
  /** Which of the pages they were reading. Null if that page has since gone. */
  persona_name: string | null;
};

/** What the server says a redo of a step would do. Built into the dialog. */
type RedoEffects = {
  step: string;
  rebuilds: string[];
  keptAds: number;
  keptPages: number;
  minutes: string;
  trivial: boolean;
};

type AdvanceResult = {
  status: string; did: string; done: boolean; waiting: boolean; terminal: boolean;
  awaitingApproval?: boolean;
  notes?: string[];
};

const WAIT_FOR_MAC_MS = 8000;
const BETWEEN_UNITS_MS = 700;
/**
 * How often to ask KIE about a generation in flight. An image takes about a
 * minute and a ten-second video about three, so ten seconds is responsive
 * without being a hammer.
 */
const ASSET_POLL_MS = 10_000;

export function CampaignProgress({ id }: { id: string }) {
  const { api } = useSession();
  const [view, setView] = useState<CampaignView | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Survives re-renders so the loop can be told to stop when the screen goes away.
  const alive = useRef(true);
  const started = useRef(false);

  const refresh = useCallback(async () => {
    const next = await api<CampaignView>(`/api/campaigns/${id}`);
    if (alive.current) setView(next);
    return next;
  }, [api, id]);

  const drive = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      for (;;) {
        if (!alive.current) return;
        const result = await api<AdvanceResult>(`/api/campaigns/${id}/advance`, { method: 'POST' });
        if (!alive.current) return;

        setLog((l) => [...l, result.did, ...(result.notes ?? [])].slice(-40));
        await refresh();

        if (result.terminal) return;
        await sleep(result.waiting ? WAIT_FOR_MAC_MS : BETWEEN_UNITS_MS);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setRunning(false);
    }
  }, [api, id, refresh]);

  useEffect(() => {
    alive.current = true;
    if (started.current) return undefined;   // strict mode mounts twice in dev
    started.current = true;

    (async () => {
      try {
        const first = await refresh();
        // `ideas_ready` is where the built pipeline ends, not `pages_built` —
        // the scan runs on from the pages by itself. Driving a finished campaign
        // would be harmless but pointless; driving a failed one would hammer a
        // stage that needs a person.
        if (first.campaign.status !== 'ideas_ready' && first.campaign.status !== 'failed') {
          await drive();
        }
      } catch (e) {
        if (alive.current) setError((e as Error).message);
      }
    })();

    return () => { alive.current = false; };
  }, [refresh, drive]);

  async function retry() {
    setRetrying(true);
    setError(null);
    try {
      const result = await api<{ did: string }>(`/api/campaigns/${id}/retry`, { method: 'POST' });
      setLog((l) => [...l, result.did]);
      await refresh();
      await drive();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetrying(false);
    }
  }

  /** Approve or reject the base page, then let the loop carry on from the new state. */
  const decideBasePage = useCallback(
    async (action: 'approve' | 'rewrite', guidance?: string) => {
      const result = await api<{ did: string }>(`/api/campaigns/${id}/base-page`, {
        method: 'POST',
        body: JSON.stringify({ action, guidance }),
      });
      setLog((l) => [...l, result.did]);
      await refresh();
      await drive();
    },
    [api, id, refresh, drive],
  );

  /**
   * One row of the ideas table, changed. Every path back from the server ends
   * in a refresh, so what is on screen after an action is what the database
   * holds rather than what the browser guessed.
   */
  const ideaAction = useCallback(
    async (ideaId: string, init: RequestInit) => {
      const result = await api<{ did?: string }>(`/api/campaigns/${id}/ideas/${ideaId}`, init);
      if (result.did) setLog((l) => [...l, result.did as string].slice(-40));
      await refresh();
      return result;
    },
    [api, id, refresh],
  );

  /**
   * Send one step back to be done again.
   *
   * Nothing here drives the pipeline. The route rewinds the campaign and
   * returns; the loop below picks it up on its next tick and rebuilds through
   * the same stage code that built it the first time. `drive()` is called
   * afterwards only because the loop may have already stopped — a finished
   * campaign is not being driven, and a redo has to start it moving again.
   */
  const redoStep = useCallback(
    async (step: string, note: string) => {
      const result = await api<{ did: string }>(`/api/campaigns/${id}/steps/${step}`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      });
      setLog((l) => [...l, result.did].slice(-40));
      await refresh();
      await drive();
    },
    [api, id, refresh, drive],
  );

  /** What a redo of this step would rewrite, read fresh for the confirm dialog. */
  const previewRedo = useCallback(
    (step: string) => api<RedoEffects>(`/api/campaigns/${id}/steps/${step}`),
    [api, id],
  );

  // Something is being made at KIE right now.
  const inFlight = (view?.ideas ?? []).some(
    (i) => i.generated_assets.some((a) => a.state === 'submitted' || a.state === 'generating'),
  );

  /**
   * Settle finished generations while the screen is open.
   *
   * Separate from the pipeline loop on purpose: by the time anything is
   * generating the pipeline has finished, and approving is a person's act. This
   * only ever tidies up after one — polling KIE is free, and the download into
   * our own storage has to happen before KIE's temporary link expires.
   */
  useEffect(() => {
    if (!inFlight) return undefined;
    let stopped = false;
    (async () => {
      while (!stopped) {
        await sleep(ASSET_POLL_MS);
        if (stopped) return;
        try {
          await api(`/api/campaigns/${id}/assets`, { method: 'POST' });
          if (!stopped) await refresh();
        } catch {
          // Transient. The next tick asks again; nothing is lost by a missed
          // poll, because the state lives at KIE and in the database.
        }
      }
    })();
    return () => { stopped = true; };
  }, [inFlight, api, id, refresh]);

  if (!view) {
    return (
      <Shell header={<TopBar />}>
        {error ? <Callout tone="error" title="Could not open this campaign">{error}</Callout>
          : <p className="text-zinc-500">Loading…</p>}
      </Shell>
    );
  }

  const {
    campaign, personas, jobs, base_page: basePage, images, brief, leads, formats, ads, scan,
    ideas, spend,
  } = view;
  const target = campaign.persona_target ?? DEFAULT_PERSONA_TARGET;
  // A superseded page is one a redo replaced but could not delete, because ads
  // that have been paid for land on it. It is not one of this campaign's twenty
  // and must not be counted as one — but it is still live, still taking
  // traffic, and is listed separately rather than hidden.
  const livePersonas = personas.filter((p) => !p.superseded_at);
  const oldPersonas = personas.filter((p) => p.superseded_at);
  const foundPhotos = brief?.image_urls ?? [];
  const failed = campaign.status === 'failed';
  // Two different endings. The pages going live is what the operator came for
  // and happens well before the pipeline stops; `finished` is the pipeline.
  const pagesLive = ['pages_built', 'scanning', 'extracting', 'writing_ideas', 'ideas_ready']
    .includes(campaign.status);
  const finished = campaign.status === 'ideas_ready';
  const ingest = jobs.find((j) => j.kind === 'ingest');
  const scanJobs = jobs.filter((j) => j.kind === 'ad_scan');
  // Both stages that need the Mac, asked the same way. The ad scan is the one
  // more likely to be caught out by it: by then the operator has their pages and
  // has usually stopped watching.
  const waitingOnIngest = ingest?.status === 'queued' || ingest?.status === 'running';
  const waitingOnScan = scanJobs.some((j) => j.status === 'queued' || j.status === 'running');
  const waitingOnMac = !failed && !finished && (waitingOnIngest || waitingOnScan);
  // The gate is open only when the page it is gating actually exists. At
  // `base_review` with no row yet, the page is still being written.
  const awaitingApproval = campaign.status === 'base_review' && Boolean(basePage);

  const steps = buildSteps({
    status: campaign.status,
    hasBrief: campaign.has_brief,
    hasBasePage: Boolean(basePage),
    personaCount: livePersonas.length,
    personaTarget: target,
    hasSourceUrl: Boolean(campaign.source_url),
    ingestFailed: ingest?.status === 'failed',
    // Reading is finished once the campaign is off `pending` and no Mac job is
    // still outstanding. A job only exists at all when the server could not read
    // the page, so the usual case is "no job, and the read already happened".
    ingestDone: campaign.status !== 'pending' && !waitingOnIngest,
    usesMac: Boolean(ingest),
    hasImages: images.length > 0,
    imagesPlaced: (basePage?.reasons ?? []).filter((r) => r.image_url).length
      + (basePage?.hero_image_url ? 1 : 0),
    scanJobsTotal: scan.jobsTotal,
    scanJobsDone: scan.jobsDone,
    adsFound: scan.adsFound,
    adsQualified: scan.adsQualified,
    formatCount: formats.length,
    ideaCount: ideas.length,
    buyersWithIdeas: new Set(ideas.map((i) => i.persona_id)).size,
    ideasGenerated: ideas.filter((i) => i.status === 'generated').length,
  });

  return (
    <Shell header={<TopBar />}>
      <div className="mb-8">
        <Link
          href="/"
          className="text-sm font-semibold text-zinc-500 underline underline-offset-4 hover:text-accent"
        >
          ← All campaigns
        </Link>
        <h1 className="mt-4 text-5xl font-bold">{campaign.title}</h1>
        <p className="mt-3 text-lg leading-relaxed text-zinc-500">
          {finished ? `${livePersonas.length} pages are live, and the ad library has been read.`
            : failed ? 'Stopped. Nothing is lost — see below.'
              : pagesLive ? `${livePersonas.length} pages are live. Now reading Meta's ad library `
                + 'to see how ads that survive get built — this part costs nothing.'
              : awaitingApproval ? 'Waiting on you. Read the main page below and approve it.'
                : running
                  // Said plainly because it is the difference between "come back
                  // in an hour" and "come back in an hour to find nothing moved".
                  ? 'Working. Keep this tab open — the work runs from this page, so closing it '
                    + 'pauses it. Nothing is lost, and reopening carries on from where it stopped.'
                  : 'Paused. Reopen or reload this page to carry on.'}
        </p>
      </div>

      {waitingOnMac ? (
        <div className="mb-6">
          <Callout
            tone="warn"
            title={waitingOnScan ? 'The ad scan needs your Mac' : 'This shop needs your Mac'}
          >
            <p>
              {waitingOnScan
                // Not an error, unlike the ingest case. Meta serves the ad
                // library to a real browser and to nothing else, so this is how
                // this stage always works — said plainly so it does not read as
                // something having gone wrong.
                ? `${scan.jobsDone} of ${scan.jobsTotal} searches done. Meta only shows the ad `
                  + 'library to a real browser, so Chrome on your Mac is doing the reading.'
                /* The job carries the reason the server could not read it. Showing it
                   is the difference between "something went wrong" and "this shop
                   blocks robots, which is normal and expected". */
                : ingest?.notes?.replace(/^server read failed, handed to the Mac: /, '')
                  ?? 'The page could not be read from the server.'}
            </p>
            <p className="mt-2">
              {waitingOnScan
                ? 'Leave the Mac awake and the worker running. If it is not running, open '
                  + 'Terminal, paste this, and leave the window open:'
                : 'Almost every shop is read without it, but this one has to be opened in a real '
                  + 'browser. Open Terminal, paste this, and leave the window open:'}
            </p>
            <pre className="mt-2 overflow-x-auto rounded-[var(--radius-brand-card)] bg-amber-100 px-3 py-2 font-mono text-xs">
              cd ~/.buzz/REPOS/ad-assist/scanner &amp;&amp; npm start
            </pre>
            <p className="mt-2">
              A Chrome window will open by itself. That is meant to happen — leave it alone and
              this screen carries on within a few seconds.
            </p>
            {waitingOnScan ? (
              <p className="mt-2">
                {/* The one failure this stage has that a restart does not fix. Named
                    here rather than left to be discovered as six failed searches. */}
                If every search fails, that Chrome needs to be signed in to Facebook once —
                the ad library asks anonymous visitors to log in.
              </p>
            ) : null}
          </Callout>
        </div>
      ) : null}

      {failed ? (
        <div className="mb-6">
          <Callout tone="error" title="It stopped here">
            <p>{campaign.error_message ?? 'No reason was recorded.'}</p>
            <div className="mt-3">
              <Button onClick={retry} disabled={retrying}>
                {retrying ? 'Trying again…' : 'Try again'}
              </Button>
            </div>
            <p className="mt-2 text-xs">
              Trying again picks up from the last thing that worked. Nothing already written
              gets rewritten.
            </p>
          </Callout>
        </div>
      ) : null}

      {error && !failed ? (
        <div className="mb-6">
          <Callout tone="error" title="The last step did not go through">
            <p>{error}</p>
            <div className="mt-3">
              <Button onClick={drive} disabled={running}>Carry on</Button>
            </div>
          </Callout>
        </div>
      ) : null}

      {/* Rule-separated rather than spaced apart: this is the screen the comp
          draws, and its checklist is a stack of hard rules with a square
          marker on each row. */}
      <Card className="py-2 sm:py-3">
        <ol>
          {steps.map((step) => (
            <StepRow
              key={step.key}
              step={step}
              spinning={running}
              view={view}
              live={livePersonas}
              superseded={oldPersonas}
              busy={running || retrying}
              onPreview={previewRedo}
              onRedo={redoStep}
            />
          ))}
        </ol>
      </Card>

      {awaitingApproval && basePage ? (
        <BasePageReview
          page={basePage}
          slug={campaign.slug}
          target={target}
          lastGuidance={campaign.base_page_guidance}
          foundPhotos={foundPhotos}
          onDecide={decideBasePage}
        />
      ) : null}

      {/* Above the page list on purpose: once a vehicle campaign is live, the
          enquiries are the only thing on this screen worth opening it for. */}
      {leads.length ? <Leads leads={leads} /> : null}

      {/* Above the formats, because once the ideas exist they are what the
          operator opens this screen for. The formats become the evidence
          underneath them, the same way the ads are evidence for the formats. */}
      {ideas.length ? <Ideas ideas={ideas} spend={spend} onAction={ideaAction} /> : null}

      {formats.length ? <Formats formats={formats} scan={scan} /> : null}

      {ads.length ? <ScannedAds ads={ads} scan={scan} /> : null}

      {pagesLive ? <LivePages campaign={campaign} personas={livePersonas} target={target} /> : null}

      {log.length ? (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm font-semibold text-zinc-500">
            What it has done so far
          </summary>
          <ul className="mt-3 space-y-1.5 text-sm text-zinc-600">
            {log.map((line, i) => <li key={`${i}-${line}`}>· {line}</li>)}
          </ul>
        </details>
      ) : null}
    </Shell>
  );
}

/**
 * A step of the checklist, and — once it has run — a door into it.
 *
 * The row used to be a tick and two sentences. That was enough while the only
 * thing an operator could do about a step was watch it, but it left five of the
 * seven stages with no way to see what they actually produced and no way to
 * correct them: a summary that read $40 for a $40-a-month product, or a picture
 * stage that chose four shots of the packaging, could only be fixed by throwing
 * the campaign away and starting again.
 *
 * So a finished step opens. Inside is what it made, in the plainest form that
 * is still the real thing rather than a description of it, a box to say what is
 * wrong with it, and one button to have it done again.
 *
 * THE ROW IS CLOSED BY DEFAULT AND THAT IS THE POINT. Seven open panels is not
 * a progress screen. What is on screen when you arrive is still the seven-line
 * answer to "where is it up to".
 */
function StepRow({
  step, spinning, view, live, superseded, busy, onPreview, onRedo,
}: {
  step: Step;
  spinning: boolean;
  view: CampaignView;
  live: Persona[];
  superseded: Persona[];
  /** The pipeline is mid-unit. A redo is refused while it is, so say so early. */
  busy: boolean;
  onPreview: (step: string) => Promise<RedoEffects>;
  onRedo: (step: string, note: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  // Only a step that has actually produced something can be opened or sent
  // back. Before that there is nothing to look at, and "do it again" would mean
  // "do it", which the screen is already doing.
  const openable = step.state === 'done' || step.state === 'failed';

  return (
    <li className="border-t-2 border-zinc-900 first:border-t-0">
      <div className="flex gap-4 py-4">
        <Bullet state={step.state} spinning={spinning} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-4">
            <p className={`font-display text-lg font-semibold tracking-[-0.02em] ${
              step.state === 'unbuilt' ? 'text-zinc-400'
                : step.state === 'failed' ? 'text-red-700' : 'text-zinc-900'
            }`}
            >
              {step.title}
              {step.state === 'unbuilt'
                ? <span className="ml-2 align-middle text-xs font-bold uppercase tracking-wide text-zinc-400">Not built yet</span>
                : null}
            </p>
            {openable ? (
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="shrink-0 text-sm font-semibold text-accent underline underline-offset-4"
              >
                {open ? 'Close' : 'Open'}
              </button>
            ) : null}
          </div>
          <p className={`mt-1 text-sm leading-6 ${step.state === 'unbuilt' ? 'text-zinc-400' : 'text-zinc-500'}`}>
            {step.detail}
          </p>
          {!open && view.campaign.step_guidance?.[step.key] ? (
            // Visible closed, because a note that only exists behind a click is
            // one the operator writes a second time.
            <p className="mt-2 text-sm text-zinc-500">
              <span className="font-semibold text-zinc-900">Your note:</span>{' '}
              {view.campaign.step_guidance[step.key]}
            </p>
          ) : null}
        </div>
      </div>

      {open ? (
        <div className="mb-5 ml-10 border-l-2 border-zinc-200 pl-5">
          <StepOutput step={step.key} view={view} live={live} superseded={superseded} />
          <RedoBox
            stepKey={step.key}
            lastNote={step.key === 'base'
              ? view.campaign.base_page_guidance
              : view.campaign.step_guidance?.[step.key] ?? null}
            busy={busy}
            onPreview={onPreview}
            onRedo={onRedo}
          />
        </div>
      ) : null}
    </li>
  );
}

/**
 * What the step actually produced.
 *
 * Every one of these renders a real artefact rather than a count of it. A line
 * saying "20 pages written" is what the closed row already says; the reason to
 * open it is to read the words that went onto them.
 */
function StepOutput({
  step, view, live, superseded,
}: { step: string; view: CampaignView; live: Persona[]; superseded: Persona[] }) {
  const { campaign, brief, base_page: basePage, images, formats, scan, ideas, jobs } = view;

  if (step === 'read') {
    const ingest = jobs.find((j) => j.kind === 'ingest');
    return (
      <Panel>
        <Detail label="Read from">
          {campaign.source_url
            ? <a href={campaign.source_url} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-4">{campaign.source_url}</a>
            : 'What you typed in, rather than a web page.'}
        </Detail>
        <Detail label="How">
          {ingest
            ? 'A real Chrome window on your Mac — this shop refuses a plain request.'
            : 'Straight off the page from the server. No browser, nothing running on your machine.'}
        </Detail>
        <Detail label="Photographs found">{brief?.image_urls?.length ?? 0}</Detail>
        <Detail label="Customer reviews found">{brief?.review_snippets?.length ?? 0}</Detail>
        {ingest?.notes ? <Detail label="Note from the read">{ingest.notes}</Detail> : null}
        {/* Said rather than quietly omitted: the raw read is genuinely not on
            this screen, and an operator hunting for it should be told why
            instead of concluding the step did nothing. */}
        <p className="mt-3 text-sm leading-6 text-zinc-500">
          The page itself is not shown here — it is up to a few hundred KB of raw
          markup and would drown everything else. What it came to is the summary
          in the next step, which is the thing worth checking.
        </p>
      </Panel>
    );
  }

  if (step === 'brief') {
    if (!brief) return <Empty>No summary has been written yet.</Empty>;
    return (
      <Panel>
        <Detail label="Product">{brief.brand_name ? `${brief.brand_name} — ` : ''}{brief.product_name}</Detail>
        <Detail label="In one line">{brief.one_line_summary}</Detail>
        <Detail label="Price">
          {brief.price?.amount
            ? `${brief.price.currency || ''} ${brief.price.amount}`.trim()
            : 'The page never said.'}
          {brief.price?.offer_structure ? ` — ${brief.price.offer_structure}` : ''}
        </Detail>
        <Detail label={`Features (${brief.features?.length ?? 0})`}>
          <ul className="space-y-1">
            {(brief.features ?? []).map((f) => (
              <li key={f.feature}>
                <span className="font-semibold text-zinc-900">{f.feature}</span> — {f.practical_benefit}
              </li>
            ))}
          </ul>
        </Detail>
        {brief.top_objections?.length ? (
          <Detail label="What makes a buyer hesitate">{brief.top_objections.join(' · ')}</Detail>
        ) : null}
        {brief.top_desires?.length ? (
          <Detail label="What buyers say they wanted">{brief.top_desires.join(' · ')}</Detail>
        ) : null}
        <Detail label={`Real review quotes (${brief.review_snippets?.length ?? 0})`}>
          {brief.review_snippets?.length ? (
            <ul className="space-y-1">
              {brief.review_snippets.slice(0, 8).map((r) => (
                <li key={r.quote}>“{r.quote}”{r.reviewer ? ` — ${r.reviewer}` : ''}</li>
              ))}
            </ul>
          ) : 'None found. Every page ships without testimonials rather than with invented ones.'}
        </Detail>
        {brief.gaps?.length ? (
          // The stage's own account of what it could not find. Surfacing it is
          // most of the value of opening this step at all — it is where a wrong
          // summary says so itself.
          <Detail label="What the page never said">
            <ul className="space-y-1">
              {brief.gaps.map((g) => <li key={g}>· {g}</li>)}
            </ul>
          </Detail>
        ) : null}
      </Panel>
    );
  }

  if (step === 'base') {
    if (!basePage) return <Empty>The main page has not been written yet.</Empty>;
    return (
      <Panel>
        <Detail label="Headline">{basePage.hero_headline}</Detail>
        {basePage.hero_subheadline ? <Detail label="Under it">{basePage.hero_subheadline}</Detail> : null}
        <Detail label={`Reasons (${basePage.reasons?.length ?? 0})`}>
          <ol className="space-y-2">
            {(basePage.reasons ?? []).map((r) => (
              <li key={r.number}>
                <span className="font-semibold text-zinc-900">{r.number}. {r.title}</span>
                <br />
                {r.body}
                {r.image_url ? null : (
                  <span className="text-zinc-400"> · no picture — none of your photos genuinely showed this</span>
                )}
              </li>
            ))}
          </ol>
        </Detail>
        <Detail label="The offer">{basePage.offer_headline}{basePage.offer_body ? ` — ${basePage.offer_body}` : ''}</Detail>
        <Detail label="Button">{basePage.cta_button_text} → {basePage.cta_url}</Detail>
      </Panel>
    );
  }

  if (step === 'images') {
    if (!images.length) return <Empty>No photographs have been chosen yet.</Empty>;
    const placed = new Set([
      basePage?.hero_image_url,
      ...(basePage?.reasons ?? []).map((r) => r.image_url),
    ].filter(Boolean) as string[]);
    return (
      <Panel>
        {/* The caption is the point of this panel, not the thumbnail. It is the
            only thing the stage that writes the pages ever sees of a photo, so
            a wrong caption is how a picture ends up on the wrong reason. */}
        <p className="mb-3 text-sm leading-6 text-zinc-500">
          What it wrote about each photo is all the later stages ever see of it — they
          are text-only calls and never look at a picture. A caption that is wrong is
          how a photo ends up against the wrong reason.
        </p>
        <ul className="space-y-3">
          {images.map((img) => (
            <li key={img.position} className="flex gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.source_url} alt="" className="size-16 shrink-0 object-cover" />
              <div className="min-w-0 text-sm">
                <p className="text-zinc-900">{img.caption || <span className="text-zinc-400">no caption written</span>}</p>
                <p className="mt-0.5 text-zinc-500">
                  #{img.position} · {img.kind}
                  {img.usable ? '' : ' · not usable as editorial'}
                  {placed.has(img.source_url) ? ' · on the main page' : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    );
  }

  if (step === 'pages') {
    if (!live.length && !superseded.length) return <Empty>No landing pages have been written yet.</Empty>;
    return (
      <Panel>
        <ul className="space-y-2">
          {live.map((p) => (
            <li key={p.id} className="text-sm">
              <a href={p.url} target="_blank" rel="noreferrer" className="font-semibold text-accent underline underline-offset-4">
                {p.persona_index}. {p.persona_name}
              </a>
              <br />
              <span className="text-zinc-500">{p.angle_hook}</span>
            </li>
          ))}
        </ul>
        {superseded.length ? (
          // Never hidden. These pages are still on the web and still the
          // destination of ads that have been paid for; an operator who cannot
          // see them cannot know what their traffic is landing on.
          <div className="mt-4 border-t-2 border-zinc-200 pt-3">
            <p className="text-sm font-semibold text-zinc-900">
              {superseded.length} older page{superseded.length === 1 ? '' : 's'}, still live
            </p>
            <p className="mt-1 text-sm leading-6 text-zinc-500">
              Kept because finished ads point at them. Taking them down would turn a
              running ad into a 404. They are not counted in the {live.length} above.
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {superseded.map((p) => (
                <li key={p.id}>
                  <a href={p.url} target="_blank" rel="noreferrer" className="text-zinc-500 underline underline-offset-4">
                    {p.persona_name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>
    );
  }

  if (step === 'scan') {
    if (!formats.length) {
      return (
        <Empty>
          {scan.jobsDone
            ? `${scan.adsFound} ads were read, but no repeating shape was clear enough to write `
              + 'down. Left empty rather than filled with a pattern that was not there.'
            : 'The ad library has not been read yet.'}
        </Empty>
      );
    }
    return (
      <Panel>
        <Detail label="Searched for">{scan.terms.join(' · ')}</Detail>
        <Detail label="Read">
          {scan.adsFound} ads, {scan.adsQualified} of them running between three months and a year
        </Detail>
        <Detail label={`Shapes kept (${formats.length})`}>
          <ul className="space-y-2">
            {formats.map((f) => (
              <li key={f.id}>
                <span className="font-semibold text-zinc-900">{f.format_name}</span>
                <span className="text-zinc-500"> · {f.media_type} · seen in {f.observed_count}</span>
                <br />
                {f.description}
              </li>
            ))}
          </ul>
        </Detail>
      </Panel>
    );
  }

  if (step === 'ideas') {
    if (!ideas.length) return <Empty>No ad ideas have been written yet.</Empty>;
    const made = ideas.filter((i) => i.status === 'generated').length;
    return (
      <Panel>
        <Detail label="Written">{ideas.length} ideas</Detail>
        <Detail label="Made">{made ? `${made} approved and generated` : 'None yet — nothing has been charged.'}</Detail>
        <p className="mt-3 text-sm leading-6 text-zinc-500">
          Every one of them, with its words and its picture instruction, is in the table
          further down this page. That is where a single ad is edited, approved or sent
          back — this button rewrites all of them.
        </p>
      </Panel>
    );
  }

  return null;
}

function Panel({ children }: { children: ReactNode }) {
  return <div className="mb-4 text-sm leading-6 text-zinc-600">{children}</div>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="mb-4 text-sm leading-6 text-zinc-400">{children}</p>;
}

/** Named Detail, not Field: `Field` is the form control in lib/ui. */
function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">{label}</p>
      <div className="mt-0.5 text-zinc-600">{children}</div>
    </div>
  );
}

/**
 * The note, and the button that spends it.
 *
 * TWO CLICKS, ALWAYS, and the second one is not the same word as the first.
 * Sending a step back throws away everything written from it, and on the lower
 * steps that is twenty live pages. The confirm is not a formality — it is read
 * from the server at the moment it opens, so what it lists is what will
 * actually happen rather than what this component guessed.
 */
function RedoBox({
  stepKey, lastNote, busy, onPreview, onRedo,
}: {
  stepKey: string;
  lastNote: string | null;
  busy: boolean;
  onPreview: (step: string) => Promise<RedoEffects>;
  onRedo: (step: string, note: string) => Promise<void>;
}) {
  const [note, setNote] = useState(lastNote ?? '');
  const [effects, setEffects] = useState<RedoEffects | null>(null);
  const [checking, setChecking] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The one step with no instruction behind it. Saying so is better than a box
  // that quietly does nothing with what is typed into it.
  const hasPrompt = stepKey !== 'read';

  async function check() {
    setChecking(true);
    setError(null);
    try {
      setEffects(await onPreview(stepKey));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function go() {
    setWorking(true);
    setError(null);
    try {
      await onRedo(stepKey, note);
      setEffects(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="border-t-2 border-zinc-200 pt-4">
      {hasPrompt ? (
        <>
          <label htmlFor={`note-${stepKey}`} className="text-xs font-bold uppercase tracking-wide text-zinc-400">
            What is wrong with it
          </label>
          <textarea
            id={`note-${stepKey}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Plain English. “The price is $40 a month, not $40.” “Stop choosing the packaging shots.”"
            className="mt-1 w-full border-2 border-zinc-900 p-3 text-sm leading-6 outline-none focus:border-accent"
          />
          <p className="mt-1 text-sm leading-6 text-zinc-500">
            This is added to the instruction behind this step, and stays on it — every
            future run of this step gets it too, not just the next one. Leave it empty
            to clear it and get a plain re-roll.
          </p>
        </>
      ) : (
        <p className="text-sm leading-6 text-zinc-500">
          There is no instruction behind this step — it is a download, not a piece of
          writing, so there is nothing a note could change. If what came back is wrong,
          send back the summary underneath it instead.
        </p>
      )}

      {error ? <p className="mt-3 text-sm font-semibold text-red-700">{error}</p> : null}

      {effects ? (
        <div className="mt-4 border-2 border-zinc-900 p-4">
          <p className="font-display text-base font-semibold text-zinc-900">
            This will throw away and rebuild:
          </p>
          <ul className="mt-2 space-y-1 text-sm leading-6 text-zinc-600">
            {effects.rebuilds.map((r) => <li key={r}>· {r}</li>)}
          </ul>
          {effects.keptAds ? (
            <p className="mt-3 text-sm leading-6 text-zinc-600">
              <span className="font-semibold text-zinc-900">
                Nothing you have paid for is deleted.
              </span>{' '}
              {effects.keptAds} finished ad{effects.keptAds === 1 ? '' : 's'} stay
              {effects.keptAds === 1 ? 's' : ''} exactly where {effects.keptAds === 1 ? 'it is' : 'they are'},
              marked as made from an older version
              {effects.keptPages
                ? `, and the ${effects.keptPages} page${effects.keptPages === 1 ? '' : 's'} `
                  + `${effects.keptPages === 1 ? 'it points' : 'they point'} at stay live so no `
                  + 'running ad lands on a dead link'
                : ''}.
            </p>
          ) : null}
          <p className="mt-3 text-sm leading-6 text-zinc-600">
            Takes {effects.minutes}. It costs tokens and nothing else — no ad is
            generated and nothing is charged until you approve a row in the ideas table.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button onClick={go} disabled={working}>
              {working ? 'Sending it back…' : 'Yes, do it again'}
            </Button>
            <Button variant="ghost" onClick={() => setEffects(null)} disabled={working}>
              Leave it alone
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <Button variant="ghost" onClick={check} disabled={busy || checking}>
            {checking ? 'Checking…' : busy ? 'Wait for it to stop first' : 'Do this step again'}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Square, not round, and blue rather than green when it is done — both the
 * comp's. It spends its one accent colour on "this finished", which is the
 * thing anybody watching this screen is looking for.
 */
function Bullet({ state, spinning }: { state: StepState; spinning: boolean }) {
  const base = 'mt-1 flex size-6 shrink-0 items-center justify-center text-sm font-bold';
  if (state === 'done') return <span className={`${base} bg-accent text-white`}>✓</span>;
  if (state === 'failed') return <span className={`${base} bg-red-600 text-white`}>!</span>;
  if (state === 'active') {
    return (
      <span className={`${base} bg-zinc-900 text-white`}>
        <span className={spinning ? 'animate-pulse' : undefined}>•</span>
      </span>
    );
  }
  return <span className={`${base} bg-zinc-200 text-zinc-400`}>·</span>;
}

/**
 * The approval checkpoint.
 *
 * Shows the whole page as text rather than only a link to it. Two reasons: the
 * live route is cached for 60 seconds, so a page just rewritten can render stale
 * for a minute — approving a version you are not looking at is the exact failure
 * this gate exists to prevent — and reasons 4 to 10 are the thing being
 * approved, so they have to be readable without leaving the screen.
 */
function BasePageReview({
  page, slug, target, lastGuidance, foundPhotos, onDecide,
}: {
  page: BasePageView;
  slug: string;
  /** How many pages this campaign is writing. Five for a vehicle. */
  target: number;
  lastGuidance: string | null;
  foundPhotos: string[];
  onDecide: (action: 'approve' | 'rewrite', guidance?: string) => Promise<void>;
}) {
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState<null | 'approve' | 'rewrite'>(null);
  const [error, setError] = useState<string | null>(null);
  const testimonials = page.testimonials ?? [];

  async function run(action: 'approve' | 'rewrite') {
    setBusy(action);
    setError(null);
    try {
      await onDecide(action, action === 'rewrite' ? guidance : undefined);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="mt-6">
      <Card>
        <h2 className="text-xl font-bold">Read this before the {target}</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-500">
          Reasons 4 to 10 below are copied onto every one of the {target} pages,
          word for word. Only the headline and reasons 1 to 3 change per buyer. So if
          something here is wrong, it is wrong {target} times — this is the cheap
          place to catch it.
        </p>

        {lastGuidance ? (
          <p className="mt-3 rounded-[var(--radius-brand-card)] bg-zinc-100 px-4 py-3 text-sm text-zinc-600">
            Rewritten with your note: “{lastGuidance}”
          </p>
        ) : null}

        {!testimonials.length ? (
          <div className="mt-4">
            <Callout tone="warn" title="No customer reviews were found">
              Every one of the {target} pages will ship with no proof section. If the
              product page has reviews on it, send this back, then point the campaign at that
              page rather than the home page.
            </Callout>
          </div>
        ) : null}

        {/* The pictures have deliberately not been chosen yet — the words are what
            is being approved here. Showing what WILL be available, and where it
            will go, is the difference between "this page is bare" and "this page
            is not finished yet". The first run shipped without either. */}
        <div className="mt-4">
          {foundPhotos.length ? (
            <Callout tone="info" title={`${foundPhotos.length} photos found on your site`}>
              <p>
                Nothing has been placed yet. Approve this page and each of the ten reasons
                below gets the photo that genuinely shows what it claims — a reason none of
                them fits keeps its empty slot rather than borrowing an unrelated picture.
                No pictures are generated and nothing is charged.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {foundPhotos.slice(0, 16).map((url) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={url}
                    src={url}
                    alt=""
                    loading="lazy"
                    className="size-14 rounded-[var(--radius-brand-card)] border border-black/10 object-cover"
                  />
                ))}
              </div>
            </Callout>
          ) : (
            <Callout tone="warn" title="No photos were found on your page">
              All {target} pages will be text only. Nothing here invents a picture, so
              if the pages need images, point the campaign at a page that has product photos
              on it.
            </Callout>
          )}
        </div>

        <div className="mt-6 space-y-5 border-t border-zinc-200 pt-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">Headline</p>
            <p className="mt-1 text-lg font-bold text-zinc-900">{page.hero_headline}</p>
            {page.hero_subheadline
              ? <p className="mt-1 text-sm leading-6 text-zinc-600">{page.hero_subheadline}</p>
              : null}
          </div>

          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">
              The ten reasons
            </p>
            <ol className="mt-2 space-y-3">
              {page.reasons.map((r) => (
                <li key={r.number} className="flex gap-3">
                  <span
                    className={`mt-0.5 w-6 shrink-0 text-sm font-bold ${
                      r.number <= 3 ? 'text-zinc-400' : 'text-zinc-900'
                    }`}
                  >
                    {r.number}
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold text-zinc-900">
                      {r.title}
                      {r.number <= 3 ? (
                        <span className="ml-2 align-middle text-xs font-bold uppercase tracking-wide text-zinc-400">
                          swapped per buyer
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-sm leading-6 text-zinc-600">{r.body}</p>
                    {/* The slot, named. What goes here is decided after approval,
                        so what is shown is what the copy says it should be. */}
                    {r.image_prompt?.trim() ? (
                      <p className="mt-2 rounded-[var(--radius-brand-card)] border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-500">
                        <span className="font-bold uppercase tracking-wide text-zinc-400">
                          Picture slot ·{' '}
                        </span>
                        {r.image_prompt}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {testimonials.length ? (
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">
                Real reviews used as proof
              </p>
              <ul className="mt-2 space-y-2">
                {testimonials.map((t) => (
                  <li key={t.quote} className="border-l-2 border-zinc-300 pl-3 text-sm leading-6 text-zinc-600">
                    “{t.quote}”
                    {t.reviewer ? <span className="text-zinc-400"> — {t.reviewer}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">The offer</p>
            <p className="mt-1 font-semibold text-zinc-900">{page.offer_headline}</p>
            {page.offer_body
              ? <p className="mt-0.5 text-sm leading-6 text-zinc-600">{page.offer_body}</p>
              : null}
            <p className="mt-2 text-sm text-zinc-500">
              Button reads “{page.cta_button_text}” and goes to{' '}
              <span className="break-all font-mono text-xs">{page.cta_url}</span>
            </p>
          </div>
        </div>

        <div className="mt-6 border-t border-zinc-200 pt-6">
          <Field
            label="Something to change?"
            help="Leave this empty to approve it as written. Fill it in and send it back, and the
                  next attempt is written against your note rather than rerolled."
          >
            <textarea
              className={inputClass}
              rows={3}
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              placeholder="e.g. reason 6 is about delivery times we do not promise — drop it"
            />
          </Field>

          {error ? (
            <div className="mt-4">
              <Callout tone="error" title="That did not go through">{error}</Callout>
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={() => run('approve')} disabled={busy !== null}>
              {busy === 'approve'
                ? 'Starting the pages…'
                : `Approve and write the ${target} pages`}
            </Button>
            <Button variant="ghost" onClick={() => run('rewrite')} disabled={busy !== null}>
              {busy === 'rewrite' ? 'Writing it again…' : 'Send it back'}
            </Button>
            <a
              href={`/p/${slug}`}
              target="_blank"
              rel="noopener"
              className="text-sm font-semibold text-zinc-500 underline hover:text-zinc-900"
            >
              See it as a page
            </a>
          </div>
          <p className="mt-3 text-xs text-zinc-400">
            Sending it back throws this version away and writes a new one. Nothing else has been
            written yet, so it costs one page, not {target}.
          </p>
        </div>
      </Card>
    </div>
  );
}

/**
 * What the scan concluded.
 *
 * Formats first and ads second, on purpose. The formats are the deliverable —
 * they are what the ad-writing stage will be built on — and the ads underneath
 * are the evidence, there so a claim on this card can be checked against the
 * thing it came from rather than taken on trust.
 */
function Formats({ formats, scan }: { formats: FormatSpec[]; scan: ScanSummary }) {
  const byMedia = (['image', 'video'] as const)
    .map((m) => ({ media: m, items: formats.filter((f) => f.media_type === m) }))
    .filter((g) => g.items.length);

  return (
    <div className="mt-6">
      <Card>
        <h2 className="text-xl font-bold">
          {formats.length} format{formats.length === 1 ? ' that keeps' : 's that keep'} working
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Read from {scan.adsQualified.toLocaleString()} ads that have been live between three
          months and a year. Run time is the only performance signal Meta publishes for
          commercial ads — no impressions, no spend — so an ad that has been live a full quarter
          is live because it pays for itself. Past a year it is usually just always-on, so those
          are left out.
        </p>
        <p className="mt-2 text-sm text-zinc-500">
          {/* The rule the whole design rests on, said where the operator can see
              it, because "you are not copying anyone" is the reassurance this
              screen most needs to give. */}
          What was kept is the <span className="font-semibold text-zinc-700">shape</span> of these
          ads, never their words. Nothing an advertiser wrote travels past this screen.
        </p>

        {byMedia.map((group) => (
          <div key={group.media} className="mt-6">
            <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400">
              {group.media === 'image' ? 'Statics' : 'Video'}
            </h3>
            <ul className="mt-3 space-y-4">
              {group.items.map((f) => (
                <li key={f.id} className="rounded-[var(--radius-brand-card)] border border-zinc-200 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="font-semibold text-zinc-900">{f.format_name}</p>
                    <p className="text-xs text-zinc-500">
                      seen in {f.observed_count} ad{f.observed_count === 1 ? '' : 's'}
                      {f.median_days_running != null
                        ? ` · running ${f.median_days_running} days on average` : ''}
                    </p>
                  </div>
                  <p className="mt-2 text-sm text-zinc-600">{f.description}</p>

                  <dl className="mt-3 space-y-2 text-sm">
                    <div>
                      <dt className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                        How it opens
                      </dt>
                      <dd className="text-zinc-700">{f.hook_pattern}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                        What is on screen
                      </dt>
                      <dd className="text-zinc-700">{f.visual_recipe}</dd>
                    </div>
                    {f.offer_placement ? (
                      <div>
                        <dt className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                          Where the offer sits
                        </dt>
                        <dd className="text-zinc-700">{f.offer_placement}</dd>
                      </div>
                    ) : null}
                  </dl>

                  {group.media === 'video' ? (
                    // Stated rather than left as an absence. A blank field reads
                    // as an oversight; a sentence saying what is missing and why
                    // reads as a limit, which is what it is.
                    <p className="mt-3 text-xs text-zinc-400">
                      Pacing — cut count, shot length, where the hook ends — is not here. Those are
                      measurements taken from the video file, and nothing downloads the videos yet.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Card>
    </div>
  );
}

/** The evidence underneath the formats. Browsable, deliberately not summarised. */
function ScannedAds({ ads, scan }: { ads: ScannedAd[]; scan: ScanSummary }) {
  return (
    <div className="mt-6">
      <details className="group">
        <summary className="cursor-pointer text-sm font-semibold text-zinc-500 hover:text-zinc-900">
          See the {scan.adsQualified.toLocaleString()} ads these came from
        </summary>
        <Card className="mt-3">
          <p className="text-sm text-zinc-500">
            Every ad here is live now and has been for between 90 days and a year.
            {scan.adsFound > scan.adsQualified ? (
              <> Another {(scan.adsFound - scan.adsQualified).toLocaleString()} were read and did
                not make that bar.</>
            ) : null}
            {ads.length < scan.adsQualified ? (
              // Never a silent truncation: a list that stops at 120 while the
              // heading says 400 has to say which it is showing.
              <> Showing the {ads.length} longest-running.</>
            ) : null}
          </p>
          {scan.terms.length ? (
            <p className="mt-2 text-sm text-zinc-500">
              Searched for: {scan.terms.map((t) => `“${t}”`).join(', ')}. These are phrases that
              turn up inside direct-response ads whatever they sell — the scan is looking for
              structure, not for your competitors.
            </p>
          ) : null}

          <ul className="mt-5 divide-y divide-zinc-200 border-t border-zinc-200">
            {ads.map((ad) => (
              <li key={ad.id} className="py-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <p className="font-semibold text-zinc-900">
                    {ad.advertiser_name ?? 'Advertiser not named on the card'}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {ad.region} · {ad.media_type === 'image' ? 'static' : 'video'}
                    {ad.days_running != null ? ` · ${ad.days_running} days` : ''}
                    {ad.variant_count && ad.variant_count > 1
                      ? ` · ${ad.variant_count} variants` : ''}
                  </p>
                </div>
                {ad.headline ? (
                  <p className="mt-1 text-sm font-medium text-zinc-800">{ad.headline}</p>
                ) : null}
                {ad.primary_text ? (
                  <p className="mt-1 line-clamp-3 text-sm text-zinc-600">{ad.primary_text}</p>
                ) : null}
                <p className="mt-1 text-xs text-zinc-400">
                  {ad.cta_label ? `${ad.cta_label} · ` : ''}
                  <a
                    href={`https://www.facebook.com/ads/library/?id=${ad.meta_ad_id}`}
                    target="_blank"
                    rel="noopener"
                    className="underline hover:text-zinc-700"
                  >
                    See it in Meta&rsquo;s library
                  </a>
                </p>
              </li>
            ))}
          </ul>
        </Card>
      </details>
    </div>
  );
}

function Leads({ leads }: { leads: Lead[] }) {
  return (
    <div className="mt-6">
      <Card>
        <h2 className="text-xl font-bold">
          {leads.length} enquir{leads.length === 1 ? 'y' : 'ies'}
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          From the form on the live pages. The page each one was reading is named, because
          that is what tells you which angle is doing the work.
        </p>

        <ul className="mt-6 divide-y divide-zinc-200 border-t border-zinc-200">
          {leads.map((l) => (
            <li key={l.id} className="py-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <p className="font-semibold text-zinc-900">{l.name}</p>
                <a href={`tel:${l.phone.replace(/[^\d+]/g, '')}`} className="text-zinc-700 underline">
                  {l.phone}
                </a>
                {l.email ? <span className="text-sm text-zinc-500">{l.email}</span> : null}
                <span className="ml-auto text-xs text-zinc-400">
                  {new Date(l.created_at).toLocaleString()}
                </span>
              </div>
              {l.message ? (
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-700">
                  {l.message}
                </p>
              ) : null}
              <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                {l.persona_name ?? 'the main page'}
              </p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function LivePages({
  campaign, personas, target,
}: { campaign: { slug: string }; personas: Persona[]; target: number }) {
  const allLinks = personas.map((p) => p.url).join('\n');
  return (
    <div className="mt-6">
      <Card>
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">Your {personas.length} pages</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Each link is a real page, live right now. Put one link in one ad, so you find out
              which buyer responds.
            </p>
          </div>
          <CopyButton text={allLinks} label="Copy all" />
        </div>

        <ul className="mt-6 divide-y divide-zinc-200 border-t border-zinc-200">
          {personas.map((p) => (
            <li key={p.slug} className="flex items-start gap-4 py-4">
              <span className="w-6 shrink-0 pt-0.5 text-sm font-bold text-zinc-400">
                {p.persona_index}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-zinc-900">{p.persona_name}</p>
                <p className="mt-0.5 text-sm text-zinc-500">{p.angle_hook}</p>
                <a
                  href={p.url}
                  target="_blank"
                  rel="noopener"
                  className="mt-1 block truncate text-sm text-zinc-400 underline hover:text-zinc-900"
                >
                  {p.url}
                </a>
              </div>
              <CopyButton text={p.url} />
            </li>
          ))}
        </ul>

        {personas.length < target ? (
          <div className="mt-6">
            <Callout tone="warn">
              {personas.length} pages, not {target}. The run stopped early rather than
              ship near-identical pages — it may not support {target} genuinely
              different buyers.
            </Callout>
          </div>
        ) : null}

        <div className="mt-6">
          <Callout tone="info" title="What these are for">
            Each page is the destination of that buyer&rsquo;s ads — the ideas table above points
            every one of them here by default. The view and click counts start the moment
            somebody lands, so the pages tell you which angle is working even before an ad
            is made.
          </Callout>
        </div>
      </Card>
      <p className="mt-3 text-sm text-zinc-500">
        Campaign address: <code className="font-mono">/p/{campaign.slug}/…</code>
      </p>
    </div>
  );
}

/**
 * The ideas table — the last screen in the app, and the only one with a button
 * that spends money.
 *
 * Everything about how this reads follows from that. The price is on the button
 * rather than in a tooltip; what has been spent and what is left sits at the
 * top rather than at the bottom; and every row says what it will cost BEFORE it
 * is approved, because the operator is deciding sixty times, not once.
 *
 * Editing is inline and covers every field that gets pasted into Ads Manager.
 * These are not suggestions to be taken or left — they are drafts, and the last
 * word on the wording belongs to the person whose product it is.
 */
function Ideas({
  ideas, spend, onAction,
}: {
  ideas: AdIdea[];
  spend: Spend;
  onAction: (ideaId: string, init: RequestInit) => Promise<{ did?: string }>;
}) {
  // Grouped in the order they arrive, which the server has already put in buyer
  // order. Rebuilding the order here would be a second opinion about it.
  const groups: { personaId: string; name: string; items: AdIdea[] }[] = [];
  for (const idea of ideas) {
    const last = groups[groups.length - 1];
    if (last && last.personaId === idea.persona_id) last.items.push(idea);
    else {
      groups.push({
        personaId: idea.persona_id,
        name: idea.persona_name ?? 'a buyer whose page has since gone',
        items: [idea],
      });
    }
  }

  const waiting = ideas.filter((i) => i.status === 'draft');
  const made = ideas.filter((i) => i.status === 'generated');
  const running = ideas.filter((i) => i.status === 'generating' || i.status === 'approved');
  const outstanding = waiting.reduce((n, i) => n + Number(i.est_usd), 0);

  return (
    <div className="mt-6">
      <Card>
        <h2 className="text-xl font-bold">
          {ideas.length} ad idea{ideas.length === 1 ? '' : 's'}
        </h2>
        <p className="mt-1 text-sm leading-6 text-zinc-500">
          Each one is built on one of the formats below and points at that buyer&rsquo;s own
          page. Every field can be rewritten before you approve it — these get pasted into Ads
          Manager by you, so the wording is yours.
        </p>
        <p className="mt-2 text-sm leading-6 text-zinc-500">
          <span className="font-semibold text-zinc-700">Nothing has been made and nothing has
            been charged</span>{' '}
          until you press Approve on a row. That is the only button in this app that spends money.
        </p>

        <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Waiting on you" value={String(waiting.length)} />
          <Stat label="Being made" value={String(running.length)} />
          <Stat label="Made" value={String(made.length)} />
          <Stat
            label="Spent"
            value={`$${spend.total.toFixed(2)}`}
            sub={`of $${spend.ceiling.toFixed(2)}`}
          />
        </dl>

        {outstanding > spend.remaining ? (
          <div className="mt-4">
            <Callout tone="warn" title="Approving everything would pass the ceiling">
              The {waiting.length} ideas still waiting would cost ${outstanding.toFixed(2)} and
              there is ${spend.remaining.toFixed(2)} left under the ${spend.ceiling.toFixed(2)}{' '}
              ceiling. Nothing breaks — approvals are refused once it is reached, one at a time,
              and nothing is half-charged.
            </Callout>
          </div>
        ) : null}

        {/* Collapsed, because it is a reference rather than a step: you want it the
            first time you paste a row into Ads Manager and never again. Built by
            scripts/build-ad-field-map.py. */}
        <details className="mt-5">
          <summary className="cursor-pointer text-sm font-semibold text-zinc-500 hover:text-zinc-900">
            Which field is which in Ads Manager
          </summary>
          <p className="mt-2 text-sm leading-6 text-zinc-500">
            A real ad with every slot labelled. The two things worth knowing before you paste:
            the whole block above the picture is <span className="font-semibold text-zinc-700">one
            field</span>, and Meta&rsquo;s description line{' '}
            <span className="font-semibold text-zinc-700">is not written here</span> — leave it
            empty or write your own.
          </p>
          {/* Opens full size in a tab: the key under the ad is small at this width,
              and the whole point of the panel is being able to read it. */}
          <a href="/ad-field-map.png" target="_blank" rel="noopener" className="mt-3 block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/ad-field-map.png"
              alt="A Facebook ad with its primary text, picture, display link, headline,
                description and button each boxed and numbered, and a key explaining which part of
                an ad idea fills each one."
              width={974}
              height={1292}
              loading="lazy"
              className="w-full max-w-[640px] rounded-[var(--radius-brand-card)] border border-black/10"
            />
            <span className="mt-1 block text-xs text-zinc-400">Open full size</span>
          </a>
        </details>
      </Card>

      {groups.map((group) => (
        <div key={group.personaId} className="mt-4">
          <h3 className="mb-2 px-1 text-xs font-bold uppercase tracking-wider text-zinc-400">
            {group.name}
          </h3>
          <div className="space-y-3">
            {group.items.map((idea) => (
              <IdeaRow key={idea.id} idea={idea} onAction={onAction} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[var(--radius-brand-card)] bg-zinc-50 px-4 py-3 ring-1 ring-zinc-200">
      <dt className="font-display text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
        {label}
      </dt>
      <dd className="font-display mt-1 text-2xl font-bold tracking-[-0.03em] text-zinc-900">
        {value}
        {sub ? <span className="ml-1 text-sm font-medium text-zinc-400">{sub}</span> : null}
      </dd>
    </div>
  );
}

const STATUS_PILL: Record<AdIdea['status'], { label: string; className: string }> = {
  draft: { label: 'Waiting on you', className: 'bg-zinc-100 text-zinc-600' },
  approved: { label: 'Approved', className: 'bg-accent-tint text-accent-deep' },
  generating: { label: 'Being made', className: 'bg-accent-tint text-accent-deep' },
  generated: { label: 'Made', className: 'bg-accent text-white' },
  failed: { label: 'Failed', className: 'bg-red-100 text-red-800' },
  rejected: { label: 'Sent back', className: 'bg-amber-100 text-amber-900' },
};

function IdeaRow({
  idea, onAction,
}: { idea: AdIdea; onAction: (ideaId: string, init: RequestInit) => Promise<{ did?: string }> }) {
  const [editing, setEditing] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const [redoNote, setRedoNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    headline: idea.headline,
    primary_text: idea.primary_text,
    cta_label: idea.cta_label,
    kie_prompt: idea.kie_prompt ?? '',
    destination_url: idea.destination_url,
  });

  // Every file this idea has produced, oldest first. A rejected one is kept
  // rather than replaced: it was paid for, and it is what the next attempt is
  // being judged against.
  const finished = idea.generated_assets
    .filter((a) => a.state === 'success')
    .sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1));
  const rejectedAttempts = finished.filter((a) => a.rejected_at);
  const asset = finished.find((a) => !a.rejected_at)
    ?? idea.generated_assets[idea.generated_assets.length - 1];
  const fileUrl = asset && !asset.rejected_at
    ? asset.stored_url ?? asset.result_url ?? null
    : null;
  const pill = STATUS_PILL[idea.status] ?? STATUS_PILL.draft;
  const cost = Number(idea.est_usd);
  const attempt = Math.max(1, Number(idea.attempt ?? 1));
  const canRedo = idea.status === 'generated' || idea.status === 'failed';

  /**
   * Open the editor on what the row says RIGHT NOW.
   *
   * `draft` is seeded once at mount, and the row's fields move underneath it —
   * the screen polls, and a redo rewrites `kie_prompt` outright. Opening the
   * editor on the mount-time copy would show the operator the instruction that
   * was replaced, and saving it would silently undo the revision they had just
   * asked for.
   */
  function startEditing() {
    setDraft({
      headline: idea.headline,
      primary_text: idea.primary_text,
      cta_label: idea.cta_label,
      kie_prompt: idea.kie_prompt ?? '',
      destination_url: idea.destination_url,
    });
    setEditing(true);
  }

  async function run(label: string, init: RequestInit) {
    setBusy(label);
    setError(null);
    try {
      await onAction(idea.id, init);
      setEditing(false);
      setRedoing(false);
      setRedoNote('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const paste = [
    `Headline: ${idea.headline}`,
    '',
    idea.primary_text,
    '',
    `Button: ${idea.cta_label}`,
    `Goes to: ${idea.destination_url}`,
  ].join('\n');

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-[var(--radius-brand-card)] bg-zinc-900 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white">
          {idea.media_type === 'image' ? 'Static' : 'Video'}
        </span>
        <span className={`rounded-[var(--radius-brand-card)] px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${pill.className}`}>
          {pill.label}
        </span>
        {idea.edited_at ? (
          <span className="rounded-[var(--radius-brand-card)] bg-zinc-100 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-zinc-500">
            Your words
          </span>
        ) : null}
        <span className="ml-auto text-xs text-zinc-400">{idea.angle}</span>
      </div>

      {editing ? (
        <div className="mt-4 space-y-4">
          <Field label="Headline" help="Truncates around 40 characters on a phone.">
            <input
              className={inputClass}
              value={draft.headline}
              onChange={(e) => setDraft({ ...draft, headline: e.target.value })}
            />
          </Field>
          <Field label="Primary text" help="Everything before the first line break is what shows before “See more”.">
            <textarea
              className={inputClass}
              rows={6}
              value={draft.primary_text}
              onChange={(e) => setDraft({ ...draft, primary_text: e.target.value })}
            />
          </Field>
          <Field label="Button" help="Ads Manager only offers these.">
            <select
              className={inputClass}
              value={draft.cta_label}
              onChange={(e) => setDraft({ ...draft, cta_label: e.target.value })}
            >
              {CTA_LABELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field
            label={idea.media_type === 'image' ? 'Picture instruction' : 'Video instruction'}
            help={idea.media_type === 'image'
              ? 'What to change about your photograph. The product itself is never redrawn — it '
                + 'is a photo of a real thing somebody will be sent.'
              : 'One continuous ten-second move that starts on your photograph. There is no '
                + 'cutting, so this is one shot.'}
          >
            <textarea
              className={inputClass}
              rows={5}
              value={draft.kie_prompt}
              onChange={(e) => setDraft({ ...draft, kie_prompt: e.target.value })}
            />
          </Field>
          <Field label="Where the ad goes" help="Their own landing page by default. Change it to send this one ad somewhere else.">
            <input
              className={inputClass}
              value={draft.destination_url}
              onChange={(e) => setDraft({ ...draft, destination_url: e.target.value })}
            />
          </Field>
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={busy !== null}
              onClick={() => run('save', { method: 'PATCH', body: JSON.stringify(draft) })}
            >
              {busy === 'save' ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-3 text-lg font-bold leading-snug text-zinc-900">{idea.headline}</p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-700">
            {idea.primary_text}
          </p>
          <p className="mt-3 text-sm text-zinc-500">
            Button <span className="font-semibold text-zinc-700">{idea.cta_label}</span> →{' '}
            <a
              href={idea.destination_url}
              target="_blank"
              rel="noopener"
              className="break-all underline hover:text-zinc-900"
            >
              {idea.destination_url}
            </a>
          </p>

          <div className="mt-4 flex items-start gap-4">
            {idea.source_image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={idea.source_image_url}
                alt=""
                loading="lazy"
                className="size-20 shrink-0 rounded-[var(--radius-brand-card)] border border-black/10 object-cover"
              />
            ) : null}
            <div className="min-w-0 text-sm leading-6 text-zinc-600">
              <p>{idea.visual_concept}</p>
              {!idea.source_image_url ? (
                <p className="mt-1 text-xs font-semibold text-amber-700">
                  No photograph was chosen for this one, so it cannot be made until you point it
                  at one. The words are still usable.
                </p>
              ) : null}
            </div>
          </div>

          {/* Open by default once a result has been sent back. The panel below
              tells the operator to read the instruction before approving, and a
              collapsed <details> makes that an instruction to go looking — on
              the one row where the wording has just changed underneath them. */}
          <details className="mt-3" open={idea.status === 'draft' && attempt > 1}>
            <summary className="cursor-pointer text-sm font-semibold text-zinc-500 hover:text-zinc-900">
              {idea.status === 'draft' && attempt > 1
                ? 'The rewritten instruction'
                : `The instruction that makes the ${idea.media_type === 'image' ? 'picture' : 'video'}`}
            </summary>
            <p className="mt-2 whitespace-pre-wrap rounded-[var(--radius-brand-card)] bg-zinc-50 px-4 py-3 font-mono text-xs leading-5 text-zinc-600">
              {idea.kie_prompt}
            </p>
            {idea.video_storyboard?.beats?.length ? (
              <>
                {/* The beats were written for the FIRST instruction and are never
                    rewritten, because they are a note on the plan rather than
                    anything sent to the model. Once the instruction has been
                    revised they can contradict it outright — so they are labelled
                    rather than left to look current. */}
                {attempt > 1 ? (
                  <p className="mt-2 text-xs font-semibold text-amber-700">
                    Written for attempt 1. The instruction above has changed since; where the
                    two disagree, the instruction is what runs.
                  </p>
                ) : null}
                <ul className="mt-2 space-y-1 text-xs text-zinc-500">
                  {idea.video_storyboard.beats.map((b) => (
                    <li key={`${b.at_second}-${b.on_screen}`}>
                      <span className="font-mono font-bold text-zinc-400">{b.at_second}s</span>{' '}
                      {b.on_screen}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {idea.them_vs_us?.why_this_works ? (
              <p className="mt-2 text-xs leading-5 text-zinc-500">
                <span className="font-bold uppercase tracking-wide text-zinc-400">Why this one · </span>
                {idea.them_vs_us.why_this_works}
              </p>
            ) : null}
          </details>
        </>
      )}

      {fileUrl ? (
        <div className="mt-4">
          {(asset?.attempt ?? 1) > 1 ? (
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-400">
              Attempt {asset?.attempt}
            </p>
          ) : null}
          {idea.media_type === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileUrl} alt={idea.visual_concept} className="w-full rounded-[var(--radius-brand-card)] border border-black/10" />
          ) : (
            <video src={fileUrl} controls playsInline className="w-full rounded-[var(--radius-brand-card)] border border-black/10" />
          )}
          <p className="mt-2 text-xs text-zinc-400">
            {asset?.credits_charged != null
              ? `Charged ${asset.credits_charged} credits.`
              : 'Charged at the estimate.'}{' '}
            {asset?.stored_url
              ? 'Stored in your own bucket, so this link does not expire.'
              : 'This is KIE\'s temporary link — save the file, it expires in a few days.'}{' '}
            <a href={fileUrl} download target="_blank" rel="noopener" className="underline hover:text-zinc-700">
              Download
            </a>
          </p>
          {idea.media_type === 'video' ? (
            // The known failure mode, said where it can be acted on. A ten-second
            // generation is long enough for the model to lose the object, and it
            // loses it at the END — which is the part nobody watches twice.
            <p className="mt-1 text-xs text-zinc-400">
              Watch the last second before you post it. Ten seconds is long enough for the
              model to drift off the product; if it has, send it back and say so.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Rejected attempts are kept, not replaced. Two reasons: they were paid
          for, and the only way to tell whether a note actually worked is to be
          able to look at the one before it. */}
      {rejectedAttempts.length ? (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-semibold text-zinc-500 hover:text-zinc-900">
            {rejectedAttempts.length} earlier attempt{rejectedAttempts.length === 1 ? '' : 's'} you
            sent back
          </summary>
          <div className="mt-3 space-y-4">
            {rejectedAttempts.map((old) => {
              const url = old.stored_url ?? old.result_url;
              return (
                <div key={old.id} className="rounded-[var(--radius-brand-card)] bg-zinc-50 p-3 ring-1 ring-zinc-200">
                  <p className="text-xs font-bold uppercase tracking-wide text-amber-700">
                    Attempt {old.attempt ?? 1} · sent back
                  </p>
                  {old.rejected_note ? (
                    <p className="mt-1 text-sm leading-6 text-zinc-700">
                      <span className="font-semibold">You said:</span> {old.rejected_note}
                    </p>
                  ) : null}
                  {url ? (
                    idea.media_type === 'image' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={url} alt="" className="mt-2 w-full rounded-[var(--radius-brand-card)] border border-black/10 opacity-75" />
                    ) : (
                      <video src={url} controls playsInline className="mt-2 w-full rounded-[var(--radius-brand-card)] border border-black/10" />
                    )
                  ) : null}
                  {old.prompt_used ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-semibold text-zinc-400 hover:text-zinc-700">
                        The instruction that made this one
                      </summary>
                      <p className="mt-1 whitespace-pre-wrap font-mono text-xs leading-5 text-zinc-500">
                        {old.prompt_used}
                      </p>
                    </details>
                  ) : null}
                  <p className="mt-2 text-xs text-zinc-400">
                    {old.credits_charged != null
                      ? `Charged ${old.credits_charged} credits — sending it back does not refund it.`
                      : 'Charged at the estimate — sending it back does not refund it.'}
                  </p>
                </div>
              );
            })}
          </div>
        </details>
      ) : null}

      {idea.status === 'generating' || idea.status === 'approved' ? (
        <p className="mt-4 rounded-[var(--radius-brand-card)] bg-accent-tint px-4 py-3 text-sm text-accent-deep">
          Being made now — about {idea.media_type === 'image' ? 'a minute' : 'three minutes'}.
          This screen checks every ten seconds. Closing the tab does not cancel it; the file is
          collected next time you open the campaign.
        </p>
      ) : null}

      {/* After a redo the row is a draft again, and the two things that decide
          whether to approve it are what was wrong last time and what was
          changed about it. Both are shown together rather than as a warning
          strip, because nothing here has gone wrong — this is the loop working. */}
      {idea.status === 'draft' && attempt > 1 ? (
        <div className="mt-4 rounded-[var(--radius-brand-card)] bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
          <p className="text-xs font-bold uppercase tracking-wide text-amber-700">
            Attempt {attempt} — not made yet
          </p>
          {idea.redo_note ? (
            <p className="mt-1"><span className="font-semibold">You said:</span> {idea.redo_note}</p>
          ) : (
            <p className="mt-1">
              Sent back for another roll of the same instruction. These models are not
              deterministic, so the same words can give a different result.
            </p>
          )}
          {idea.rejected_reason ? (
            <p className="mt-1">
              <span className="font-semibold">What changed:</span> {idea.rejected_reason}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-amber-800">
            Read the instruction above before approving — this is the sentence that will be
            used, and approving it spends ${cost.toFixed(2)} again.
          </p>
        </div>
      ) : idea.rejected_reason ? (
        <p className="mt-4 rounded-[var(--radius-brand-card)] bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {idea.rejected_reason}
        </p>
      ) : null}

      {/* Rejecting a finished file. Two clicks and not one, because the second
          click is where the money goes and the instruction it will spend it on
          has to be on screen first. */}
      {redoing ? (
        <div className="mt-4 rounded-[var(--radius-brand-card)] bg-zinc-50 p-4 ring-1 ring-zinc-200">
          <Field
            label="What is wrong with it?"
            help={idea.media_type === 'video'
              ? 'Plain words. “The bottle turns into a flip cap by the end”, “too dark”, '
                + '“the hand blocks the label”. Leave it empty to run the same instruction '
                + 'again for a different roll.'
              : 'Plain words. “Wrong kitchen”, “the label is unreadable”, “too cluttered”. '
                + 'Leave it empty to run the same instruction again for a different roll.'}
          >
            <textarea
              className={inputClass}
              rows={3}
              value={redoNote}
              placeholder="Leave empty for another roll of the same instruction"
              onChange={(e) => setRedoNote(e.target.value)}
            />
          </Field>
          <p className="mt-2 text-sm leading-6 text-zinc-500">
            This does not spend anything. The instruction gets rewritten from what you say
            here and the row comes back as a draft, so you read the new instruction before
            approving it. The {idea.media_type === 'image' ? 'picture' : 'video'} you are
            sending back is kept — it was paid for, and it is what the next one gets compared
            against.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Button
              disabled={busy !== null}
              onClick={() => run('redo', {
                method: 'POST', body: JSON.stringify({ action: 'redo', note: redoNote }),
              })}
            >
              {busy === 'redo'
                ? (redoNote.trim() ? 'Rewriting the instruction…' : 'Sending it back…')
                : (redoNote.trim() ? 'Rewrite it and send it back' : 'Send it back as-is')}
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => setRedoing(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="mt-4">
          <Callout tone="error" title="That did not go through">{error}</Callout>
        </div>
      ) : null}

      {!editing && !redoing ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-zinc-200 pt-4">
          {idea.status === 'draft' ? (
            <>
              <Button
                disabled={busy !== null || !idea.source_image_url}
                onClick={() => run('approve', {
                  method: 'POST', body: JSON.stringify({ action: 'approve' }),
                })}
              >
                {busy === 'approve'
                  ? 'Submitting…'
                  : attempt > 1
                    ? `Approve attempt ${attempt} — $${cost.toFixed(2)}`
                    : `Approve — $${cost.toFixed(2)}`}
              </Button>
              <Button variant="ghost" disabled={busy !== null} onClick={startEditing}>
                Rewrite it
              </Button>
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() => run('reject', {
                  method: 'POST', body: JSON.stringify({ action: 'reject' }),
                })}
              >
                Send back
              </Button>
            </>
          ) : null}

          {/* The exit a finished row never had. A generated ad used to be a dead
              end — no buttons at all — which made a video that drifted in its
              last second permanent. */}
          {canRedo ? (
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setRedoing(true)}
            >
              {idea.status === 'failed' ? 'Change it and try again' : 'Not right — send it back'}
            </Button>
          ) : null}

          {idea.status === 'rejected' || idea.status === 'failed' ? (
            <>
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() => run('reset', {
                  method: 'POST', body: JSON.stringify({ action: 'reset' }),
                })}
              >
                {busy === 'reset' ? 'Putting it back…' : 'Put it back'}
              </Button>
              <Button variant="ghost" disabled={busy !== null} onClick={startEditing}>
                Rewrite it
              </Button>
            </>
          ) : null}

          <CopyButton text={paste} label="Copy for Ads Manager" />
        </div>
      ) : null}
    </Card>
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { TopBar } from '@/components/Authed';
import { useSession } from '@/components/Session';
import {
  Button, Callout, Card, CopyButton, Field, Shell, inputClass,
} from '@/components/ui';
import { buildSteps, DEFAULT_PERSONA_TARGET, type Step, type StepState } from '@/lib/campaign-steps';

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
  persona_index: number;
  slug: string;
  persona_name: string;
  angle_hook: string;
  url: string;
  views_count: number;
  clicks_count: number;
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
    /** How many pages this one is writing — five for a vehicle, twenty otherwise. */
    persona_target: number | null;
    contact_phone: string | null;
  };
  base_page: BasePageView | null;
  /** Chosen photos. Empty until the picture stage runs, which is after approval. */
  images: CampaignImage[];
  /** Every photo the ingest found, chosen or not. Available from the brief onwards. */
  brief: { image_urls?: string[] } | null;
  personas: Persona[];
  jobs: Job[];
  /** Enquiries from the public pages. Only ever non-empty on a phone-and-form campaign. */
  leads: Lead[];
  formats: FormatSpec[];
  /** Qualifying ads only, longest-running first, capped server-side at 120. */
  ads: ScannedAd[];
  scan: ScanSummary;
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

type AdvanceResult = {
  status: string; did: string; done: boolean; waiting: boolean; terminal: boolean;
  awaitingApproval?: boolean;
  notes?: string[];
};

const WAIT_FOR_MAC_MS = 8000;
const BETWEEN_UNITS_MS = 700;

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

  if (!view) {
    return (
      <Shell>
        <TopBar />
        {error ? <Callout tone="error" title="Could not open this campaign">{error}</Callout>
          : <p className="text-zinc-500">Loading…</p>}
      </Shell>
    );
  }

  const {
    campaign, personas, jobs, base_page: basePage, images, brief, leads, formats, ads, scan,
  } = view;
  const target = campaign.persona_target ?? DEFAULT_PERSONA_TARGET;
  const foundPhotos = brief?.image_urls ?? [];
  const failed = campaign.status === 'failed';
  // Two different endings. The pages going live is what the operator came for
  // and happens well before the pipeline stops; `finished` is the pipeline.
  const pagesLive = ['pages_built', 'scanning', 'extracting', 'ideas_ready']
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
    personaCount: personas.length,
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
  });

  return (
    <Shell>
      <TopBar />

      <div className="mb-8">
        <Link href="/" className="text-sm font-semibold text-zinc-500 underline hover:text-zinc-900">
          ← All campaigns
        </Link>
        <h1 className="mt-3 text-3xl font-bold tracking-tight">{campaign.title}</h1>
        <p className="mt-2 text-zinc-600">
          {finished ? `${personas.length} pages are live, and the ad library has been read.`
            : failed ? 'Stopped. Nothing is lost — see below.'
              : pagesLive ? `${personas.length} pages are live. Now reading Meta's ad library `
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
            <pre className="mt-2 overflow-x-auto rounded-md bg-amber-100 px-3 py-2 font-mono text-xs">
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

      <Card>
        <ol className="space-y-5">
          {steps.map((step) => <StepRow key={step.key} step={step} spinning={running} />)}
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

      {formats.length ? <Formats formats={formats} scan={scan} /> : null}

      {ads.length ? <ScannedAds ads={ads} scan={scan} /> : null}

      {pagesLive ? <LivePages campaign={campaign} personas={personas} target={target} /> : null}

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

function StepRow({ step, spinning }: { step: Step; spinning: boolean }) {
  return (
    <li className="flex gap-4">
      <Bullet state={step.state} spinning={spinning} />
      <div className="min-w-0">
        <p className={`text-base font-semibold ${
          step.state === 'unbuilt' ? 'text-zinc-400'
            : step.state === 'failed' ? 'text-red-700' : 'text-zinc-900'
        }`}
        >
          {step.title}
          {step.state === 'unbuilt'
            ? <span className="ml-2 align-middle text-xs font-bold uppercase tracking-wide text-zinc-400">Not built yet</span>
            : null}
        </p>
        <p className={`mt-0.5 text-sm leading-6 ${step.state === 'unbuilt' ? 'text-zinc-400' : 'text-zinc-500'}`}>
          {step.detail}
        </p>
      </div>
    </li>
  );
}

function Bullet({ state, spinning }: { state: StepState; spinning: boolean }) {
  const base = 'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-sm font-bold';
  if (state === 'done') return <span className={`${base} bg-emerald-600 text-white`}>✓</span>;
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
        <h2 className="text-xl font-bold tracking-tight">Read this before the {target}</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-500">
          Reasons 4 to 10 below are copied onto every one of the {target} pages,
          word for word. Only the headline and reasons 1 to 3 change per buyer. So if
          something here is wrong, it is wrong {target} times — this is the cheap
          place to catch it.
        </p>

        {lastGuidance ? (
          <p className="mt-3 rounded-lg bg-zinc-100 px-4 py-3 text-sm text-zinc-600">
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
                    className="size-14 rounded-md border border-black/10 object-cover"
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
                      <p className="mt-2 rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-500">
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
        <h2 className="text-xl font-bold tracking-tight">
          {formats.length} format{formats.length === 1 ? '' : 's'} that keep working
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
                <li key={f.id} className="rounded-xl border border-zinc-200 p-4">
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
        <h2 className="text-xl font-bold tracking-tight">
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
            <h2 className="text-xl font-bold tracking-tight">Your {personas.length} pages</h2>
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
          <Callout tone="info" title="What happens next">
            The ad ideas are the next stage and are not built yet. Until then these pages are
            the deliverable: they work as ad destinations today, and the view and click counts
            on each one start counting the moment somebody lands.
          </Callout>
        </div>
      </Card>
      <p className="mt-3 text-sm text-zinc-500">
        Campaign address: <code className="font-mono">/p/{campaign.slug}/…</code>
      </p>
    </div>
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

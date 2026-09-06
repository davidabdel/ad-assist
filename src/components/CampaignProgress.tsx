'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { TopBar } from '@/components/Authed';
import { useSession } from '@/components/Session';
import {
  Button, Callout, Card, CopyButton, Field, Shell, inputClass,
} from '@/components/ui';
import { buildSteps, PERSONA_TARGET, type Step, type StepState } from '@/lib/campaign-steps';

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

type Job = { kind: string; status: string; error_message: string | null; notes: string | null };

type Reason = { number: number; title: string; body: string };
type Testimonial = { quote: string; reviewer?: string | null; rating?: number | null };

type BasePageView = {
  hero_headline: string;
  hero_subheadline: string | null;
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
  };
  base_page: BasePageView | null;
  personas: Persona[];
  jobs: Job[];
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
        if (first.campaign.status !== 'pages_built' && first.campaign.status !== 'failed') {
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

  const { campaign, personas, jobs, base_page: basePage } = view;
  const failed = campaign.status === 'failed';
  const finished = campaign.status === 'pages_built';
  const ingest = jobs.find((j) => j.kind === 'ingest');
  const waitingOnMac = !failed && !finished
    && (ingest?.status === 'queued' || ingest?.status === 'running');
  // The gate is open only when the page it is gating actually exists. At
  // `base_review` with no row yet, the page is still being written.
  const awaitingApproval = campaign.status === 'base_review' && Boolean(basePage);

  const steps = buildSteps({
    status: campaign.status,
    hasBrief: campaign.has_brief,
    hasBasePage: Boolean(basePage),
    personaCount: personas.length,
    hasSourceUrl: Boolean(campaign.source_url),
    ingestFailed: ingest?.status === 'failed',
    // Reading is finished once the campaign is off `pending` and no Mac job is
    // still outstanding. A job only exists at all when the server could not read
    // the page, so the usual case is "no job, and the read already happened".
    ingestDone: campaign.status !== 'pending' && !waitingOnMac,
    usesMac: Boolean(ingest),
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
          {finished ? `Finished. ${personas.length} pages are live.`
            : failed ? 'Stopped. Nothing is lost — see below.'
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
          <Callout tone="warn" title="This shop needs your Mac">
            <p>
              {/* The job carries the reason the server could not read it. Showing it
                  is the difference between "something went wrong" and "this shop
                  blocks robots, which is normal and expected". */}
              {ingest?.notes?.replace(/^server read failed, handed to the Mac: /, '')
                ?? 'The page could not be read from the server.'}
            </p>
            <p className="mt-2">
              Almost every shop is read without it, but this one has to be opened in a real
              browser. Open Terminal, paste this, and leave the window open:
            </p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-amber-100 px-3 py-2 font-mono text-xs">
              cd ~/.buzz/REPOS/ad-assist/scanner &amp;&amp; npm start
            </pre>
            <p className="mt-2">
              A Chrome window will open by itself. That is meant to happen — leave it alone and
              this screen carries on within a few seconds.
            </p>
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
          lastGuidance={campaign.base_page_guidance}
          onDecide={decideBasePage}
        />
      ) : null}

      {finished ? <LivePages campaign={campaign} personas={personas} /> : null}

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
  page, slug, lastGuidance, onDecide,
}: {
  page: BasePageView;
  slug: string;
  lastGuidance: string | null;
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
        <h2 className="text-xl font-bold tracking-tight">Read this before the {PERSONA_TARGET}</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-500">
          Reasons 4 to 10 below are copied onto every one of the {PERSONA_TARGET} pages,
          word for word. Only the headline and reasons 1 to 3 change per buyer. So if
          something here is wrong, it is wrong {PERSONA_TARGET} times — this is the cheap
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
              Every one of the {PERSONA_TARGET} pages will ship with no proof section. If the
              product page has reviews on it, send this back, then point the campaign at that
              page rather than the home page.
            </Callout>
          </div>
        ) : null}

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
                : `Approve and write the ${PERSONA_TARGET} pages`}
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
            written yet, so it costs one page, not {PERSONA_TARGET}.
          </p>
        </div>
      </Card>
    </div>
  );
}

function LivePages({
  campaign, personas,
}: { campaign: { slug: string }; personas: Persona[] }) {
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

        {personas.length < PERSONA_TARGET ? (
          <div className="mt-6">
            <Callout tone="warn">
              {personas.length} pages, not {PERSONA_TARGET}. The run stopped early rather than
              ship near-identical pages — the product may not support {PERSONA_TARGET} genuinely
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

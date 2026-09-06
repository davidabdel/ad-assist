'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { TopBar } from '@/components/Authed';
import { useSession } from '@/components/Session';
import { Button, Callout, Card, CopyButton, Shell } from '@/components/ui';
import { buildSteps, PERSONA_TARGET, type Step, type StepState } from '@/lib/campaign-steps';

/**
 * Watches one campaign and drives it.
 *
 * `advance()` does one unit of work per call by design, so something has to keep
 * calling it — this screen is that something. It is a plain loop rather than an
 * interval: an interval can overlap itself when a unit runs long, and two
 * concurrent persona batches against one campaign is the one thing worth
 * avoiding here.
 *
 * Closing the tab does not lose anything. Every unit is idempotent and the
 * progress lives in the database, so reopening this page picks up where it left.
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

type CampaignView = {
  campaign: {
    id: string; title: string; slug: string; status: string;
    source_url: string | null; error_message: string | null; has_brief: boolean;
  };
  base_page: { hero_headline: string } | null;
  personas: Persona[];
  jobs: Job[];
};

type AdvanceResult = {
  status: string; did: string; done: boolean; waiting: boolean; terminal: boolean;
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

  if (!view) {
    return (
      <Shell>
        <TopBar />
        {error ? <Callout tone="error" title="Could not open this campaign">{error}</Callout>
          : <p className="text-zinc-500">Loading…</p>}
      </Shell>
    );
  }

  const { campaign, personas, jobs } = view;
  const failed = campaign.status === 'failed';
  const finished = campaign.status === 'pages_built';
  const ingest = jobs.find((j) => j.kind === 'ingest');
  const waitingOnMac = !failed && !finished
    && (ingest?.status === 'queued' || ingest?.status === 'running');

  const steps = buildSteps({
    status: campaign.status,
    hasBrief: campaign.has_brief,
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
              : running ? 'Working. You can leave this page open, or close it and come back.'
                : 'Paused.'}
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

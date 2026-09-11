'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { TopBar } from '@/components/Authed';
import { useSession } from '@/components/Session';
import { Wizard } from '@/components/Wizard';
import { Button, Callout, cn, Shell } from '@/components/ui';
import { STATUS_LABEL } from '@/lib/campaign-steps';

type CampaignRow = {
  id: string;
  title: string;
  slug: string;
  status: string;
  region: string;
  error_message: string | null;
  created_at: string;
};

/** Five questions, then the build: the bar covers the questions up to 5/7. */
const WIZARD_SHARE = 7;

export function Home() {
  const { api } = useSession();
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [step, setStep] = useState(1);
  const onStep = useCallback((n: number) => setStep(n), []);

  useEffect(() => {
    let alive = true;
    // Arriving from the landing page's "Start a campaign" goes straight to the
    // questions, even for somebody who already has campaigns in the list.
    const asked = new URLSearchParams(window.location.search).has('new');
    api<{ campaigns: CampaignRow[] }>('/api/campaigns')
      .then(({ campaigns: rows }) => {
        if (!alive) return;
        setCampaigns(rows);
        // Straight into the wizard when there is nothing to look at. A list with
        // no rows and a button is a screen that makes you guess.
        setStarting(asked || rows.length === 0);
      })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [api]);

  if (starting) {
    return (
      <Shell wide header={<TopBar progress={step / WIZARD_SHARE} />}>
        <Wizard
          onStep={onStep}
          onCancel={campaigns?.length ? () => setStarting(false) : undefined}
        />
      </Shell>
    );
  }

  return (
    <Shell header={<TopBar />}>
      <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="m-0 text-xs font-bold uppercase tracking-[0.14em] text-accent">Dashboard</p>
          <h1 className="mt-3 text-[34px] leading-[1.05] sm:text-[44px]">Your campaigns</h1>
          <p className="mt-3 text-base text-zinc-500">Pick one up where it left off, or start another.</p>
        </div>
        <Button onClick={() => { setStep(1); setStarting(true); }}>
          New campaign <span aria-hidden>→</span>
        </Button>
      </div>

      {error ? <Callout tone="error" title="Could not load your campaigns">{error}</Callout> : null}

      {!campaigns && !error ? <p className="text-zinc-500">Loading…</p> : null}

      <div className="flex flex-col gap-3">
        {campaigns?.map((c) => {
          const failed = c.status === 'failed';
          const ready = c.status === 'ideas_ready';
          return (
            <Link
              key={c.id}
              href={`/campaigns/${c.id}`}
              className="group block rounded-2xl border border-zinc-200 bg-white px-6 py-5 transition-colors hover:border-accent"
            >
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-lg font-bold tracking-[-0.02em]">{c.title}</span>
                <span className="shrink-0 text-[13px] tabular-nums text-zinc-400">
                  {new Date(c.created_at).toLocaleDateString()}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
                <span
                  className={cn(
                    'rounded-full px-2.5 py-[3px] text-[11px] font-bold',
                    failed ? 'bg-[#FDF3EC] text-[#C2410C]' : ready ? 'bg-[#E6F7F4] text-teal-deep' : 'bg-accent-tint text-accent',
                  )}
                >
                  {failed ? 'Stopped' : ready ? 'Ready' : 'In progress'}
                </span>
                <span className={failed ? 'text-[#C2410C]' : 'text-zinc-500'}>
                  {STATUS_LABEL[c.status] ?? c.status}
                  {failed && c.error_message ? ` — ${c.error_message}` : ''}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </Shell>
  );
}

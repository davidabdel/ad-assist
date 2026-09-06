'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { TopBar } from '@/components/Authed';
import { useSession } from '@/components/Session';
import { Wizard } from '@/components/Wizard';
import { Button, Callout, Card, Shell } from '@/components/ui';
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

export function Home() {
  const { api } = useSession();
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ campaigns: CampaignRow[] }>('/api/campaigns')
      .then(({ campaigns: rows }) => {
        if (!alive) return;
        setCampaigns(rows);
        // Straight into the wizard when there is nothing to look at. A list with
        // no rows and a button is a screen that makes you guess.
        setStarting(rows.length === 0);
      })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [api]);

  if (starting) {
    return (
      <Shell>
        <TopBar />
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Build a campaign</h1>
        <p className="mb-8 text-zinc-600">
          One product goes in. Twenty landing pages come out, each written for a different
          kind of buyer. Four questions, about a minute.
        </p>
        <Wizard onCancel={campaigns?.length ? () => setStarting(false) : undefined} />
      </Shell>
    );
  }

  return (
    <Shell>
      <TopBar />
      <div className="mb-8 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Your campaigns</h1>
          <p className="mt-2 text-zinc-600">Pick one up where it left off, or start another.</p>
        </div>
        <Button onClick={() => setStarting(true)}>New campaign</Button>
      </div>

      {error ? <Callout tone="error" title="Could not load your campaigns">{error}</Callout> : null}

      {!campaigns && !error ? <p className="text-zinc-500">Loading…</p> : null}

      <div className="space-y-3">
        {campaigns?.map((c) => (
          <Link key={c.id} href={`/campaigns/${c.id}`} className="block">
            <Card className="p-5 transition-shadow hover:shadow-md sm:p-5">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-lg font-semibold">{c.title}</span>
                <span className="shrink-0 text-sm text-zinc-500">
                  {new Date(c.created_at).toLocaleDateString()}
                </span>
              </div>
              <p className={`mt-1 text-sm ${c.status === 'failed' ? 'text-red-600' : 'text-zinc-500'}`}>
                {STATUS_LABEL[c.status] ?? c.status}
                {c.status === 'failed' && c.error_message ? ` — ${c.error_message}` : ''}
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </Shell>
  );
}

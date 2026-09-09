'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { SessionProvider, useSession } from '@/components/Session';
import { SignIn } from '@/components/SignIn';
import { Shell } from '@/components/ui';

/**
 * Wraps the two dashboard routes. Deliberately NOT in the root layout: the
 * public `/p/` landing pages share that layout, and they must render for a
 * stranger with no Supabase client, no token and no delay — Meta's ad review
 * crawler is one of the strangers.
 */
export function Authed({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Gate>{children}</Gate>
    </SessionProvider>
  );
}

function Gate({ children }: { children: ReactNode }) {
  const { ready, session } = useSession();

  if (!ready) {
    return (
      <Shell>
        <p className="text-zinc-500">Loading…</p>
      </Shell>
    );
  }
  if (!session) return <SignIn />;
  return <>{children}</>;
}

/**
 * The masthead every signed-in screen carries. Passed to `Shell` as its
 * `header` so the black field runs edge to edge.
 *
 * The wordmark is the comp's, full stop and all: Outfit, heavy, tight, with the
 * one accent colour spent on a single character. It is the only place the brand
 * signs its own name, so it is the only place that gets the blue.
 */
export function TopBar() {
  const { email, signOut } = useSession();
  return (
    <header className="bg-zinc-900 text-white">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-5 py-4">
        <Link
          href="/"
          className="font-display text-xl font-bold tracking-[-0.02em] text-white"
        >
          Ad Assist<span className="text-accent">.</span>
        </Link>
        <div className="flex items-baseline gap-4 text-sm text-zinc-400">
          <span className="hidden sm:inline">{email}</span>
          <button
            type="button"
            onClick={() => signOut()}
            className="font-semibold underline underline-offset-4 hover:text-white"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

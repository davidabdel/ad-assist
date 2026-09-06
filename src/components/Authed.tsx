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

/** The bar every signed-in screen carries. */
export function TopBar() {
  const { email, signOut } = useSession();
  return (
    <div className="mb-8 flex items-baseline justify-between gap-4">
      <Link href="/" className="text-lg font-bold tracking-tight text-zinc-900">Ad Assist</Link>
      <div className="flex items-baseline gap-3 text-sm text-zinc-500">
        <span className="hidden sm:inline">{email}</span>
        <button
          type="button"
          onClick={() => signOut()}
          className="font-semibold underline hover:text-zinc-900"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

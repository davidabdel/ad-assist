'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { SessionProvider, useSession } from '@/components/Session';
import { Logo, Shell } from '@/components/ui';

/**
 * Wraps the signed-in routes. Deliberately NOT in the root layout: the public
 * `/p/` landing pages share that layout, and they must render for a stranger
 * with no Supabase client, no token and no delay — Meta's ad review crawler is
 * one of the strangers.
 *
 * Signed out, it sends you to /login and remembers where you were going, so a
 * link to a campaign still lands on that campaign after signing in.
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
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (ready && !session) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [ready, session, router, pathname]);

  if (!ready || !session) {
    return (
      <Shell>
        <p className="text-zinc-500">Loading…</p>
      </Shell>
    );
  }
  return <>{children}</>;
}

/**
 * The masthead every signed-in screen carries: the mark on the left, whatever
 * the screen wants to say on the right, and a 3px gradient bar along the top
 * edge when there is progress to show (0–1).
 */
export function TopBar({ right, progress }: { right?: ReactNode; progress?: number }) {
  const { email, signOut } = useSession();
  return (
    <header className="relative border-b border-zinc-200 bg-white">
      {progress !== undefined ? (
        <div
          className="bg-brand-gradient absolute inset-x-0 top-0 h-[3px] origin-left transition-transform duration-500 ease-[cubic-bezier(.2,.7,.2,1)]"
          style={{ transform: `scaleX(${Math.max(0, Math.min(1, progress))})` }}
        />
      ) : null}
      <div className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4 sm:px-11">
        <Link href="/campaigns" aria-label="Your campaigns">
          <Logo size={36} />
        </Link>
        <div className="flex min-w-0 items-center gap-4 text-[13px] text-zinc-500">
          {right ?? <span className="hidden truncate sm:inline">{email}</span>}
          <button
            type="button"
            onClick={() => signOut()}
            className="shrink-0 rounded-full border border-zinc-300 px-3.5 py-[7px] text-xs font-semibold
                       text-zinc-500 hover:border-zinc-900 hover:text-zinc-900"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

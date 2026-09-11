'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { SessionProvider, useSession } from '@/components/Session';

/**
 * Log in, or create an account.
 *
 * Log in is email + password, as it always was. Create account sends a
 * one-time link — no password to invent, and the link proves the address is
 * real. "Forgot it?" sends the same kind of link to an existing account, which
 * is also how anyone who signed up by link gets back in.
 */

const EMAIL = /.+@.+\..+/;

/** Only ever a path on this site — never somewhere a crafted link chose. */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/campaigns';
}

export function Login() {
  return (
    <SessionProvider>
      <LoginScreen />
    </SessionProvider>
  );
}

const MARKS = [
  'Twenty buyer profiles that do not overlap',
  "Ad shapes read from Meta's live ad library",
  'Nothing generates until you press a button',
];

function LoginScreen() {
  const { ready, session, signIn, sendLink, signInWithGoogle } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));

  const [mode, setMode] = useState<'in' | 'up'>(params.get('mode') === 'up' ? 'up' : 'in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [badEmail, setBadEmail] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in — or just came back from a link — so there is nothing to do here.
  useEffect(() => {
    if (ready && session) router.replace(next);
  }, [ready, session, router, next]);

  const isIn = mode === 'in';

  function pick(m: 'in' | 'up') {
    setMode(m);
    setError(null);
    setBadEmail(false);
    setSent(null);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function checkEmail(): string | null {
    const value = email.trim();
    if (!EMAIL.test(value)) {
      setBadEmail(true);
      setSent(null);
      setError('That does not look like an email address.');
      return null;
    }
    return value;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = checkEmail();
    if (!value) return;
    if (isIn) {
      if (!password) {
        setError('Put your password in, or press "Forgot it?" for a sign-in link.');
        return;
      }
      await run(() => signIn(value, password));
    } else {
      await run(async () => {
        await sendLink(value, { create: true, next });
        setSent(value);
      });
    }
  }

  async function forgot(e: React.MouseEvent) {
    e.preventDefault();
    const value = checkEmail();
    if (!value) return;
    await run(async () => {
      await sendLink(value, { create: false, next });
      setSent(value);
    });
  }

  return (
    <div className="site grid min-h-screen flex-1 bg-white text-zinc-900 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="relative flex flex-col justify-between gap-10 overflow-hidden bg-navy p-8 text-white sm:p-11">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: 'radial-gradient(700px 380px at 20% 12%,rgba(8,125,232,.35),transparent 62%),'
              + 'radial-gradient(620px 420px at 88% 88%,rgba(8,199,178,.28),transparent 60%)',
          }}
        />
        <Link href="/" className="relative flex w-max items-center gap-3">
          <span className="flex size-12 items-center justify-center rounded-xl bg-white shadow-[0_0_0_1px_rgba(255,255,255,.18),0_0_32px_rgba(8,199,178,.45)]">
            {/* eslint-disable-next-line @next/next/no-img-element -- a 36px static mark */}
            <img src="/brand/adtocart-icon.png" alt="" className="block h-9 w-auto" />
          </span>
          <span className="text-[26px] font-extrabold tracking-[-0.03em]">
            adtocart<span className="text-zinc-400">.cc</span>
          </span>
        </Link>
        <div className="relative flex max-w-[460px] flex-col gap-[22px]">
          <h1 className="m-0 text-[clamp(30px,3.2vw,44px)] leading-[1.06] tracking-[-0.04em]">
            Your customers are unique.<br />
            <span className="text-brand-gradient">Why aren&rsquo;t your ads?</span>
          </h1>
          <p className="m-0 text-base leading-[1.6] text-[#A9B6C4]">
            One product page in. Twenty buyers, twenty landing pages and sixty ads out — each
            written for a different reason somebody would buy.
          </p>
        </div>
        <ul className="relative m-0 flex list-none flex-col gap-2.5 border-t border-white/15 p-0 pt-5">
          {MARKS.map((m) => (
            <li key={m} className="flex items-center gap-3 text-sm text-[#C3CDD9]">
              <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-teal/20 text-[10px] font-extrabold text-teal">✓</span>
              {m}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-center justify-center p-8 sm:p-11">
        <form onSubmit={submit} noValidate className="flex w-full max-w-[400px] flex-col gap-5">
          <div className="flex flex-col gap-2">
            <h2 className="m-0 text-[32px] leading-tight">{isIn ? 'Welcome back' : 'Start your first campaign'}</h2>
            <p className="m-0 text-[15px] leading-[1.55] text-zinc-500">
              {isIn
                ? 'Pick up where your campaigns left off.'
                : 'One product page is all you need to begin. No card, no Meta account.'}
            </p>
          </div>

          <div className="flex rounded-full bg-zinc-100 p-1" role="tablist">
            {(['in', 'up'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => pick(m)}
                className={`flex-1 rounded-full px-3.5 py-2.5 text-sm font-bold transition-all ${
                  mode === m ? 'bg-white text-zinc-900 shadow-[0_1px_3px_rgba(6,22,46,.14)]' : 'text-zinc-500'
                }`}
              >
                {m === 'in' ? 'Log in' : 'Create account'}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => signInWithGoogle(next))}
            className="flex w-full items-center justify-center gap-2.5 rounded-xl border-[1.5px] border-zinc-300 bg-white p-[13px]
                       text-[15px] font-bold text-zinc-900 transition-colors hover:border-zinc-900 disabled:opacity-50"
          >
            <span className="text-base font-extrabold text-accent">G</span>
            {isIn ? 'Continue with Google' : 'Sign up with Google'}
          </button>

          <div className="flex items-center gap-3 text-xs font-semibold text-[#9AA4B2]">
            <span className="h-px flex-1 bg-zinc-200" />or<span className="h-px flex-1 bg-zinc-200" />
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-bold">Work email</span>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setBadEmail(false); setError(null); }}
              placeholder="you@yourshop.com"
              aria-invalid={badEmail}
              className={`w-full rounded-xl border-[1.5px] px-4 py-3.5 text-[15px] font-medium text-zinc-900 outline-none
                          transition-colors placeholder:text-[#9AA4B2] focus:border-accent ${
                            badEmail ? 'border-[#F97316]' : 'border-zinc-300'
                          }`}
            />
          </label>

          {isIn ? (
            <label className="flex flex-col gap-1.5">
              <span className="flex items-baseline justify-between">
                <span className="text-[13px] font-bold">Password</span>
                <a href="#" onClick={forgot} className="text-xs font-bold text-accent hover:text-zinc-900">Forgot it?</a>
              </span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••"
                className="w-full rounded-xl border-[1.5px] border-zinc-300 px-4 py-3.5 text-[15px] text-zinc-900
                           outline-none transition-colors placeholder:text-[#9AA4B2] focus:border-accent"
              />
            </label>
          ) : null}

          {error ? (
            <div role="alert" className="rounded-[10px] border border-[#F6D6BE] bg-[#FDF3EC] px-3.5 py-[11px] text-[13px] leading-normal text-[#C2410C]">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="bg-brand-gradient flex w-full items-center justify-center gap-[9px] rounded-xl p-4 text-[15px] font-extrabold
                       text-white shadow-[0_12px_26px_-14px_rgba(8,125,232,.9)] hover:brightness-[1.06] disabled:opacity-60"
          >
            {busy ? (isIn ? 'Logging in…' : 'Sending…') : isIn ? 'Log in' : 'Create my account'}
            {busy ? null : <span aria-hidden>→</span>}
          </button>

          {sent ? (
            <div className="rounded-xl border border-teal-line bg-teal-tint px-4 py-3.5 text-sm leading-[1.55] text-zinc-900">
              Check <strong>{sent}</strong> — there&rsquo;s a sign-in link waiting. It expires in an hour.
            </div>
          ) : null}

          <div className="text-[13px] leading-[1.6] text-zinc-400">
            {isIn ? 'No account yet?' : 'Already have one?'}{' '}
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); pick(isIn ? 'up' : 'in'); }}
              className="font-bold text-accent hover:text-zinc-900"
            >
              {isIn ? 'Create one' : 'Log in'}
            </a>
          </div>
          <div className="border-t border-zinc-200 pt-3.5 text-xs leading-[1.6] text-[#A8B1BC]">
            Joining is free. Plans and credits are explained once you&rsquo;re in.
          </div>
        </form>
      </div>
    </div>
  );
}

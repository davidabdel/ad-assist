'use client';

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { browserClient } from '@/lib/browser-supabase';

/**
 * Session state plus the only fetch wrapper in the app.
 *
 * Every API route wants `Authorization: Bearer <supabase access token>`, so the
 * token lives in one place and `api()` is the one door out. A component that
 * forgot the header would get a 401 that reads like a login problem, which is
 * the most misleading error this app can produce.
 */

type Ctx = {
  session: Session | null;
  ready: boolean;
  email: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  /** Emails a one-time sign-in link. `create` decides whether a new address gets an account. */
  sendLink: (email: string, opts: { create: boolean; next?: string }) => Promise<void>;
  signInWithGoogle: (next?: string) => Promise<void>;
  signOut: () => Promise<void>;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
};

const SessionContext = createContext<Ctx | null>(null);

/**
 * The API returns a zod error tree on a 400, an error string everywhere else.
 * Both become one sentence a person can act on, because "[object Object]" in a
 * red box has never helped anybody.
 */
function readError(body: unknown, status: number): string {
  const err = (body as { error?: unknown } | null)?.error;
  if (typeof err === 'string') return err;

  if (err && typeof err === 'object') {
    const found: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (key === 'errors' && Array.isArray(value)) {
            value.forEach((m) => typeof m === 'string' && found.push(m));
          } else {
            walk(value);
          }
        }
      }
    };
    walk(err);
    if (found.length) return found.join('. ');
  }
  if (status === 401) return 'Your sign-in expired. Sign in again.';
  return `Something went wrong (error ${status}).`;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const supabase = browserClient();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await browserClient().auth.signInWithPassword({ email, password });
    if (error) {
      throw new Error(
        error.message === 'Invalid login credentials'
          ? 'That email and password do not match an account. Signed up with a link? '
            + 'Press "Forgot it?" and we will email you another.'
          : error.message,
      );
    }
  }, []);

  const sendLink = useCallback(async (
    email: string,
    { create, next = '/campaigns' }: { create: boolean; next?: string },
  ) => {
    const { error } = await browserClient().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: create, emailRedirectTo: `${window.location.origin}${next}` },
    });
    if (error) {
      throw new Error(
        /signups? not allowed|otp_disabled/i.test(error.message)
          ? (create
            ? 'New accounts are switched off right now. Ask David to open sign-ups.'
            : 'There is no account for that email. Create one instead.')
          : error.message,
      );
    }
  }, []);

  /**
   * Asks Supabase whether Google is switched on before sending anybody there.
   * With the provider off, the redirect lands on a bare JSON error page on
   * supabase.co — a dead end with no way back — so it is checked here and said
   * in a sentence instead.
   */
  const signInWithGoogle = useCallback(async (next = '/campaigns') => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
    const settings = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anon } })
      .then((r) => r.json() as Promise<{ external?: Record<string, boolean> }>)
      .catch(() => null);
    if (settings && !settings.external?.google) {
      throw new Error('Google sign-in is not switched on yet. Use your email instead.');
    }
    const { error } = await browserClient().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}${next}` },
    });
    if (error) throw new Error(error.message);
  }, []);

  const signOut = useCallback(async () => {
    await browserClient().auth.signOut();
  }, []);

  const api = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    // Read the token from the client rather than from state: a call fired right
    // after an auto-refresh would otherwise send the token it replaced.
    const { data } = await browserClient().auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('Your sign-in expired. Sign in again.');

    // Never on a FormData body: the browser has to set its own multipart
    // boundary, and a hard-coded application/json makes the server read an
    // upload as a malformed JSON document.
    const isForm = typeof FormData !== 'undefined' && init?.body instanceof FormData;

    const res = await fetch(path, {
      ...init,
      headers: {
        ...(isForm ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(readError(body, res.status));
    return body as T;
  }, []);

  const value = useMemo<Ctx>(() => ({
    session,
    ready,
    email: session?.user.email ?? null,
    signIn,
    sendLink,
    signInWithGoogle,
    signOut,
    api,
  }), [session, ready, signIn, sendLink, signInWithGoogle, signOut, api]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Ctx {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

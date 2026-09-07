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
          ? 'That email and password do not match an account.'
          : error.message,
      );
    }
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
    signOut,
    api,
  }), [session, ready, signIn, signOut, api]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Ctx {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

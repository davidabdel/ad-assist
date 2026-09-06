'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The browser's own Supabase client, anon key only.
 *
 * It exists for exactly one job: get a real access token so the dashboard can
 * call the API routes, which verify that token in `lib/auth.ts`. It never reads
 * a table — every piece of data on screen comes back from an API route running
 * under the service role, so there is no second data path to keep in step.
 *
 * The session is persisted, which is why a refresh does not throw the operator
 * back to the login screen halfway through a build.
 */

let client: SupabaseClient | null = null;

export function browserClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    // Thrown rather than defaulted: a dashboard that silently cannot sign in
    // looks like a wrong password, and that is a bad hour to hand anyone.
    throw new Error(
      'This app has no Supabase settings. NEXT_PUBLIC_SUPABASE_URL and '
      + 'NEXT_PUBLIC_SUPABASE_ANON_KEY need to be set in Vercel, then redeployed.',
    );
  }

  client = createClient(url, anon, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

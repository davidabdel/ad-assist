import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Two clients, deliberately separate.
 *
 * `publicClient` uses the anon key and can only reach the RPCs we granted to
 * anon — get_public_page and the two counters. It never sees a table, so the
 * 20 live landing pages cannot leak campaign or persona rows even if the
 * renderer has a bug.
 *
 * `serviceClient` bypasses RLS and is server-only. Importing it into a client
 * component would ship the service key to the browser, so it throws if the key
 * is missing rather than silently degrading to anon.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill it in — `
      + 'the app needs a Supabase project before any page can render.',
    );
  }
  return v;
}

let _public: SupabaseClient | null = null;
export function publicClient(): SupabaseClient {
  if (!_public) {
    _public = createClient(
      required('NEXT_PUBLIC_SUPABASE_URL'),
      required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
      { auth: { persistSession: false } },
    );
  }
  return _public;
}

let _service: SupabaseClient | null = null;
export function serviceClient(): SupabaseClient {
  if (typeof window !== 'undefined') {
    throw new Error('serviceClient() is server-only — it must never reach the browser');
  }
  if (!_service) {
    _service = createClient(
      required('NEXT_PUBLIC_SUPABASE_URL'),
      required('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false } },
    );
  }
  return _service;
}

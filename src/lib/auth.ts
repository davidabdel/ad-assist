import { publicClient, serviceClient } from './supabase';

/**
 * Single-user for now (David's ruling, 6 Sep), but the campaigns are owner-scoped
 * in the schema so a second login is a login, not a migration.
 *
 * The API routes do their work with the service role, which bypasses RLS. That
 * makes the ownership check here the only thing standing between a request and
 * someone else's campaigns — so it verifies a real Supabase access token rather
 * than a shared secret we invented. The same token a signed-in browser would
 * send is the token a script sends.
 */

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

export type Owner = { id: string; email: string };

function bearer(req: Request): string {
  const header = req.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new AuthError('Missing Authorization: Bearer <supabase access token>');
  }
  return match[1].trim();
}

/**
 * Verifies the caller and guarantees a public.users row exists for them. The
 * mirror row is what campaigns.user_id references, so a first-time login that
 * skipped it would fail on the foreign key rather than on anything meaningful.
 */
export async function requireOwner(req: Request): Promise<Owner> {
  const token = bearer(req);
  const { data, error } = await publicClient().auth.getUser(token);
  if (error || !data.user) {
    throw new AuthError(`Not a valid session: ${error?.message ?? 'no user on this token'}`);
  }
  const { id, email } = data.user;
  if (!email) throw new AuthError('This account has no email address', 403);

  const svc = serviceClient();
  const { error: upsertError } = await svc
    .from('users')
    .upsert({ id, email }, { onConflict: 'id' });
  if (upsertError) {
    throw new AuthError(`Could not establish the owner record: ${upsertError.message}`, 500);
  }
  return { id, email };
}

/** Throws unless this owner owns this campaign. Used before any campaign work. */
export async function requireCampaignOwner(owner: Owner, campaignId: string) {
  const { data, error } = await serviceClient()
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle();
  if (error) throw new AuthError(`Could not read the campaign: ${error.message}`, 500);
  if (!data) throw new AuthError('No such campaign', 404);
  if (data.user_id !== owner.id) {
    // 404 rather than 403: a 403 confirms the id exists.
    throw new AuthError('No such campaign', 404);
  }
  return data;
}

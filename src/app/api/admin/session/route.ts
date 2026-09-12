import { createHmac } from 'node:crypto';
import { cookies } from 'next/headers';
import { checkPassword, signAdmin, ADMIN_COOKIE, ADMIN_TTL } from '@/lib/admin-session';
import { sameOrigin } from '@/lib/billing/stripe';
import { serviceClient } from '@/lib/supabase';
export const runtime = 'nodejs';
export async function POST(req: Request) {
  const secret = process.env.ADMIN_SESSION_SECRET ?? '';
  const hash = process.env.ADMIN_PASSWORD_HASH ?? '';
  if (secret.length < 32 || !hash) return Response.json({ error: 'Admin access has not been configured.' }, { status: 503 });
  try {
    sameOrigin(req);
    const ip = process.env.VERCEL ? req.headers.get('x-vercel-forwarded-for') : process.env.NODE_ENV !== 'production' ? 'local' : null;
    if (!ip) return Response.json({ error: 'Trusted login gateway unavailable.' }, { status: 503 });
    const key = createHmac('sha256', secret).update(ip).digest('hex');
    const { data: allowed, error } = await serviceClient().rpc('admin_login_attempt', { p_key: key });
    if (error) throw error;
    if (!allowed) return Response.json({ error: 'Too many attempts. Try again in 15 minutes.' }, { status: 429 });
    const raw = await req.text();
    if (raw.length > 2000) throw new Error('Invalid login');
    const { password } = JSON.parse(raw);
    if (typeof password !== 'string' || !checkPassword(password, hash)) return Response.json({ error: 'Incorrect admin password.' }, { status: 401 });
    (await cookies()).set(ADMIN_COOKIE, signAdmin(secret, hash), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: ADMIN_TTL });
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'Admin sign-in is unavailable. Check the service configuration.' }, { status: 503 }); }
}
export async function DELETE(req: Request) {
  try { sameOrigin(req); (await cookies()).delete(ADMIN_COOKIE); return Response.json({ ok: true }); }
  catch { return Response.json({ error: 'Invalid request' }, { status: 403 }); }
}

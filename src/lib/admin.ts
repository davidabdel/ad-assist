import { cookies } from 'next/headers';
import { ADMIN_COOKIE, verifyAdmin } from '@/lib/admin-session';
import { AuthError } from '@/lib/auth';
export async function requireAdmin() {
  const secret = process.env.ADMIN_SESSION_SECRET ?? '';
  const hash = process.env.ADMIN_PASSWORD_HASH ?? '';
  if (!verifyAdmin((await cookies()).get(ADMIN_COOKIE)?.value, secret, hash)) throw new AuthError('Admin sign-in required');
}

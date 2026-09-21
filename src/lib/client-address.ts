import { isIP } from 'node:net';
import { getContext } from '@netlify/functions';

/** Only platform-authenticated metadata may identify a rate-limit bucket. */
export function trustedClientAddress(req: Request): string | null {
  try {
    const ip = getContext().ip;
    return isIP(ip) ? ip : null;
  } catch {
    // Vercel and local development do not provide a Netlify request context.
  }
  if (process.env.VERCEL) {
    const ip = req.headers.get('x-vercel-forwarded-for')?.trim();
    return ip && isIP(ip) ? ip : null;
  }
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
    ? 'local-development' : null;
}

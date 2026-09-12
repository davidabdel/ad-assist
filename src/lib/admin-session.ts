import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
export const ADMIN_COOKIE = 'adtocart-admin';
export const ADMIN_TTL = 8 * 60 * 60;
export function checkPassword(password: string, encoded: string) {
  const [salt, hex] = encoded.split(':');
  if (!/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(hex ?? '') || password.length > 512) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hex, 'hex'));
}
export function signAdmin(secret: string, hash: string, now = Date.now()) {
  const value = `${Math.floor(now / 1000) + ADMIN_TTL}.${randomBytes(16).toString('hex')}`;
  return `${value}.${createHmac('sha256', secret).update(`${hash}:${value}`).digest('hex')}`;
}
export function verifyAdmin(token: string | undefined, secret: string, hash: string, now = Date.now()) {
  if (!token || secret.length < 32 || !hash) return false;
  const [expires, nonce, signature, extra] = token.split('.');
  if (extra || !/^\d+$/.test(expires) || !/^[a-f0-9]{32}$/.test(nonce ?? '') || !/^[a-f0-9]{64}$/.test(signature ?? '')) return false;
  const seconds = Math.floor(now / 1000);
  if (Number(expires) <= seconds || Number(expires) > seconds + ADMIN_TTL) return false;
  const expected = createHmac('sha256', secret).update(`${hash}:${expires}.${nonce}`).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

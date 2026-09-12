import { createHmac, timingSafeEqual } from 'node:crypto';
import { PLANS, type Plan } from './plans';

export function siteOrigin() {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;
  if (!raw) throw new Error('Site address is not configured');
  return new URL(raw).origin;
}
export function sameOrigin(req: Request) {
  if (req.headers.get('origin') !== siteOrigin()) throw new Error('Request must come from this website');
}
export function priceId(plan: Plan | 'video') {
  const value = process.env[`STRIPE_PRICE_${plan.toUpperCase()}`];
  if (!value) throw new Error('This plan is not available for purchase yet');
  return value;
}
export async function stripe<T>(path: string, fields?: Record<string, string>, idempotency?: string): Promise<T> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('Billing is not configured yet');
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: fields ? 'POST' : 'GET', cache: 'no-store',
    headers: { Authorization: `Bearer ${secret}`, 'Stripe-Version': '2025-04-30.basil',
      ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotency ? { 'Idempotency-Key': idempotency } : {}) },
    body: fields ? new URLSearchParams(fields) : undefined, signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Billing provider could not complete the request (${res.status})`);
  return await res.json() as T;
}
export function verifyStripeSignature(body: string, header: string | null, secret: string, now = Date.now()) {
  const pieces = (header ?? '').split(',').map(v => v.split('='));
  const timestamp = pieces.find(([k]) => k === 't')?.[1];
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  return pieces.filter(([k]) => k === 'v1').some(([, signature]) => {
    if (!/^[a-f0-9]{64}$/.test(signature ?? '')) return false;
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  });
}
export type Subscription = {
  id: string; customer: string; status: string; cancel_at_period_end: boolean;
  metadata: Record<string, string>; items: { data: { quantity: number; current_period_start: number; current_period_end: number;
    price: { id: string; currency: string; unit_amount: number; recurring: { interval: string; interval_count: number } } }[] };
};
export function subscriptionSnapshot(s: Subscription) {
  const item = s.items.data[0];
  const plan = (Object.keys(PLANS) as Plan[]).find(p => process.env[`STRIPE_PRICE_${p.toUpperCase()}`] === item?.price.id);
  if (!plan || s.items.data.length !== 1 || item.quantity !== 1 || item.price.currency !== 'usd'
      || item.price.recurring.interval !== 'month' || item.price.recurring.interval_count !== 1
      || item.price.unit_amount !== PLANS[plan].usd * 100) throw new Error('Subscription price is not a supported plan');
  return { customer_id: s.customer, subscription_id: s.id, plan, status: s.status,
    mrr_usd: ['active', 'past_due'].includes(s.status) ? item.price.unit_amount / 100 : 0,
    period_start: new Date(item.current_period_start * 1000).toISOString(),
    period_end: new Date(item.current_period_end * 1000).toISOString(), cancel_at_period_end: s.cancel_at_period_end,
    builds_limit: PLANS[plan].builds, images_limit: PLANS[plan].images, products_limit: PLANS[plan].products };
}

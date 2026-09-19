// Explicitly approved AdtoCart live catalog; never creates prices or charges.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const key = readFileSync('.scratch/stripe-live-key', 'utf8').trim();
assert.ok(key.startsWith('rk_live_'), 'Use the approved restricted live key');
const catalog = {
  starter: ['prod_VFkuFH3x979F2Z', 'price_1UFFOXGkDjIcIDlQIY397T3Z', 14900],
  growth: ['prod_VFpBhUu52UuLfT', 'price_1UFJXIGkDjIcIDlQaccBzCkK', 49900],
  agency: ['prod_VFpCZ9iB7PieYb', 'price_1UFJXgGkDjIcIDlQeQ8eGwPk', 149900],
  video: ['prod_VFpCLo6nkn8PxK', 'price_1UFJY6GkDjIcIDlQgdiBvPmR', 5900],
};
async function stripe(path, fields, idempotencyKey) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: fields ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': '2025-04-30.basil',
      ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: fields ? new URLSearchParams(fields) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Stripe request failed (${response.status}, ${data.error?.code ?? 'unknown'}): ${path}`);
  return data;
}
const account = await stripe('account');
assert.equal(account.id, 'acct_1SE1MRGkDjIcIDlQ');
for (const [plan, [product, id, amount]] of Object.entries(catalog)) {
  const price = await stripe(`prices/${id}`);
  assert.equal(price.product, product);
  assert.equal(price.livemode, true);
  assert.equal(price.active, true);
  assert.equal(price.currency, 'usd');
  assert.equal(price.unit_amount, amount);
  assert.equal(price.recurring?.interval ?? null, plan === 'video' ? null : 'month');
  if (price.recurring) assert.equal(price.recurring.interval_count, 1);
}
const matches = [];
let after;
do {
  const page = await stripe(`billing_portal/configurations?limit=100${after ? `&starting_after=${after}` : ''}`);
  matches.push(...page.data.filter(p => p.metadata?.app === 'adtocart'));
  after = page.has_more ? page.data.at(-1).id : undefined;
} while (after);
assert.ok(matches.length <= 1, 'Multiple AdtoCart portals found; review before changing');
let portal = matches[0];
if (!portal) {
  const fields = {
    'business_profile[headline]': 'Manage your AdtoCart subscription',
    'metadata[app]': 'adtocart',
    'features[payment_method_update][enabled]': 'true',
    'features[invoice_history][enabled]': 'true',
    'features[subscription_cancel][enabled]': 'true',
    'features[subscription_cancel][mode]': 'at_period_end',
    'features[subscription_update][enabled]': 'true',
    'features[subscription_update][default_allowed_updates][0]': 'price',
    'features[subscription_update][proration_behavior]': 'always_invoice',
  };
  for (const [index, plan] of ['starter', 'growth', 'agency'].entries()) {
    fields[`features[subscription_update][products][${index}][product]`] = catalog[plan][0];
    fields[`features[subscription_update][products][${index}][prices][0]`] = catalog[plan][1];
  }
  portal = await stripe('billing_portal/configurations', fields, 'adtocart-live-portal-v1');
}
assert.equal(portal.livemode, true);
assert.equal(portal.is_default, false, 'Do not use the shared default portal');
assert.equal(portal.active, true);
assert.equal(portal.features.subscription_cancel.mode, 'at_period_end');
assert.equal(portal.features.subscription_update.proration_behavior, 'always_invoice');
assert.deepEqual(portal.features.subscription_update.default_allowed_updates, ['price']);
const actualProducts = portal.features.subscription_update.products.map(p => [p.product, [...p.prices].sort()]).sort();
const expectedProducts = ['starter', 'growth', 'agency'].map(p => [catalog[p][0], [catalog[p][1]]]).sort();
assert.deepEqual(actualProducts, expectedProducts);
for (const feature of ['payment_method_update', 'invoice_history', 'subscription_cancel', 'subscription_update']) assert.equal(portal.features[feature].enabled, true);
mkdirSync('.scratch/release', { recursive: true, mode: 0o700 });
writeFileSync('.scratch/release/live-portal.json', JSON.stringify({ STRIPE_PORTAL_CONFIGURATION: portal.id, charges_enabled: account.charges_enabled, payouts_enabled: account.payouts_enabled }, null, 2), { mode: 0o600 });
console.log('Verified dedicated AdtoCart live portal. Configuration saved privately; no payment or generation performed.');

# SaaS billing and owner dashboard

Branch: `codex/saas-billing-admin-dashboard`.

## What is implemented

- `/start`: actual public product scan before signup, with shared quotas and safe outbound fetching.
- `/pricing`: USD Starter ($149), Growth ($499), Agency ($1,499).
- `/billing`: customer plan, current allowances, video balance, hosted checkout, billing portal and campaign archiving.
- `/admin`: separate password-protected owner dashboard. Every metrics request verifies its admin session before querying customer data. Refreshes every 30 seconds while visible. This is polling, not a continuously open realtime subscription.
- Subscription webhooks, provider-verified credit purchases and refund reconciliation. Checkout's return page never grants entitlements.
- One account-level free campaign preview, stopped before publishing. Authenticated draft viewing is separate from public buyer pages.
- Database-locked quotas for builds, image renders, video renders and text-generation cost. Central provider boundaries enforce generation allowances, including revisions, previews and automatic video follow-up.
- Model/token and media ledgers with durable account attribution. Account search, pagination, cost/MRR sorting, plan/status, scans, generation attempts, provider-confirmed media credits, estimated model costs and account detail.

No production credentials or real payments were used to validate these changes. These endpoints become live when deployed with the intended Supabase and Stripe configuration; they are not connected to a new production billing account automatically.

## Definitions and limitations

The dashboard deliberately distinguishes:

- **MRR:** subscription list-price run rate for active and past-due accounts. Excludes credit packs, taxes and refunds. This is not cash received. Discounts, annual plans, additional quantities and arbitrary price IDs are unsupported; checkout and subscription validation accept the three configured monthly USD prices only. Disable discounts and unsupported upgrades in the portal.
- **Paying accounts:** currently positive subscription MRR, including past-due accounts.
- **Customer churn:** customers with positive MRR at the start of the selected window who have zero MRR now, divided by that opening cohort. Reactivations are excluded. This is net ending-state logo churn, not every cancellation event during the window.
- **Revenue churn:** opening MRR belonging to those lost customers divided by total opening MRR. It excludes downgrades and is not NRR/GRR. Cancellations scheduled for period end remain separate.
- **Coverage:** churn is null until the selected interval is covered by recorded subscription history. Existing data is backfilled where available, but past payment history and discarded model usage cannot be invented.
- **Active:** an authenticated product API was used in the last 24 hours, 7 days or 30 days. Last-seen writes are throttled to 15 minutes. This is not a historical daily-active-user series.
- **Activation:** at least one campaign created, not necessarily a completed/published campaign.
- **Scans:** recorded completed scan attempts, including rescans, not distinct URLs. Public scans remain unlinked until their saved result is used to create a campaign. Failed scans and unlinked scans are shown separately. Existing scans before instrumentation are not reconstructed.
- **Images/videos:** submitted provider tasks, including rejected and failed attempts. Image counts include generated previews and video opening frames. These are not unique accepted ads.
- **Confirmed media cost:** provider-reported credits × the configured $0.005 conversion. Missing credits are unknown, not zero. The raw credit total is also visible per customer. Reconcile the conversion with the KIE account's actual purchased credits and invoices.
- **Text cost:** reported tokens at verified GPT-5.5 standard rates, including reasoning and cached-input pricing. An estimate, not a provider invoice reconciliation. Unsupported model overrides fail closed until pricing is configured. SDK automatic retries are disabled so each logical call has one explicit reservation.
- **Unknown outcomes:** if a provider connection fails after a possible charge, the reservation stays held. The admin overview flags reservations unresolved after ten minutes. Operations must reconcile those with provider records; do not blindly release them or submit again.
- **AI cost is not profit:** hosting, support, payment fees, acquisition and taxes are excluded. Cash less AI cost is only a cash/usage comparison, not an accrual gross margin.

Billing webhooks must be monitored and replayed on failure. Current provider state is retrieved for subscription events, serialized per account and protected against duplicate/older events in PostgreSQL. Cancellation status can only be as current as the last successfully processed provider event. A credit refund received before its original payment returns a retryable failure until the purchase is recorded. Dispute/chargeback handling and manual adjustments are not implemented: reconcile them in Stripe before commercial rollout.

## Deployment order

1. Back up the intended Supabase database. Apply only unapplied migrations, in order: 0020–0026 for this branch. Do not rerun the historical initialization on an existing project. The existing helper accepts explicit migration filenames.
2. Configure existing Supabase/OpenAI/KIE settings and the canonical HTTPS `NEXT_PUBLIC_SITE_URL` in the target deployment. New paid generation requires billing tables; deploy migrations first.
3. Generate a random `FREE_SCAN_SECRET`. On Vercel, the trusted forwarded header supplies rate-limit identity. Other production hosts require an explicitly configured trusted gateway; arbitrary client-supplied forwarded headers are never trusted.
4. Run `node scripts/admin-password.mjs` in your terminal. Choose at least 16 characters. Save the generated `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET` into server-side deployment settings. The script does not echo or save your plaintext password. Do not paste credentials into the repository or conversation. Rotating either setting invalidates existing admin sessions.
5. Configure Stripe **test** credentials first. Create three recurring monthly USD prices, exactly $149 / $499 / $1,499, and a one-off $59 video pack. Set the four `STRIPE_PRICE_*` IDs. The pack grants ten ten-second renders. No annual plans, promotions, automatic overages or multi-quantity purchases are enabled.
6. Register `/api/billing/webhook` with its signing secret. Enable `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `refund.created`, `refund.updated`, `refund.failed`. Events use the pinned Stripe API adapter version `2025-04-30.basil` and signatures are verified against raw bytes with a five-minute tolerance.
7. Configure Stripe's customer billing portal for those same plans, cancellation and payment-method management. Restrict changes to supported monthly prices; do not allow trial creation, quantities, coupons or annual prices. Review taxation and customer terms for the operating business before live checkout. Those settings are not created automatically.
8. Verify Supabase fresh signup, email delivery, return URLs, two-account isolation, a free scan, a private trial preview, paid checkout, webhook delivery, campaign allowance exhaustion, video credits and cancellation in a preview environment.
9. Configure a managed scheduler to call the existing authenticated `/api/tick` endpoint. Vercel Cron can do so on an appropriate commercial plan; this branch does not upgrade a hosting plan or create a paid external service. The tick also polls accepted media jobs and stores completed assets without an open customer tab. Campaign locking serializes media follow-ups. The dashboard shows the most recent tick and browser-job queue/stale-job counts.
10. Replace the Mac-based browser worker with managed infrastructure before promising unattended ad-library scans. The existing worker still handles browser-only stores and Meta scanning. This branch adds billing/admin visibility, not a replacement browser service.

## Trial and allowance policy

A free account receives one draft campaign. The trial text budget is $3 of estimated provider cost; it cannot publish or generate media. Paid plans include 5 / 20 / 75 builds, 5 / 20 / 75 active products, and 200 / 800 / 3,000 images per billing period. Text calls share a provider-cost pool of $5 per included build per period, including revisions. Calls reserve an upper bound before submission and reconcile reported usage afterwards. A reserved call can be refused when its maximum cost exceeds remaining budget, even if its eventual actual cost might have fit. This prevents concurrent calls overspending.

Builds consume quota transactionally at campaign creation. Failed builds currently need operator-reviewed allowance adjustment; they are not automatically refunded, since failure may follow real provider spend. The free-trial allowance is recorded independently of campaigns, so deleting a campaign cannot obtain another trial.

Video credits do not roll over by period because they are a separate persistent balance. An active subscription is required to spend them. Confirmed zero-charge failed media tasks release the original image/video allowance once. Unknown or billed failures keep their charge. Refunds of video packs reverse purchased credits proportionally, rounding up whole credits; balances may become negative if credits were already spent.

Each browser checkout attempt carries an order identifier retained across retries. Retrying that attempt opens the same checkout; a new purchase after returning to billing gets a new identifier. Subscription checkout also has a server-stored attempt identifier to prevent duplicate subscriptions after uncertain network outcomes.

Archiving stops public serving and frees an active-product slot; it does not refund generation/build credits. Public pages require an active or past-due subscription within a seven-day publishing grace after the billing period. Canceled/unpaid accounts stop publishing once status is reconciled. Cached pages may persist until invalidated or revalidated (currently 60 seconds); archiving explicitly invalidates the affected page paths.

## Existing customers and data

The migration synchronizes existing auth users, preserves usage where recorded and marks accounts with previous campaigns as having already used their free trial. Existing users **do not silently receive paid access**. Without a subscription, existing generation pauses and public serving becomes gated. Plan the migration for any current paying/pilot customers before deploying; map existing Stripe subscriptions or grant explicitly recorded entitlements through a reviewed migration rather than bypassing checks.

Admin sessions last eight hours and use HttpOnly, Secure-in-production, SameSite=Strict cookies with a signed expiry. Five failed attempts per IP hash per 15-minute window are enforced in PostgreSQL. Put the endpoint behind the deployment firewall's additional bot/rate controls before broad exposure. There is no default password.

## Validation

`npm run test:saas` applies the complete migration chain to isolated PGlite PostgreSQL and tests actual SQL behavior. It does not touch Supabase or buy generation. Additional tests verify password hashing, session tamper/expiry/rotation, webhook signature/replay windows, plan validation and safe product fetching. Production build: `npm run build -- --webpack`. The alternate builder avoids the local Turbopack sandbox restriction.

Still required before production: Stripe test-mode checkout/portal/webhook journeys; real Supabase email confirmations, rate-limit headers and RLS policies in the deployed environment; refund/chargeback operational procedure; provider-cost invoice reconciliation; load testing; managed browser execution. Merchant custom domains and Shopify purchase/ROAS attribution remain future integrations. The owner dashboard measures the SaaS business; it does not claim to measure merchants' Shopify sales.

Local verification completed: full migration-chain and SaaS security tests, TypeScript, targeted ESLint, production webpack build, and HTTP checks for `/admin`, `/pricing`, `/billing` (200) plus unauthenticated metrics, billing and tick endpoints (401). These checks used no live customer data or paid provider calls.

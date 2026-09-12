# AdtoCart: SaaS launch analysis and execution plan

Prepared 12 September 2026 from the Kurrajong Rd voice memo, the local ad-assist repository, the live homepage and the linked primary sources. Customer pricing is in **USD**, as confirmed by David. Prices below are proposed experiments, not live offers. Revenue targets refer to subscription MRR, excluding tax and one-off credit purchases.

## The decision

Build a product-led SaaS for Shopify merchants who already buy traffic. Let a visitor scan a product before signup, show the real findings, then ask for an account. Offer a small, bounded campaign preview after signup; require a paid plan before full campaign generation and publishing. Sell recurring campaign capacity with a separate video allowance. Do not offer unlimited paid AI generation.

Position the product around **matching an ad’s buying reason to its landing page**, rather than producing 60 assets. Producing more assets is useful only if a merchant can select, launch and measure them. Start with three to five strong angles in the launch workflow, while retaining the existing twenty-persona capability for expansion. Do not ask a small merchant to split a limited ad budget across sixty ads at once.

A million dollars a month is a scale target, not evidence of demand. The immediate objective is ten paying merchants who actually launch campaigns, followed by a retained cohort of one hundred.

## What already exists, and what does not

| Area | Evidence from current code | Launch implication |
|---|---|---|
| Accounts | Supabase password login, email signup links, Google-provider check, persistent browser session and authenticated API routes already exist | This is not a set of disconnected login mockups. Verify production provider settings, redirects and email delivery |
| Ownership | Campaigns have a user owner; authenticated routes check ownership; database tables have RLS | Test two different customers against every read/write and storage route before general availability |
| Product ingestion | Server fetch and structured extraction first; Mac browser fallback for blocked stores | A free scan can run without AI spend or the Mac; some stores will fail honestly |
| Campaign workflow | Product brief, base page, review gate, personas, published pages, ad-library scan, ad ideas, approved media generation | Substantial working product, but not subscription commerce |
| Background progress | Per-campaign lock and one-unit advance route; Mac worker pokes the tick route | The claim that everything runs while the laptop is closed is not yet generally true |
| Billing | No subscription checkout, webhook reconciliation or subscription entitlements found | Paid plans must not be advertised as purchasable yet |
| Limits | Campaign-level media spending controls exist; no monthly tenant campaign allowance | Current public signup can create provider costs without subscription revenue |
| Costs | KIE media ledger exists; most model usage was discarded by callers | Historical exact full-campaign costs cannot be reconstructed from the repository |
| Pages | Public `/p/{campaign}/{persona}` routes hosted by the app | Hosted pages already work as the architectural default |
| Measurement | View and click counters; outbound CTA link does not carry a dedicated attribution contract | Counts are not unique visitors, purchases, revenue or ROAS |

The local checkout has no `.env.local` configuration. Production credentials, billing settings and historical provider invoices were not available in this checkout. No paid campaign was run to manufacture a cost estimate.

## Changes implemented in this task

The local changes add `/start` and `/api/free-scan`, change the homepage CTA to **Start for free**, show a real product scan before signup, and preserve the URL/title for the wizard. A server-saved scan can seed the authenticated campaign without a second scrape, provided it is the same product URL, same browser and within 24 hours. Signup in another browser still works but cannot reuse that browser’s scan cookie.

The scan reports product name, brand, price when available, image count, readable review count and a text excerpt. It does not invent a score, missing review, persona or completed AI step. The progress panel describes the request actually running; it does not show a fabricated percentage. A blocked or unreadable store returns an error and a retry path.

The public endpoint is disabled until `FREE_SCAN_SECRET` is configured. Migration 0020 adds server-only scan storage and transactional daily limits: three attempts per IP hash and 500 total attempts per rolling daily window. Expired records are cleaned on subsequent quota reservations. Retention is therefore logically 24 hours but physical deletion waits for another request; schedule cleanup if strict deletion timing is needed. The IP is keyed-hashed rather than stored raw. Vercel’s trusted forwarded header supplies the address; other production hosts require an explicitly trusted equivalent. Invalid URLs, private/reserved addresses, unsafe redirects, large responses and long requests are constrained. Connections pin the validated IPv4 address to prevent a second DNS lookup from reaching a private service. IPv6-only stores are not supported by this reader yet.

Migration 0021 and central model instrumentation record provider response IDs, model, input/cached/output tokens, response status, a standard-price USD estimate, and the campaign/stage for the main pipeline. Refusals and incomplete responses with usage are included. Usage is logged before local schema validation. Calls outside the main pipeline are currently recorded as unassigned; network failures without a response and hidden provider/SDK retries require invoice reconciliation. Unknown model rates remain unknown, not zero. Database recording failures also leave a structured usage event in server logs. This is cost visibility, not a subscription spending cap.

The homepage now avoids presenting long-running competitor ads as proven profitable ads.

**These are local changes, not a deployed paid SaaS.** Subscription billing, monthly allowances, Shopify purchase tracking and a managed browser worker remain separate launch work below.

## Signup and payment sequence

1. **Before signup:** One public product scan. Show the found facts and gaps. No OpenAI or KIE generation here.
2. **After the scan:** “Create account to continue.” Keep the scan visible. Email link or existing login; no credit card for the account.
3. **After signup, proposed next feature:** A tightly capped sample of one buyer angle and one unpublished page preview. One trial campaign per verified account, with server-side anti-abuse controls. Current code does not enforce this trial allowance yet.
4. **Before full generation/publishing:** Show the three plans, exact included campaign capacity, media allowance and optional video pricing. Preview must be valuable enough that the user understands what is being purchased.
5. **Before media generation:** Show quantity and credits, reserve credits atomically, and generate only approved assets. Never infer a paid upgrade from a click on a general CTA.

Make pricing visible on the marketing site once validated; do not deliberately conceal it until after signup. An account gate immediately after the scan is appropriate. A surprise three-tier purchase screen before showing the scan result is not.

For Supabase, test signup with a fresh email, the confirmation redirect back to `/campaigns?new=1`, password login, expired links, sign-out, session refresh and Google only when configured. An application-level missing-settings error does not establish that production signup is broken.

## Unit economics: what a complete run costs

The default model in the repository is GPT-5.5. Its published standard rates are $5 per million input tokens, $0.50 cached input and $30 output. Output includes reasoning usage. Requests above the documented long-context threshold have higher rates. [OpenAI GPT-5.5 model pricing](https://developers.openai.com/api/docs/models/gpt-5.5)

For ordinary-size individual requests:

`Text cost = (uncached input × $5 + cached input × $0.50 + output × $30) / 1,000,000`

The following are **illustrative totals across a campaign’s calls, not measurements**. They assume no cached-input discount and no individual request above the long-context threshold.

| Scenario | Total input | Total output, including reasoning | Text cost |
|---|---:|---:|---:|
| Light | 50,000 | 20,000 | $0.85 |
| Planning case | 150,000 | 100,000 | $3.75 |
| Heavy/revisions | 500,000 | 300,000 | $11.50 |

Do not equate a content-token maximum with actual usage. The code adds 24,000 reasoning tokens of headroom per call; unused headroom is not a charge. Revisions, rejected duplicate personas, format extraction, brand analysis and scene prompts all need to be counted.

The repository’s KIE configuration uses $0.005 per credit, four credits per image and 24.8 credits per second for ten-second 720p Seedance 2 Fast video without video input. That gives **$0.02 per image and $1.24 per ten-second video**. Current KIE model pricing could not be independently verified from an accessible primary model page, so treat these as configured estimates and reconcile them with the actual KIE dashboard before setting a customer allowance.

| Sixty generated assets | Configured media cost | With illustrative $3.75 text cost |
|---|---:|---:|
| 60 images (scenario; not the current wizard’s normal split) | $1.20 | $4.95 |
| 40 images + 20 videos (default 2:1 split) | $25.60 | $29.35 |
| 20 images + 40 videos | $50.00 | $53.75 |
| 60 videos (scenario) | $74.40 | $78.15 |

These figures exclude generated opening frames, landing-page images, retries, failed accepted media tasks, hosting, browser worker, storage/egress, payment fees, support, refunds, acquisition and taxes. For example, generating one opening frame for each of 20 videos adds $0.40 at the configured image rate. A 25% operational/retry reserve is a planning allowance, not a measured failure rate.

Ten fully generated default campaigns already imply $256 of media cost, before anything else. Fifty imply $1,280. An inexpensive plan promising 10 or 50 *fully rendered* campaigns would therefore lose money or have very weak margins.

### How to establish the actual number

Run a consented benchmark of 20–30 representative products after deployment and spending limits are in place. Include simple Shopify pages, long pages, missing reviews, sparse images, revision requests and blocked stores. Record p50 and p95 costs, not just the cheapest successful run. Reconcile response IDs and media task IDs against provider usage; include every attempt and any unknown billed outcomes.

Use a maximum combined budget agreed before the benchmark. The expensive benchmark was not run in this task. Historical ledger absence cannot be solved by pretending estimates are actuals.

A useful query after migration 0021 is:

```sql
select campaign_id, sum(input_tokens) input_tokens,
       sum(cached_tokens) cached_tokens, sum(output_tokens) output_tokens,
       sum(estimated_usd) known_text_usd,
       count(*) filter (where estimated_usd is null) unknown_rate_calls
from public.model_usage
group by campaign_id;
```

The null campaign group needs separate attribution. Join campaign-level summaries to the media ledger only after aggregating each ledger independently, to avoid multiplying rows and overstating costs.

## Proposed packages to test

Sell **campaign builds**, not vague “searches.” A build means one product source, up to 20 buyer pages and 60 ad ideas. Rebuilding the strategy for the same product consumes another build; fixing a platform-caused failure does not. Monthly build allowances reset on the paid billing cycle. Hosting capacity is separate from new-build credits so customers cannot accumulate unlimited live pages forever.

| Proposed plan | Monthly USD | Builds/month | Active products / pages | Included generated images/month | Video |
|---|---:|---:|---:|---:|---|
| Starter | $149 | 5 | 5 / up to 100 | 200 | Separately purchased |
| Growth | $499 | 20 | 20 / up to 400 | 800 | Separately purchased |
| Agency | $1,499 | 75 | 75 / up to 1,500 | 3,000 | Separately purchased |

These are candidate price/allowance pairs, not market-tested willingness to pay. Active products can retain their pages while the subscription continues; archiving a product frees hosting capacity but does not refund spent build credits. State cancellation, grace period, page removal and export policies clearly before launch. Agency workspaces, seats and merchant domains are planned features, not already implemented benefits.

At the illustrative $3.75 text cost and configured image rate, full included usage costs $22.75 / $91 / $341.25 respectively, leaving 84.7% / 81.8% / 77.2% before hosting, support, payment processing and other variable costs. At $11.50 text per build those fall to 58.7% / 50.7% / 38.5%. **This sensitivity is why measured p95 costs must determine final allowances.** A $1,499 plan cannot sustainably include 75 expensive, revision-heavy builds simply because its average case looks good.

Test a **$59 pack of ten ten-second video renders**, with the exact provider/model and length stated. At the configured rate, videos plus generated opening frames cost about $12.60 before retries. Avoid tokens as the customer unit: one video render is understandable. No automatic overage billing initially; ask the customer to buy another pack. Credit expiry, refunds and consumption for failed tasks must be defined consistently with provider billing and consumer obligations.

David’s proposed 10-product Starter and 50-product Growth can be later variants, but not at the same prices without checking margins. Prefer proving value for five products over advertising a large unused quota. Do not offer unlimited generation; offer a negotiated high-volume contract with explicit capacity and media limits.

## Hosting, cart experience and attribution

**Keep hosted pages as the default.** Add `offers.merchant.com` as a verified merchant domain once the publishing system supports tenant routing. Vercel supports multi-tenant domains, including customer subdomains. This lets the merchant keep branding while AdtoCart controls updates and performance. [Vercel domains](https://vercel.com/docs/domains/working-with-domains)

Vercel can serve this architecture; it does not eliminate capacity planning. Use a commercial plan. The current public pricing page lists Pro from $20/month and describes Hobby as non-commercial. Supabase lists Pro from $25/month. These are starting platform charges, not an all-in operating budget. [Vercel pricing](https://vercel.com/pricing) · [Supabase pricing](https://supabase.com/pricing)

The scaling variable is traffic and page/media weight, not just page count. For illustration, one million visits × 1 MB transferred is roughly 1 TB before repeat-cache effects. Cache published page data, invalidate on publish, serve media through storage/CDN, avoid a model call on any buyer-page request and set spend alerts. Load-test at expected concurrency before promising an SLA.

Keep checkout on the merchant’s Shopify store. A buyer should click through with selected variant/offer information preserved where supported. Do not create a second checkout. HTML export can be a later escape hatch for agencies, but making it the default creates hosting, theme, analytics and update work for every merchant. Native Shopify publishing becomes worthwhile after validation, not as a prerequisite to the first ten customers.

Implement an attribution contract: campaign ID, persona/angle ID, ad ID, UTMs and a non-sensitive click identifier survive the outbound link. Capture landing views and outbound clicks, then connect purchases through a merchant-installed Shopify integration. Shopify exposes `checkout_completed` and product/cart events through its Web Pixels API. Consent and browser limitations mean this still is not perfect attribution. [Shopify standard events](https://shopify.dev/docs/api/web-pixels-api/standard-events)

For server purchase events, use authenticated Shopify webhooks, verify signatures, deduplicate by shop/order/event, reconcile refunds and avoid double-counting browser and server reports. Connect the merchant’s own analytics/advertising destinations. Verify the purchase journey across domains before showing revenue or ROAS. Current counters must continue to be labelled views/clicks, not customers/sales.

## How to acquire customers

Start with established Shopify brands already spending on paid social and frequently testing creative. Founder-led stores with no ad budget will struggle to evaluate sixty ads and are a weak initial segment. Choose one demonstrable vertical and onboard ten design partners manually.

The initial offer: “Turn one product into three distinct buying angles, each with a matching ad and page. Launch a controlled test in your existing account.” Sell saved production time first; promise sales improvement only when a controlled result supports it. Track asset acceptance, time to launch, conversion and contribution margin, not just clicks.

Use three channels in order:

1. **Direct demonstrations:** Prepare short, product-specific walkthroughs for a small list of relevant merchants. Send only after an approved outreach campaign is ready; no messages were sent in this task. Ask for a paid pilot, not vague feedback.
2. **Agency partners:** Recruit five Shopify/paid-social agencies who can repeatedly introduce suitable merchants. Shopify’s Partner Directory includes marketing services and can identify potential partners; listing eligibility is separate from merely joining a program. [Shopify Partner Directory](https://help.shopify.com/en/manual/partner-directory)
3. **Webinars and measured paid acquisition:** Use real before/after workflow examples and permissioned outcomes. Begin with agency audiences and existing contacts; use cold paid traffic only when activation and retention are demonstrated.

A webinar is a useful demonstration, not a distribution strategy by itself. Run a 30-minute live session: five minutes on message mismatch, ten minutes turning a real product into three buyer angles, five minutes approving a page/ad pair, five minutes showing a measurement plan and five minutes for questions and the pilot offer. Have a clearly labelled recorded fallback if the store blocks scanning. Do not fabricate live results or describe competitor longevity as proven profitability.

Suggested title: **One product, three reasons to buy: build ads and landing pages that tell the same story.**

Suggested invitation copy: “Bring one product page. We’ll show how to turn three different buying reasons into matching ad-and-page pairs, and how to test them in your existing store.”

A first funnel experiment, entirely hypothetical: 200 registrations → 80 attendees → 24 scans → 12 activated accounts → 4 paid customers. At $499 each, that is $1,996 new MRR. With $2,000 acquisition/event cost, CAC is $500. At 75% contribution margin, simple payback is about 1.34 months before churn. Replace every assumption with observed data. Four conversions could be zero; do not treat this illustration as a forecast.

## The path to $1 million MRR

| Average monthly subscription revenue/customer | Customers required, rounded up |
|---|---:|
| $149 | 6,712 |
| $499 | 2,005 |
| $1,499 | 668 |

A hypothetical mix of 60% Starter, 30% Growth and 10% Agency gives $389 ARPA. It requires **2,571 customers**, producing $1,000,119 MRR. At a hypothetical 3% monthly customer churn, about 77 customers must be replaced each month just to stay level. At 5%, about 129. Revenue, logo churn and expansion must be tracked separately.

At that mix and full quota use, 2,571 customers imply approximately 42,422 new builds per month, about 848,430 potential active pages at the included capacity, and up to 2.55 million ad ideas generated monthly. This is a capacity scenario, not a forecast. The Mac worker cannot be the operating model at this scale.

At $389 ARPA and an assumed 75% contribution margin, three-month CAC payback implies a CAC ceiling of about $875. This is a planning threshold, not permission to spend it. Validate retention before scaling toward that ceiling.

## Execution sequence and launch gates

**Now: product-led entry and measurement foundation.** Local scan and model-usage changes are ready for review. Apply only migrations 0020 and 0021 to the intended Supabase project; configure the scan secret and existing app credentials; deploy a preview; test scan → signup → same-product campaign. Validate quotas under concurrent requests and expiry against a real test database. Confirm Supabase email delivery and two-user isolation.

**Next: paid beta.** Implement checkout and customer billing portal, signed/idempotent webhook handling, plan entitlements, transactional allowance reservations/refunds, media credits, failed-payment grace periods and cancellation behavior. Do not grant paid access just because the browser returns from checkout; reconcile provider events server-side. Stripe’s subscription documentation describes the necessary event-driven lifecycle. [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks?locale=en-GB)

Gate campaign creation, every paid regeneration path, background tick work and media submission. A limit on one screen is not a spending limit. Move the tick driver and browser workload onto managed infrastructure with job leases, retry budgets, failure alerts and per-tenant concurrency. Review source access requirements before relying on ad-library scraping at scale.

**Then: ten paying pilots.** Measure cost per accepted campaign, approval-to-launch rate, time saved and repeated weekly use. Benchmark 20–30 products under an explicit spending ceiling. Test the three price points with real buyers. Set a target of 70–80% contribution margin after direct costs, and reduce allowances if the measured cost distribution does not support it.

**Then: 100 retained accounts.** Add merchant-domain publishing and Shopify purchase attribution, support workflows and agency workspace separation. Run weekly partner demos and a webinar. Measure 30/60/90-day retention; stop scaling acquisition if users are not launching or returning.

**Scale only after the cohorts support it.** Add capacity based on observed traffic, queue delays and costs. Revisit annual commitments and high-volume contracts after the monthly product retains customers. The $1 million target is achievable only if retention, distribution and margins work together; producing a large number of assets does not establish any of those.

## What is needed to activate the local changes

The current checkout lacks deployment configuration and connected production credentials. The new tables have not been applied to Supabase, and the changes have not been pushed or deployed. A working preview needs the intended Supabase environment and `FREE_SCAN_SECRET`, followed by the migration and integration checks above. Final package prices, Stripe product configuration and paid benchmark spending are not committed by this report.


## Implementation follow-through

The `codex/saas-billing-admin-dashboard` branch implements the free scan, USD subscriptions and allowances, password-protected owner dashboard, account-level provider usage, private trial previews and background media polling. See [SaaS operations](SAAS_OPERATIONS.md) for configuration, validation and outstanding launch integrations. This implementation has not been deployed or connected to live billing.

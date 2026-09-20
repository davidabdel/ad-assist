# Netlify Free migration

Owner selected Netlify Free on 20 September 2026, declining a new paid hosting subscription and website hosting on the VPS. This supersedes the earlier Vercel upgrade decision. No paid Netlify plan, add-on, or automatic credit purchase is authorized. Supabase, Stripe and ImprovMX remain in place. The live domain stays on the existing release until a Netlify preview passes checks.

Netlify supports modern Next.js through its automatically provisioned OpenNext adapter. `netlify.toml` defines the build, `.next` output and Node 22. `.netlify` local state is excluded from Git. Environment secrets must be imported through the authenticated service, not committed or placed in public assets.

Compatibility gates:

- Ordinary Netlify functions have a 60-second ceiling. Existing tick/advance/assets handlers allow 300 seconds and idea generation 180 seconds. Do not assume Next.js `maxDuration` raises Netlify's ceiling.
- Background functions allow 15 minutes on credit-based plans including Free. Adapt slow operations to background jobs with authenticated dispatch, ownership checks, idempotency, persistent status and bounded recovery before switching production.
- Scheduled functions have a 30-second ceiling: use them only to enqueue work, not run the existing full pipeline.
- Browser-based store/Meta scanning needs a supported runtime. Netlify website deployment alone does not replace the prepared persistent Chromium worker. Confirm the intended scanner location before activation; the owner's latest VPS rejection must not be treated as permission to activate it.
- Free currently includes 300 credits per month across builds, compute, requests and bandwidth. Avoid a ten-second idle scheduler that spends those credits continuously. Reaching limits can pause projects.
- Import exact live Stripe prices, rotated key, non-default portal and webhook secret, Supabase credentials, AI keys, admin hash/session secret and scan/cron secrets from private local records. Never print their values. Keep the webhook disabled until the canonical domain points to a validated release.
- Verify customer authentication, billing, admin access, public owner pages, async job recovery, actual webhook delivery and DNS/TLS. The owner has skipped paid AI generation tests; that remains an explicit unverified gate.

Sources checked 20 September 2026:
- https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/
- https://docs.netlify.com/build/functions/configuration/
- https://docs.netlify.com/build/functions/background-functions/
- https://docs.netlify.com/build/functions/scheduled-functions/
- https://www.netlify.com/pricing/

Current status: login tab opened; owner login pending. Configuration is prepared only. No Netlify project, secret transfer, deployment or DNS change has been completed.

## Progress — 21 September 2026

Authenticated CLI access found the existing UConnect team (`david-gmao3jq`), verified Free with 300 monthly credits and automatic top-ups disabled. Created linked project `adtocart-480` (`5859c01b-d0c3-4e45-9165-580c6f7eae81`); the plain adtocart name was unavailable. Existing team projects are unchanged.

Owner explicitly approved transferring the existing runtime secrets into Netlify after automatic approval review requested destination-specific permission. Import succeeded without exposing values. The first draft preview served pricing (200) and denied unauthenticated admin metrics (401). No production publish or DNS switch has occurred.

Added service-only `background_jobs` migration 0028 after all migrations passed isolated PostgreSQL tests. The migration applied successfully to hosted Supabase. Existing campaigns and billing records were not modified. Job payloads contain operation paths/bodies, never user tokens. Unique active fingerprints and conditional claims prevent simultaneous duplicate execution. Results are owner-scoped through an authenticated API. Slow campaign routes dispatch to a Netlify background function; the client waits for the persisted result. Stale attempts require explicit review/retry rather than automatic repetition of potentially paid actions.

The first disposable-account runtime test found the NETLIFY build flag absent from the deployed runtime: it returned the route's normal 404 instead of dispatching. Replaced the detection with explicit `ADTOCART_BACKGROUND_MODE=netlify` and `ADTOCART_NETLIFY_ORIGIN`; these were saved to the project. Updated preview deployment and repeated runtime verification are pending. The disposable test account and its associated records were removed. No AI generation or payment ran.

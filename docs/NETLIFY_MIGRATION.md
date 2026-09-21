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

Current status: Netlify project, credential transfer and subdomain deployment are complete. Background runtime checks pass. Browser scanner hosting, remaining launch checks and canonical domain cutover are outstanding. No DNS change has been made.

## Progress — 21 September 2026

Authenticated CLI access found the existing UConnect team (`david-gmao3jq`), verified Free with 300 monthly credits and automatic top-ups disabled. Created linked project `adtocart-480` (`5859c01b-d0c3-4e45-9165-580c6f7eae81`); the plain adtocart name was unavailable. Existing team projects are unchanged.

Owner explicitly approved transferring the existing runtime secrets into Netlify after automatic approval review requested destination-specific permission. Import succeeded without exposing values. The first draft preview served pricing (200) and denied unauthenticated admin metrics (401). The Netlify subdomain was subsequently published for runtime checks; the customer domain still points to the existing Vercel release.

Added service-only `background_jobs` migration 0028 after all migrations passed isolated PostgreSQL tests. The migration applied successfully to hosted Supabase. Existing campaigns and billing records were not modified. Job payloads contain operation paths/bodies, never user tokens. Unique active fingerprints and conditional claims prevent simultaneous duplicate execution. Results are owner-scoped through an authenticated API. Slow campaign routes dispatch to a Netlify background function; the client waits for the persisted result. Stale attempts require explicit review/retry rather than automatic repetition of potentially paid actions.

The first disposable-account runtime test found the NETLIFY build flag absent from the deployed runtime: it returned the route's normal 404 instead of dispatching. Replaced the detection with explicit `ADTOCART_BACKGROUND_MODE=netlify` and `ADTOCART_NETLIFY_ORIGIN`; these were saved to the project. Updated preview deployment and repeated runtime verification are pending. The disposable test account and its associated records were removed. No AI generation or payment ran.


### Verified background runtime

Netlify's version-2 function packager forces NFT, so `node_bundler = "esbuild"` did not change the emitted worker. Its CommonJS conversion selected linkedom's CommonJS entry point, which cannot require the ESM-only css-select dependency. Changed both parser consumers to dynamic ESM imports and removed the ineffective bundler override. The actual packaged worker now imports successfully, rejects unauthenticated requests, and loads the HTML parser; `node scripts/netlify-package-check.mjs` repeats this offline regression check after a Netlify build.

Type checking and Netlify build passed. A disposable live auth account verified authenticated dispatch, a harmless missing-idea 404 persisted by the background worker, successful empty-campaign media polling (200), authenticated status polling and anonymous rejection (401). Account and cascading records were removed. No AI generation, provider task, email, or payment was performed. This does not replace the skipped paid end-to-end test or validate browser scanning.

Cloudflare login is complete for the eventual domain cutover. DNS and the disabled canonical Stripe webhook remain unchanged. Browser scanning and unattended pipeline processing still need a supported deployment; the rejected VPS has not been activated.

Verified Netlify deployment: `6ab090e1a66ab6d9abad150d` (https://6ab090e1a66ab6d9abad150d--adtocart-480.netlify.app).


### Domain preparation and remaining scanner decision

Owner signed into Cloudflare on 21 September. Verified zone `0b7f41f4a5daceac8831a0e2b7d12605` in account `d4d08355f5a6cdca4ac2128790daeb28`. Both `@` and `www` are DNS-only CNAME records targeting `51354bfe89f7d239.vercel-dns-017.com`, TTL Auto. These are the exact rollback targets; the apex A records seen by DNS resolvers are flattened results, not editable A records. Six ImprovMX mail/verification records were inspected and remain untouched.

Added `adtocart.cc` to Netlify, which also adds `www.adtocart.cc`. DNS has NOT switched. Netlify initially selected the apex as primary; changing to `www` was temporarily refused while certificate provisioning was in progress. Set `www` as primary before cutover, matching existing application/auth/Stripe URLs. Netlify's domain panel specifies `www CNAME adtocart-480.netlify.app`; use the documented `apex-loadbalancer.netlify.com` flattened CNAME for the apex. Certificate validation remains pending until DNS points to Netlify. Do not remove the Vercel rollback deployment.

The browser scanner is still unresolved. Asked the owner to choose adapting it to Netlify versus running the existing worker on an always-awake Mac. No existing VPS activation is authorized by this question. Customer-facing launch must not claim scanning works until the selected runtime is implemented and verified.

### Admin and free-scan host compatibility

A live Netlify admin sign-in check returned 503 because the login route only accepted Vercel's gateway. Free-scan rate limiting also used one development bucket for all non-Vercel users. Both now use a shared trusted-address helper: Netlify's official `getContext().ip`, Vercel's dedicated header only on Vercel, and a development bucket only in explicit development/test mode. Unknown production gateways fail closed; caller-provided forwarding headers cannot select a Netlify rate-limit bucket. Added the official `@netlify/functions` runtime dependency. Offline context/spoofing checks and type checking passed; the draft preview passed admin login, authenticated metrics, logout, anonymous metrics rejection, and private-address scan rejection. The fix is not yet published to the main Netlify subdomain.

The owner said continue after the scanner choice was presented. Proceeding with Netlify adaptation; do not activate the VPS or require the Mac.

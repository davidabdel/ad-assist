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

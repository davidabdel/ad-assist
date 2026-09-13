# Scanner hosting preparation

The worker can run in headless Chromium on a Linux host. It pulls jobs from Supabase and invokes Vercel's authenticated tick endpoint. No inbound public port is needed. The existing Mac workflow remains available during preparation.

Build from the repository root (the worker imports the shared product extractor):

```sh
docker build -f scanner/Dockerfile -t adtocart-scanner .
```

Provide secrets through the host's secret manager: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TICK_URL` (the intended deployment's `/api/tick` URL), and `CRON_SECRET`. Configure the same `CRON_SECRET` on Vercel. Set a unique `SCANNER_WORKER_ID` for each instance. Never point a test worker at production credentials.

Start with one replica and `SCANNER_CONCURRENCY=1`. The image runs as a non-root user and keeps Chrome's debugging interface private. Chromium's sandbox must be supported by the host; do not disable it to bypass a runtime incompatibility. Allocate adequate shared memory (for Docker, `--shm-size=1g`) and give the container an extended stop timeout so active jobs can complete. The worker stops claiming on SIGTERM/SIGINT and drains active work. A killed host leaves jobs for the existing five-minute stale-job recovery.

A Linux/headless deployment can receive different storefront or Meta responses from a Mac. Before relying on it, verify a representative store, ad-library scan, restart/recovery and full queued campaign in the selected host. The complete image builds on the existing Contabo VPS. The browser reports active PID/network namespaces and Seccomp-BPF sandboxing; shared extractor imports and page rendering are covered by `scanner/src/browser-smoke.js`. A full queued campaign and restart/recovery remain to be verified. No paid worker service has been created.

Do not run the persistent browser worker inside Vercel request functions. The Vercel plan upgrade covers the app and scheduler, not this separate browser runtime. Existing always-on Linux infrastructure may avoid another subscription; otherwise the operator must select and approve hosting before launch.


## Verified container runtime

The VPS is Ubuntu 24.04 with Docker. The image explicitly installs `chromium-sandbox` and runs as `node`. Use the checked-in seccomp profile to allow Chromium to create its namespaces while retaining the profile's default-deny syscall policy:

```sh
docker run --rm --shm-size=1g --memory=2g --cpus=2 \
  --security-opt seccomp="$(pwd)/scanner/seccomp-chromium.json" \
  adtocart-scanner node src/browser-smoke.js
```

The profile is from [Microsoft Playwright's Docker configuration](https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json), retrieved 13 September 2026, with its Apache 2.0 license in `scanner/LICENSE.seccomp`. SHA-256: `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`. See [upstream namespace guidance](https://playwright.dev/docs/docker#crawling-and-scraping). Neither privileged mode nor SYS_ADMIN capability is required by the verified browser check. The host's AppArmor restrictions remain enabled.

Do not connect customer jobs until outbound private-network access is restricted and tested, the queued pipeline has passed, and the selected deployment's secrets are installed securely. No production worker has been activated.


## Network isolation and hosted checks (13 September 2026)

`scanner/host/network.sh` creates the IPv4-only `adtocart-scanner` bridge. It rejects private/reserved destinations, all connections to the host, and outbound ports other than public TCP 80/443. Docker's embedded DNS remains available. These rules are scoped to that bridge and do not alter SSH access or other networks. The systemd unit restores them after Docker starts; a future worker unit must require `adtocart-network.service` and use `--network adtocart-scanner`.

Verified `network-smoke.js`: public HTTPS succeeds; bridge gateways, private space, metadata address and the VPS public IP are blocked. Chromium rendering and the full shared extractor passed. A live Allbirds US product returned its Shopify product name, price and four images in 34 seconds. No on-page reviews were found, which the scanner explicitly reports. The previous AU sample redirected to the homepage and was correctly flagged as not product data. Meta Ad Library also passed on the isolated network: a capped US image search returned five ads in 13 seconds, including one within the 90–365 day qualification window. A full queued campaign and restart/recovery still require validation.

# Scanner hosting preparation

The worker can run in headless Chromium on a Linux host. It pulls jobs from Supabase and invokes Vercel's authenticated tick endpoint. No inbound public port is needed. The existing Mac workflow remains available during preparation.

Build from the scanner directory:

```sh
docker build -t adtocart-scanner ./scanner
```

Provide secrets through the host's secret manager: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TICK_URL` (the intended deployment's `/api/tick` URL), and `CRON_SECRET`. Configure the same `CRON_SECRET` on Vercel. Set a unique `SCANNER_WORKER_ID` for each instance. Never point a test worker at production credentials.

Start with one replica and `SCANNER_CONCURRENCY=1`. The image runs as a non-root user and keeps Chrome's debugging interface private. Chromium's sandbox must be supported by the host; do not disable it to bypass a runtime incompatibility. Allocate adequate shared memory (for Docker, `--shm-size=1g`) and give the container an extended stop timeout so active jobs can complete. The worker stops claiming on SIGTERM/SIGINT and drains active work. A killed host leaves jobs for the existing five-minute stale-job recovery.

A Linux/headless deployment can receive different storefront or Meta responses from a Mac. Before relying on it, verify a representative store, ad-library scan, restart/recovery and full queued campaign in the selected host. A container build and hosted browser journey have not yet been validated. No paid worker service has been created.

Do not run the persistent browser worker inside Vercel request functions. The Vercel plan upgrade covers the app and scheduler, not this separate browser runtime. Existing always-on Linux infrastructure may avoid another subscription; otherwise the operator must select and approve hosting before launch.

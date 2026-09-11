# Ad Assist

One product URL in → 20 buyer personas → 20 live listicle landing pages → a Meta
Ad Library scan for winning formats → 60 ad ideas in an approval table → KIE
generates only the rows you approve.

Nothing bills until you click Approve.

## It runs in two halves

**Vercel + Supabase** serves the dashboard and the 20 public `/p/` pages. Those
have to be reachable 24/7 or Meta ad review rejects the destination.

**A Node worker on David's Mac** does everything that needs a real browser:
scraping the product page, and scanning the Meta Ad Library. Meta and most
storefronts do not cooperate with a headless fetch, and there is no Apify.

The two halves talk **only** through the `scanner_jobs` table. There is no
inbound connection to the Mac — the worker polls, claims a row with
`FOR UPDATE SKIP LOCKED`, and writes results back. Consequence worth knowing:
**a campaign cannot start while the Mac is asleep.** The UI says so rather than
looking stuck.

The worker also **drives the pipeline**, by POSTing `/api/tick` every ten
seconds. It does none of that work itself — the writing stays on the server —
it only says "keep going", which is all an open browser tab was ever doing. See
the pipeline section below for why that moved.

## Running it

```bash
cp .env.example .env.local     # fill in Supabase, OpenAI, KIE
npm install && npm run dev     # app on :3000

cd scanner && npm install
npm start                      # worker; opens a real Chrome window
```

Apply the database schema (no `supabase` CLI or `psql` needed — this goes
through the Management API):

```bash
./scripts/db-apply.sh                                    # all migrations
./scripts/db-apply.sh supabase/migrations/0005_*.sql     # just one
```

Prove the whole pipeline actually runs, end to end, against the live database
and the live model — this one **spends money**:

```bash
./scripts/smoke-pipeline.sh            # scrape → brief → base page → 20 personas
./scripts/smoke-pipeline.sh --cleanup  # delete the throwaway owner and its rows
```

## Pages and sign-in

| Path | What it is |
|---|---|
| `/` | adtocart.cc marketing page. Public, static |
| `/login` | Log in (email + password) or create an account (emailed link) |
| `/campaigns` | Your campaigns, or the wizard when there are none. `?new=1` opens the wizard |
| `/campaigns/{id}` | The build, the approval gate, the ad ideas table |
| `/p/...` | The public buyer pages. Outside the brand, on purpose |

**Sign-ups are open.** Anyone can make an account, and every campaign spends the
OpenAI and KIE keys this app runs on. Three Supabase settings under
Authentication decide whether that works:

- **Sign In / Providers → Email**: "Allow new users to sign up" on. Off, the
  Create account tab says sign-ups are closed.
- **Sign In / Providers → Google**: switch it on and add the Google client id
  and secret. Off, the Google button says so rather than sending people to a
  Supabase error page.
- **URL Configuration**: add the site's own URL plus `/campaigns` to the
  redirect allow list, or email links and Google send people to the Site URL
  instead of back to the app.

The visual design these pages were rebuilt from is in
`design/design_handoff_adtocart_saas/` — open the `.dc.html` files in a browser.

## The pipeline

Each `POST /api/campaigns/{id}/advance` does **one unit of work** and returns.
The unit is small on purpose: the full run is several minutes of model time,
which is longer than a serverless function may live, so splitting it means the
work survives a timeout, a deploy, or a closed laptop. There is no in-memory
progress — `campaigns.status` plus the rows that exist **is** the progress, and
every unit is idempotent.

**Two things call it, and neither can stop the other.** The dashboard, while it
is open; and `POST /api/tick`, which drives every campaign that has somewhere to
go. The tick exists because the dashboard used to be the only driver: lock a
phone, the tab freezes mid-wait with no error, and the run stops until somebody
looks at the screen again. `advance()` takes a per-campaign lock for the whole
unit, so two drivers is the ordinary case rather than a race — the second one is
told to wait.

**The tick is poked by the Mac worker, not by Vercel Cron.** This project is on
the Hobby plan, where a cron job fires once a *day*. On Pro it becomes a `crons`
entry in `vercel.json` against the same path, with `CRON_SECRET` set — the route
already accepts Vercel's header format, so nothing else changes.

| Status | What the next `advance` does |
|---|---|
| `pending` | Queues the ingest job |
| `scraping` | Waits for the worker, then writes the product brief |
| `personas` | Writes the base page, then 5 personas per call until there are 20 |
| `pages_built` | Done — 20 URLs are live. The ad scan is the next stage |

The response carries `waiting` (the next move belongs to the worker — back off)
and `terminal` (calling again changes nothing — finished, or failed and needing
a human).

## Things that are true and are easy to get wrong

- **The base page is written before the personas.** A persona overrides reasons
  1–3 of it, and reasons 4–10 have to hold for all twenty buyers — which is only
  true if they were written once for the product.
- **Persona diversity is enforced in code, not hoped for in the prompt.** A
  persona whose pain point normalises to one already taken is dropped and
  re-requested. After three fully-duplicate batches the campaign stops rather
  than ships near-identical pages.
- **A testimonial is never written.** Quotes are verbatim from the scrape or the
  field is left empty. Same for the brief: what the source did not say goes in
  `gaps`, it does not get filled in.
- **Raw competitor ad copy never reaches a copywriting prompt.** Scanned ads are
  stored for browsing; only extracted *structure* travels forward.
- **`claim_job`, `record_spend` and `reap_stale_jobs` are service-role only.**
  They are `security definer`, so they bypass RLS by design — the grant is the
  only gate, and the anon key ships in the browser on every `/p/` page.
- **`AD_ASSIST_MODEL`, not `OPENAI_MODEL`.** Agent harnesses export the latter
  with internal aliases the public API rejects.

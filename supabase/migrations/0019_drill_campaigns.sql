-- A campaign that exists only so a check script can drive the real routes.
--
-- WHY THIS IS A COLUMN AND NOT A NAMING CONVENTION. The verification scripts
-- seed real campaigns in the real database on purpose — asserting against a
-- mock of `advance()` is how the last two holes got shipped. But one of the
-- stages they drive through is `pages_built`, and `pages_built` queues real
-- ad_scan rows into `scanner_jobs`, which the launchd worker on David's Mac
-- drains within five seconds by opening a Chrome window and driving the Meta
-- Ad Library in it.
--
-- So running a check hijacked the machine: a browser window appearing out of
-- nowhere and scrolling Facebook, for a campaign that does not exist as far as
-- the operator is concerned. It looked exactly like the app re-scanning a
-- finished campaign, which is what it was reported as.
--
-- The fix is one bit the worker can see. A drill campaign's jobs are claimed
-- and closed without a browser: the row still gets queued, still gets claimed,
-- still gets completed — so every assertion about the QUEUE still holds — and
-- no Chrome opens. Nothing in the app sets this; only the scripts do.
alter table public.campaigns
  add column if not exists is_drill boolean not null default false;

comment on column public.campaigns.is_drill is
  'True only for campaigns created by scripts/*-check.mjs. The Mac worker '
  'completes their scanner jobs without opening Chrome.';

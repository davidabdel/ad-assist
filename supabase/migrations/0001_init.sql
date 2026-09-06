-- Ad Assist App — initial schema
-- Spec: PLANS/AD_ASSIST_APP_SPEC_V1.md (also on the channel canvas)
--
-- Change from spec v1: Firecrawl is out (David, 6 Sep). Product ingestion now runs
-- in the same local Chrome as the ad-library scan, so ingest and scan share ONE job
-- table and ONE claim loop in the scanner worker.

create extension if not exists "pgcrypto";

-- ─── users ────────────────────────────────────────────────────────────
-- Mirrors auth.users. Single-user for now, but campaigns stay owned so a
-- second login never means a schema migration.
create table public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text unique not null,
  created_at  timestamptz not null default now()
);

-- ─── campaigns ────────────────────────────────────────────────────────
create type campaign_status as enum (
  'pending', 'scraping', 'personas', 'pages_built',
  'scanning', 'extracting', 'ideas_ready', 'completed', 'failed'
);

create table public.campaigns (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users(id) on delete cascade,
  title          text not null,
  slug           text not null unique,
  source_url     text,
  raw_input_text text,
  checkout_url   text,
  current_offer  text,
  region         text not null default 'AU'
                 check (region in ('AU','US','GB','ALL')),
  media_split    jsonb not null default '{"static":2,"video":1}'::jsonb,
  scraped_data   jsonb,
  status         campaign_status not null default 'pending',
  error_message  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint campaigns_needs_input
    check (source_url is not null or raw_input_text is not null)
);
create index on public.campaigns (user_id, created_at desc);

-- ─── base_pages ───────────────────────────────────────────────────────
create table public.base_pages (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid not null unique references public.campaigns(id) on delete cascade,
  page_title       text not null,
  meta_description text,
  hero_headline    text not null,
  hero_subheadline text,
  reasons          jsonb not null,   -- 10 x {number,title,body,image_prompt}
  testimonials     jsonb not null default '[]'::jsonb,
  offer_headline   text not null,
  offer_body       text,
  cta_button_text  text not null,
  cta_url          text not null,
  created_at       timestamptz not null default now()
);

-- ─── personas ─────────────────────────────────────────────────────────
create table public.personas (
  id                   uuid primary key default gen_random_uuid(),
  campaign_id          uuid not null references public.campaigns(id) on delete cascade,
  persona_index        int  not null check (persona_index between 1 and 20),
  slug                 text not null,
  persona_name         text not null,
  primary_pain_point   text not null,
  core_desire          text not null,
  angle_hook           text not null,
  custom_topbar_notice text,
  custom_hero_headline text not null,
  custom_reasons       jsonb not null,  -- overrides reasons 1-3
  proof_quote          jsonb,           -- null when no real review fits. never fabricated.
  views_count          int not null default 0,
  clicks_count         int not null default 0,
  created_at           timestamptz not null default now(),
  -- scoped per campaign, NOT globally: two campaigns may both produce "gift-buyer"
  unique (campaign_id, slug),
  unique (campaign_id, persona_index)
);

-- ─── scanner_jobs ─────────────────────────────────────────────────────
-- The entire interface between the Vercel app and the Chrome worker on the Mac.
create type job_kind   as enum ('ingest', 'ad_scan');
create type job_status as enum ('queued', 'running', 'completed', 'failed');

create table public.scanner_jobs (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references public.campaigns(id) on delete cascade,
  kind          job_kind   not null,
  status        job_status not null default 'queued',
  -- ad_scan only
  region        text check (region in ('AU','US','GB')),
  media_type    text check (media_type in ('image','video')),
  search_terms  text[],
  -- ingest only
  target_url    text,
  -- claim / lease
  claimed_by    text,
  claimed_at    timestamptz,
  heartbeat_at  timestamptz,
  attempts      int not null default 0,
  -- results
  items_found     int not null default 0,
  items_qualified int not null default 0,
  notes           text,   -- e.g. "hit the 300-ad ceiling"; never silent truncation
  error_message   text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  constraint scanner_jobs_shape check (
    (kind = 'ad_scan' and region is not null and media_type is not null
                       and search_terms is not null)
    or
    (kind = 'ingest'  and target_url is not null)
  )
);
create index on public.scanner_jobs (status, created_at) where status = 'queued';
create index on public.scanner_jobs (campaign_id);

-- ─── scanned_ads ──────────────────────────────────────────────────────
-- Browsable by David. NEVER fed to a copywriting prompt.
create table public.scanned_ads (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null references public.scanner_jobs(id) on delete cascade,
  campaign_id         uuid not null references public.campaigns(id) on delete cascade,
  meta_ad_id          text not null,
  advertiser_name     text,
  advertiser_page_url text,
  region              text not null,
  media_type          text not null,
  is_active           boolean,
  started_running     date,
  days_running        int,
  qualified           boolean not null default false,  -- active AND 90+ days
  variant_count       int,
  primary_text        text,
  headline            text,
  description         text,
  cta_label           text,
  landing_url         text,
  creative_url        text,      -- storage path, our own copy
  thumbnail_url       text,
  video_metrics       jsonb,     -- measured: cut_count, avg_shot_len, hook_end_s, ...
  raw_payload         jsonb,
  scraped_at          timestamptz not null default now(),
  unique (campaign_id, meta_ad_id, region)
);
create index on public.scanned_ads (campaign_id, media_type, days_running desc);

-- ─── format_specs ─────────────────────────────────────────────────────
-- The firewall. Raw ad text goes in; only STRUCTURE comes out and travels forward.
create table public.format_specs (
  id                  uuid primary key default gen_random_uuid(),
  campaign_id         uuid not null references public.campaigns(id) on delete cascade,
  media_type          text not null check (media_type in ('image','video')),
  format_name         text not null,
  description         text not null,
  hook_pattern        text not null,
  visual_recipe       text not null,
  pacing              jsonb,
  offer_placement     text,
  observed_count      int  not null default 0,
  median_days_running int,
  example_ad_ids      uuid[] not null default '{}',
  created_at          timestamptz not null default now()
);
create index on public.format_specs (campaign_id, media_type);

-- ─── ad_ideas ─────────────────────────────────────────────────────────
create type idea_status as enum
  ('draft','approved','generating','generated','failed','rejected');

create table public.ad_ideas (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid not null references public.campaigns(id) on delete cascade,
  persona_id       uuid not null references public.personas(id) on delete cascade,
  idea_index       int  not null check (idea_index between 1 and 3),
  media_type       text not null check (media_type in ('image','video')),
  format_spec_id   uuid references public.format_specs(id) on delete set null,
  angle            text not null,
  hook             text not null,
  headline         text not null,
  primary_text     text not null,
  cta_label        text not null,
  visual_concept   text not null,
  them_vs_us       jsonb,
  kie_model        text not null,
  kie_prompt       text,
  video_storyboard jsonb,
  est_credits      int  not null,
  est_usd          numeric(10,2) not null,
  destination_url  text not null,
  status           idea_status not null default 'draft',
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (persona_id, idea_index),
  constraint ad_ideas_has_prompt check (
    (media_type = 'image' and kie_prompt is not null)
    or
    (media_type = 'video' and video_storyboard is not null)
  )
);
create index on public.ad_ideas (campaign_id, status);

-- ─── generated_assets ─────────────────────────────────────────────────
create type asset_state as enum ('submitted','generating','success','fail');

create table public.generated_assets (
  id              uuid primary key default gen_random_uuid(),
  ad_idea_id      uuid not null references public.ad_ideas(id) on delete cascade,
  clip_index      int,          -- null for statics, 1..3 for video clips
  kie_task_id     text not null,-- written BEFORE the first poll. KIE bills on submit.
  kie_model       text not null,
  state           asset_state not null default 'submitted',
  result_url      text,
  stored_url      text,
  credits_charged int,
  fail_reason     text,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);
create index on public.generated_assets (ad_idea_id);
create unique index on public.generated_assets (kie_task_id);

-- ─── spend ledger ─────────────────────────────────────────────────────
-- Enforces the per-campaign ceiling. Appended on submit, never on poll.
create table public.spend_log (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  asset_id    uuid references public.generated_assets(id) on delete set null,
  credits     int not null,
  usd         numeric(10,2) not null,
  note        text,
  created_at  timestamptz not null default now()
);
create index on public.spend_log (campaign_id);

create table public.settings (
  user_id                uuid primary key references public.users(id) on delete cascade,
  campaign_spend_ceiling numeric(10,2) not null default 150.00,
  video_model            text not null default 'bytedance/seedance-2-fast',
  image_model            text not null default 'google/nano-banana-edit',
  ad_search_ceiling      int  not null default 300,
  updated_at             timestamptz not null default now()
);

-- ─── updated_at ───────────────────────────────────────────────────────
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger campaigns_touch before update on public.campaigns
  for each row execute function public.touch_updated_at();

-- ─── RLS ──────────────────────────────────────────────────────────────
-- Everything is owner-scoped. The public /p/ pages are served by the service
-- role through a read-only RPC (0002), never by an anon table grant.
alter table public.users            enable row level security;
alter table public.campaigns        enable row level security;
alter table public.base_pages       enable row level security;
alter table public.personas         enable row level security;
alter table public.scanner_jobs     enable row level security;
alter table public.scanned_ads      enable row level security;
alter table public.format_specs     enable row level security;
alter table public.ad_ideas         enable row level security;
alter table public.generated_assets enable row level security;
alter table public.spend_log        enable row level security;
alter table public.settings         enable row level security;

create policy own_row on public.users
  for all using (id = auth.uid()) with check (id = auth.uid());

create policy own_campaigns on public.campaigns
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy own_settings on public.settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Child tables inherit ownership through campaign_id.
create or replace function public.owns_campaign(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.campaigns c
    where c.id = cid and c.user_id = auth.uid()
  );
$$;

create policy own_base_pages on public.base_pages
  for all using (public.owns_campaign(campaign_id))
  with check (public.owns_campaign(campaign_id));
create policy own_personas on public.personas
  for all using (public.owns_campaign(campaign_id))
  with check (public.owns_campaign(campaign_id));
create policy own_jobs on public.scanner_jobs
  for all using (public.owns_campaign(campaign_id))
  with check (public.owns_campaign(campaign_id));
create policy own_ads on public.scanned_ads
  for all using (public.owns_campaign(campaign_id))
  with check (public.owns_campaign(campaign_id));
create policy own_formats on public.format_specs
  for all using (public.owns_campaign(campaign_id))
  with check (public.owns_campaign(campaign_id));
create policy own_ideas on public.ad_ideas
  for all using (public.owns_campaign(campaign_id))
  with check (public.owns_campaign(campaign_id));
create policy own_spend on public.spend_log
  for all using (public.owns_campaign(campaign_id))
  with check (public.owns_campaign(campaign_id));
create policy own_assets on public.generated_assets
  for all using (exists (
    select 1 from public.ad_ideas i
    where i.id = ad_idea_id and public.owns_campaign(i.campaign_id)));

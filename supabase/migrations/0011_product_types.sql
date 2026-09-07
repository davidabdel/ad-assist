-- Three kinds of thing to sell, not one.
--
-- Until now every campaign was a physical e-commerce product read off a
-- storefront: a URL went in, a cart link came out, twenty pages went live. That
-- is one shape of sale, and two others break it in ways a flag cannot paper over.
--
--   ecom     a physical product. Unchanged. Many buyers, a cart, 20 pages.
--   ebook    a digital download. There is no storefront to read, so the source
--            is the PDF itself. Still many buyers, still a cart, still 20 pages.
--   vehicle  ONE car, ute, bike or boat. There is exactly one of it, nobody
--            checks out, and a buyer rings the seller. Five pages, and the CTA
--            is a phone number and an enquiry form.
--
-- WHY persona_target IS A COLUMN AND NOT A CONSTANT. Twenty landing pages for a
-- single 2019 Hilux is twenty pages competing for the same one sale. The count
-- is a property of what is being sold, so it is stored with the campaign rather
-- than branched on in the pipeline — and a campaign created before today keeps
-- the twenty it was built with.

create type product_type as enum ('ecom', 'ebook', 'vehicle');

alter table public.campaigns
  add column if not exists product_type product_type not null default 'ecom',
  add column if not exists persona_target int not null default 20
    check (persona_target between 1 and 20),
  -- The vehicle CTA. Null on every other kind, and null here is what the
  -- renderer reads to decide between "Buy now" and "Call the seller".
  add column if not exists contact_phone text,
  add column if not exists contact_name  text,
  -- The ebook itself, in storage. The pipeline reads its text instead of
  -- scraping a page.
  add column if not exists source_file_url text,
  -- Photographs the operator uploaded. A vehicle has no storefront gallery to
  -- read, so these ARE the image library; on the other kinds they are extra
  -- and sit in front of whatever the scrape found.
  add column if not exists uploaded_image_urls text[] not null default '{}';

-- The old constraint said a campaign must have a URL or pasted text. An ebook
-- campaign has neither — it has a file.
alter table public.campaigns drop constraint if exists campaigns_needs_input;
alter table public.campaigns add constraint campaigns_needs_input
  check (source_url is not null
      or raw_input_text is not null
      or source_file_url is not null);

-- ─── leads ────────────────────────────────────────────────────────────
-- Where the vehicle enquiry form lands.
--
-- No anon policy and no anon-callable RPC: the form posts to our own API route,
-- which writes with the service role. 0005 closed the anon write surface
-- deliberately and this does not reopen it — a public insert grant on a table
-- reachable from any browser is a spam queue with a schema.
create table if not exists public.leads (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  -- Which of the pages they were reading when they enquired. This is the whole
  -- reason for building five different pages, so it is not optional data.
  persona_id  uuid references public.personas(id) on delete set null,
  name        text not null check (length(name) between 1 and 120),
  phone       text not null check (length(phone) between 1 and 40),
  email       text check (email is null or length(email) <= 200),
  message     text check (message is null or length(message) <= 2000),
  -- Kept so a page that starts collecting junk can be told apart from one that
  -- is simply quiet.
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists leads_campaign_created
  on public.leads (campaign_id, created_at desc);

alter table public.leads enable row level security;
drop policy if exists own_leads on public.leads;
create policy own_leads on public.leads
  for all using (public.owns_campaign(campaign_id))
  with check (public.owns_campaign(campaign_id));

-- ─── uploads bucket ───────────────────────────────────────────────────
-- Public read, because these files are the pictures on public landing pages and
-- the PDF the operator gave us. Writes go through the service role only — there
-- is no storage policy granting anon or authenticated anything.
insert into storage.buckets (id, name, public)
values ('campaign-uploads', 'campaign-uploads', true)
on conflict (id) do update set public = true;

-- ─── the merge, with the sale shape ───────────────────────────────────
-- Two new fields, both campaign-level. A persona swaps words and photographs;
-- it never changes how the sale is closed.
create or replace function public.get_public_page(
  campaign_slug text,
  persona_slug  text default null
)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when b.id is null then null else jsonb_build_object(
    'campaign_id',   c.id,
    'persona_id',    p.id,
    'page_title',    coalesce(p.custom_hero_headline, b.page_title),
    'meta_description', b.meta_description,
    'topbar',        coalesce(p.custom_topbar_notice, c.current_offer),
    'headline',      coalesce(p.custom_hero_headline, b.hero_headline),
    'subheadline',   b.hero_subheadline,
    'hero_image_url', coalesce(p.custom_hero_image_url, b.hero_image_url),
    'hero_image_alt', coalesce(p.custom_hero_image_alt, b.hero_image_alt),
    -- 80/20: persona overrides reasons 1-3, the rest of the page is locked
    'reasons',       case when p.id is null then b.reasons
                     else p.custom_reasons ||
                          coalesce(jsonb_path_query_array(b.reasons, '$[3 to last]'), '[]'::jsonb)
                     end,
    'testimonials',  case when p.proof_quote is not null
                     then jsonb_build_array(p.proof_quote) || b.testimonials
                     else b.testimonials end,
    'offer_headline', b.offer_headline,
    'offer_body',     b.offer_body,
    'cta_button_text', b.cta_button_text,
    'cta_url',        b.cta_url,
    'brand',          c.brand,
    'product_type',   c.product_type,
    'contact_phone',  c.contact_phone
  ) end
  from public.campaigns c
  join public.base_pages b on b.campaign_id = c.id
  left join public.personas p
         on p.campaign_id = c.id and p.slug = persona_slug
  where c.slug = campaign_slug
    and (persona_slug is null or p.id is not null);
$$;

-- 0005 made functions in this schema private to anon by default and this is one
-- of the deliberate exceptions. CREATE OR REPLACE keeps existing privileges, so
-- this is a restatement rather than a repair — but without it a fresh database
-- serves "permission denied for function" on every public /p/ page.
grant execute on function public.get_public_page(text, text) to anon, authenticated;

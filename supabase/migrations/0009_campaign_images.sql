-- Pictures.
--
-- The first live campaign shipped twenty pages with zero images on them. Nothing
-- was broken: the copywriter had written an `image_prompt` for all seventy
-- reason slots, the renderer already had an `<img>` waiting, and thirteen real
-- photographs had been read off the customer's own site into the brief. There
-- was simply no stage between "we know what the picture should show" and "the
-- page has a picture".
--
-- This adds the missing layer:
--
--   campaign_images   the library — every photo found on the source page, with a
--                     caption of what it actually shows and whether it is usable
--                     as editorial (a wordmark is not)
--   base_pages.hero_*  the picture under the H1
--   personas.custom_hero_image_url  the same slot, swapped for one buyer
--
-- Reason pictures need no column: `reasons` is jsonb and already carries
-- `image_prompt` per reason, so `image_url` and `image_alt` join it there and
-- flow through the existing 80/20 merge without touching it.

create table if not exists public.campaign_images (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  -- The order they appeared on the source page. This is also the index the
  -- copywriting prompts use to refer to an image, so it must stay stable.
  position    int not null,
  source_url  text not null,
  -- What the photograph shows, written by a model that actually looked at it.
  -- The persona stage cannot see pictures — it is a batched text call — so this
  -- sentence is the only thing it has to choose from.
  caption     text,
  kind        text not null default 'photo'
              check (kind in ('photo', 'graphic', 'logo')),
  -- False for logos, wordmarks, banners, icons and anything whose content is
  -- mostly text. Kept rather than deleted: "we looked at it and rejected it" is
  -- a different state from "we never saw it", and the review screen says so.
  usable      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (campaign_id, source_url)
);
create index if not exists campaign_images_campaign_position
  on public.campaign_images (campaign_id, position);

alter table public.base_pages add column if not exists hero_image_url text;
alter table public.base_pages add column if not exists hero_image_alt text;

-- One buyer's page can carry a different picture at the top. Null inherits the
-- base page's, which is the usual case.
alter table public.personas add column if not exists custom_hero_image_url text;
alter table public.personas add column if not exists custom_hero_image_alt text;

alter table public.campaign_images enable row level security;
drop policy if exists own_campaign_images on public.campaign_images;
create policy own_campaign_images on public.campaign_images
  for all using (public.owns_campaign(campaign_id))
  with check (public.owns_campaign(campaign_id));

-- ─── the merge, with pictures ─────────────────────────────────────────
-- Unchanged except for the two hero fields. Reason images ride inside `reasons`
-- and so were already merged correctly.
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
    'cta_url',        b.cta_url
  ) end
  from public.campaigns c
  join public.base_pages b on b.campaign_id = c.id
  left join public.personas p
         on p.campaign_id = c.id and p.slug = persona_slug
  where c.slug = campaign_slug
    and (persona_slug is null or p.id is not null);
$$;

-- CREATE OR REPLACE keeps the existing privileges, so this is a restatement
-- rather than a repair. Stated anyway: 0005 made functions in this schema
-- private to anon by default, and this is one of the four deliberate
-- exceptions. Without the grant every public /p/ page returns "permission
-- denied for function".
grant execute on function public.get_public_page(text, text) to anon, authenticated;

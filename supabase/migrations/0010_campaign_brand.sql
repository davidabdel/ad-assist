-- The pages wear the seller's brand, not ours.
--
-- The pages read well and then the buyer clicks through to a checkout that
-- looks like a different company. That break is expensive: the page did the
-- persuading and the store undoes it at the moment of payment. Continuity of
-- colour, type and logo across that handover is the whole point of this column.
--
-- One jsonb rather than a dozen columns. It is written once per campaign by the
-- brand stage, read by the renderer, and never queried by field — the classic
-- shape for a document. A brand kit that grows a field is a code change, not a
-- migration.
--
-- Nullable, and null is a working state: a site that gives up nothing readable
-- renders in the neutral editorial theme exactly as it does today. A
-- half-applied brand looks broken; no brand just looks plain.
alter table public.campaigns add column if not exists brand jsonb;

-- ─── the merge, with the brand kit ────────────────────────────────────
-- Unchanged except for the last field. The brand belongs to the campaign, not
-- to a persona: all twenty pages and the base page wear the same clothes, which
-- is the point. A persona swaps words and photographs, never the identity.
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
    'brand',          c.brand
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

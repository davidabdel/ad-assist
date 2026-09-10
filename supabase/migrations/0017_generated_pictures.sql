-- 0017 — a picture for the ads that have none.
--
-- WHY THIS EXISTS. An ad idea is built out of one of the seller's own
-- photographs, and until now an idea that could not be given one was a dead
-- row: the words were written, the card showed "no photograph was chosen", and
-- there was nothing that could ever be made from it. That is not an edge case.
-- A campaign built from a software product's website has NO photographs at all
-- — pointtaken.cc gave the ingest zero readable images, so all twenty-seven of
-- its ideas were unmakeable — and the operator has no library to point them at.
--
-- So when the seller's own photographs cannot supply a picture, one is
-- generated instead. Three columns carry that:
--
--   ad_ideas.generated_image_prompt   the scene to make, written at the same
--                                     time as the words and readable on the
--                                     card before anything is approved. Set on
--                                     every photograph-less idea, so "this is
--                                     null and there is no photograph" is
--                                     exactly the set of rows that still cannot
--                                     be made. On a VIDEO it is the instruction
--                                     that runs, because kie_prompt there is the
--                                     camera move. On a STATIC the scene IS
--                                     kie_prompt — the field a redo rewrites —
--                                     and this holds the picture as first
--                                     described.
--   ad_ideas.source_image_generated   whether the photograph this ad is built
--                                     out of came from the seller or from a
--                                     model. Never inferred from the URL: once
--                                     a generated still is written into
--                                     source_image_url it looks exactly like
--                                     one of theirs, and a picture that was
--                                     invented must never be presented as a
--                                     photograph of their product.
--   generated_assets.role             a video with no photograph needs a still
--                                     to move from, so approving it buys two
--                                     things: the first frame, then the video
--                                     made from it. 'first_frame' marks the
--                                     former so the poller submits the video
--                                     when it lands instead of calling the ad
--                                     finished.

alter table public.ad_ideas
  add column if not exists generated_image_prompt text,
  add column if not exists source_image_generated boolean not null default false;

alter table public.generated_assets
  add column if not exists role text not null default 'ad',
  -- The reservation for the video that this first frame is for, made at the
  -- same moment as the frame's own so that the ceiling sees the whole cost of
  -- the approval up front. A ceiling that only learned about the video after
  -- the frame was already paid for would let a campaign buy a still it can
  -- never use.
  add column if not exists pending_spend_id uuid
    references public.spend_log(id) on delete set null;

alter table public.generated_assets
  drop constraint if exists generated_assets_role_check;
alter table public.generated_assets
  add constraint generated_assets_role_check check (role in ('ad', 'first_frame'));

-- A first frame is a step on the way to the ad, not a result. Everything that
-- reads "what was made for this idea" wants the ad.
create index if not exists generated_assets_idea_role_idx
  on public.generated_assets (ad_idea_id, role);

-- Rejecting a result and having it made again.
--
-- Until now a row that reached `generated` was a dead end. The buttons stopped,
-- the edit route refused it ("a generated ad keeps the words it was made from"),
-- and the only way past a video whose product drifted in the last second was to
-- leave it there. That is the wrong shape for a generation stage: the first
-- roll is a draft, and the operator is the only one who can see whether it is
-- any good.
--
-- Two facts have to survive a redo, and neither had anywhere to live:
--
--   1. WHICH INSTRUCTION MADE WHICH FILE. `kie_prompt` lives on the idea, so
--      revising it for attempt 2 would silently overwrite the sentence that
--      produced attempt 1 — and attempt 1 is still on screen, still paid for,
--      and is the thing being compared against. The prompt therefore moves onto
--      the asset as well: an asset is a file AND the instruction that made it.
--
--   2. WHAT WAS WRONG WITH IT. The note is the whole point of the feature. It
--      is what the revision is written from, and it is the only record of why
--      $1.24 was spent twice on the same idea.
--
-- Nothing is deleted. A rejected attempt keeps its file, its charge and its
-- reason, because the alternative — a table that quietly loses the ad you were
-- looking at a moment ago — reads as a bug, and because two attempts side by
-- side is how you tell whether the note actually worked.

-- ─── the idea ─────────────────────────────────────────────────────────

-- Which attempt the row is CURRENTLY on. 1 for everything that exists today,
-- which is correct: a row that has been generated once has had one attempt.
alter table public.ad_ideas
  add column if not exists attempt int not null default 1;

comment on column public.ad_ideas.attempt is
  'Which generation attempt this row is on. Incremented when a result is '
  'rejected and sent back to be made again. The Approve button says so, '
  'because approving a second attempt spends a second time.';

-- The last thing the operator said was wrong with a result. Kept on the idea
-- rather than only on the asset because it is what the NEXT generation is
-- written from — it has to be readable at the moment of approving, next to the
-- revised instruction it produced.
alter table public.ad_ideas
  add column if not exists redo_note text;

comment on column public.ad_ideas.redo_note is
  'What the operator said was wrong with the last result, in their words. The '
  'revision of kie_prompt is written from this; it is not a status.';

-- ─── the asset ────────────────────────────────────────────────────────

alter table public.generated_assets
  add column if not exists attempt int not null default 1;

-- The sentence this particular file was made from.
--
-- Null on every asset that already exists, and deliberately not backfilled from
-- ad_ideas.kie_prompt: that column may since have been edited by hand, and
-- writing today's prompt against yesterday's file would be a claim about
-- provenance that is not true. Null reads as "not recorded", which it is.
alter table public.generated_assets
  add column if not exists prompt_used text;

comment on column public.generated_assets.prompt_used is
  'The instruction this file was actually generated from, copied at submit. '
  'The idea''s kie_prompt moves on when a result is rejected and revised; this '
  'does not. Null on assets made before this column existed.';

alter table public.generated_assets
  add column if not exists rejected_at timestamptz;

alter table public.generated_assets
  add column if not exists rejected_note text;

comment on column public.generated_assets.rejected_at is
  'Set when the operator looked at the finished file and said no. The file, the '
  'charge and the ledger row all stay — a rejected attempt was still paid for, '
  'and it is the thing the next attempt is being judged against.';

-- Finding an idea's attempts in order, which is how the row renders them.
create index if not exists generated_assets_idea_attempt_idx
  on public.generated_assets (ad_idea_id, attempt);

-- Opening a step, reading what it produced, and sending it back with a note.
--
-- Until now the progress screen was seven ticks and two doors. The main page
-- could be read and rewritten with a note, and a finished ad could be rejected
-- and made again. The other five steps were opaque: if the summary read the
-- price as $40 when it is $40 a month, or the picture stage chose four
-- packaging shots, there was no way in and no way to correct it short of
-- throwing the campaign away and starting again.
--
-- What this adds is one mechanism, not five. Every stage in advance() is
-- already idempotent on the presence of what it produced — no base page means
-- write one, no image library means choose some, a persona with no ideas means
-- write its ideas. So a redo does not need an engine of its own: DELETE THE
-- ARTEFACT AND REWIND THE STATUS and the loop that is already running rebuilds
-- it. This migration adds the two things that mechanism cannot do without: a
-- place to keep the operator's note per step, and a way to take a page or an
-- idea out of the pipeline WITHOUT deleting it.

-- ─── the note, per step ───────────────────────────────────────────────
--
-- One jsonb keyed by the step keys the progress screen already uses (`read`,
-- `brief`, `images`, `pages`, `scan`, `ideas`) rather than six columns: the
-- steps are a list that has grown twice already, and a seventh step should cost
-- a line in a TypeScript array, not a migration.
--
-- `base` is deliberately NOT in here. It has had base_page_guidance since 0006,
-- the approve route clears it, and moving it would be a data migration bought
-- with nothing. The redo route writes whichever of the two a step uses.
alter table public.campaigns
  add column if not exists step_guidance jsonb not null default '{}'::jsonb;

comment on column public.campaigns.step_guidance is
  'What the operator said was wrong with a step, keyed by step key. Folded into '
  'that stage''s prompt on every subsequent run of it, not just the next one — '
  'a note that stopped applying after one redo would be a correction that '
  'silently un-corrects itself.';

-- ─── taking a page out of service without deleting it ─────────────────
--
-- THIS IS THE WHOLE REASON THE REDO IS NOT JUST A DELETE.
--
-- An ad idea carries the URL of its buyer's page, and once that ad has been
-- generated and put in front of Meta, that URL is a real address that real
-- traffic arrives at. Deleting the persona to write a better one would cascade
-- the idea and the finished file away with it, and — worse than any lost row —
-- would turn a live ad's landing page into a 404. The money is recoverable; a
-- campaign that keeps spending into a dead link is not.
--
-- So a redo below a paid artefact SUPERSEDES rather than deletes. The old page
-- stays exactly as it was, still served by get_public_page (which joins on slug
-- and neither knows nor cares about this column), still carrying the words the
-- ad was written against. The new pages are written alongside it. Nothing that
-- was paid for is thrown away, and nothing already running breaks.
alter table public.personas
  add column if not exists superseded_at timestamptz;

comment on column public.personas.superseded_at is
  'Set when a redo replaced this page but could not delete it, because ads have '
  'been generated that point at its URL. The page stays live and unchanged — a '
  'live ad landing on a 404 is worse than an out-of-date page. Excluded from '
  'every count and every list the pipeline works from.';

alter table public.ad_ideas
  add column if not exists superseded_at timestamptz;

comment on column public.ad_ideas.superseded_at is
  'Set when a redo above this row replaced what it was written from. Only ever '
  'set on rows that have been generated — an idea with no file attached is '
  'simply deleted, because there is nothing to preserve and a table full of '
  'dead drafts is harder to read than one that is current.';

create index if not exists personas_live_idx
  on public.personas (campaign_id) where superseded_at is null;

create index if not exists ad_ideas_live_idx
  on public.ad_ideas (campaign_id) where superseded_at is null;

-- ─── the unique keys have to mean "among the live ones" ───────────────
--
-- personas.persona_index is 1..20 and is assigned by counting what exists. With
-- a superseded page still in the table the next run would either restart at 1
-- and collide, or continue at 21 and produce a campaign whose pages are
-- numbered 21-40. Scoping the constraint to live rows is what lets the numbers
-- start again while the old page keeps the number it was published under.
--
-- The SLUG is deliberately left globally unique per campaign. It is the page's
-- address; two rows sharing one would make /p/<campaign>/<slug> ambiguous, and
-- the row that lost the coin toss is the one an ad is pointing at. The persona
-- writer dedupes new slugs against superseded ones for the same reason.
alter table public.personas drop constraint if exists personas_campaign_id_persona_index_key;
create unique index if not exists personas_live_index_key
  on public.personas (campaign_id, persona_index) where superseded_at is null;

-- Same argument one level down: three ideas per buyer, indexed 1-3, and a
-- superseded attempt 1 must not stop the replacement from being called 1.
alter table public.ad_ideas drop constraint if exists ad_ideas_persona_id_idea_index_key;
create unique index if not exists ad_ideas_live_index_key
  on public.ad_ideas (persona_id, idea_index) where superseded_at is null;

-- ONE CALLER HAD TO CHANGE FOR THIS, and it is worth writing down because the
-- failure would have been silent until a redo was tried on real data.
--
-- advance() inserted the ideas with `onConflict: 'persona_id,idea_index'` and
-- `ignoreDuplicates`, which PostgREST sends as ON CONFLICT (persona_id,
-- idea_index) DO NOTHING. Postgres will only accept a named conflict target if
-- it matches a TOTAL unique index; a partial one has to be named with its
-- predicate, which PostgREST cannot express. That statement would have started
-- erroring with "no unique or exclusion constraint matching the ON CONFLICT
-- specification" the moment this migration landed.
--
-- The fix is to drop the target and keep `ignoreDuplicates`, which sends a bare
-- ON CONFLICT DO NOTHING. That is legal against any index, partial included,
-- and it catches a superset of what the named target caught — which is the
-- right direction for a guard whose entire job is to absorb a duplicate from a
-- driver that came back to life after its lock expired.

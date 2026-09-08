-- Which media types the extraction stage has already been through.
--
-- Needed because "no formats" is a legitimate result, not a failure: a media
-- type whose scan came back with six usable ads cannot show a repeating shape,
-- and format_specs is left empty on purpose rather than filled with a pattern
-- invented to populate it (see formats.ts, MIN_ADS).
--
-- Without this column the stage decides what to do next by looking at which
-- media types have rows in format_specs, and a media type that correctly wrote
-- none would be selected again on every call — the campaign would sit in
-- `extracting` re-running the same empty extraction forever. Recording the
-- ATTEMPT rather than inferring it from the OUTPUT is what makes the stage
-- terminate.
alter table public.campaigns
  add column if not exists formats_extracted text[] not null default '{}';

comment on column public.campaigns.formats_extracted is
  'Media types the format extraction has run for, empty results included. '
  'Cleared to re-run extraction after a wider scan.';

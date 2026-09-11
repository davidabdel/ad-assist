-- A picture drawn to be LOOKED AT before it is approved.
--
-- 0017 gave a photograph-less ad its picture, but only on the far side of the
-- approval: the scene was written in prose onto the row, the file came into
-- existence after Approve, and Approve was disabled on exactly those rows
-- because there was no image to send. So sixty ideas sat in front of a person
-- with nothing to look at and no button that worked. The description was never
-- the deliverable.
--
-- 'preview' is the third role a generated file can have, and the only one that
-- is made on purpose before a decision:
--
--   'ad'           the file being bought.
--   'first_frame'  the still a video with no photograph opens on, made as the
--                  first half of an approval already given.
--   'preview'      a picture drawn so the operator can see it. For a static it
--                  becomes the ad on Approve — the same single call, moved in
--                  front of the decision rather than behind it, at the same
--                  four credits. For a video it becomes the frame the shot
--                  opens on, so the $1.24 of camera move is spent by somebody
--                  who has seen the frame.
--
-- IT IS NOT A SECOND CHARGE FOR THE SAME AD. Approving a drawn static costs
-- nothing, because its picture is already paid for; approving a video whose
-- frame was drawn costs the estimate minus the frame. What changed is the
-- ORDER, not the total.

alter table public.generated_assets
  drop constraint if exists generated_assets_role_check;
alter table public.generated_assets
  add constraint generated_assets_role_check
  check (role in ('ad', 'first_frame', 'preview'));

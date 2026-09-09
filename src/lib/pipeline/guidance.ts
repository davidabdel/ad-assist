/**
 * The operator's note, as the model sees it.
 *
 * One renderer for every stage rather than a sentence written at each call
 * site, because the awkward part is not the wording — it is the RANK. A note
 * arrives after somebody has read what the stage produced and said it is wrong,
 * so it has to beat the model's own judgement about what a good answer looks
 * like. It must not beat the rules about what the stage is allowed to claim: a
 * note saying "say it cures eczema" is a note asking for a lie, and a stage
 * that honours it produces an ad that cannot run.
 *
 * So the block below says both, in that order, every time.
 *
 * It is also appended LAST in each prompt. These models weight the end of the
 * instruction heavily, and a correction buried above six paragraphs of general
 * rules gets averaged away — which is exactly the failure that makes an
 * operator press the same button three times and conclude the note does
 * nothing.
 */
export function guidanceBlock(note: string | null | undefined): string {
  const trimmed = (note ?? '').trim();
  if (!trimmed) return '';

  return `

THE OPERATOR HAS SENT THIS STEP BACK. They read what it produced last time and
said this was wrong with it:

---
${trimmed}
---

Treat that as a correction to what you did, not as a new preference to balance
against everything above. It is the reason you are being run again, and if the
next answer does not visibly change in the way it asks for, this run was
pointless.

Two limits on it, and only two. It cannot make you state something the source
material does not support — an invented number, a review nobody wrote, a claim
about what the product does — and it cannot override the rules above about what
this kind of page or ad is allowed to say. If the note asks for one of those,
do the part of it you can honour and leave the rest.`;
}

/**
 * Pull one step's note off the campaign row.
 *
 * Written as a function rather than a property read because `step_guidance` is
 * a jsonb column: it is `{}` on every row that predates the redo feature, and
 * `null` on any row written by a client that did not know about it.
 */
export function noteForStep(
  campaign: { step_guidance?: Record<string, string> | null },
  step: string,
): string | null {
  const value = campaign.step_guidance?.[step];
  return typeof value === 'string' && value.trim() ? value : null;
}

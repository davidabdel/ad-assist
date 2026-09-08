import { z } from 'zod';
import { generate } from '@/lib/llm';

/**
 * Rewriting a generation instruction after the operator has looked at what it
 * made and said no.
 *
 * THIS STAGE COSTS TOKENS AND NOTHING ELSE. It is the whole reason a redo is
 * two clicks rather than one: the revised instruction is put on screen and the
 * money is spent by the same Approve button as always. A "redo" that submitted
 * straight to KIE would be a second button in this app that spends, and it
 * would spend it on a sentence nobody had read.
 *
 * WHAT MAKES THIS DIFFERENT FROM WRITING THE PROMPT IN THE FIRST PLACE. The
 * idea stage works from a format and a brief and has a lot of latitude. This
 * one has almost none: there is an instruction that has already been used, a
 * complaint about the file it produced, and the job is to change the thing
 * complained about and leave everything else alone. A revision that quietly
 * restyles the rest is indistinguishable, from the operator's side, from a
 * random re-roll — and they can already get one of those for free by approving
 * the same prompt again.
 */

const SYSTEM = `You revise the instruction given to an image or video model
after a person has looked at the file it produced and said what is wrong with
it.

You are given the instruction that was used, and the complaint. Change what the
complaint is about. Leave everything else in the instruction WORD FOR WORD
unless it is the cause of the fault.

That constraint is the point of the job. The person can already re-run the same
instruction for another roll; what they are asking for here is a targeted
change. If your revision reads as a fresh instruction rather than an edited one,
you have done the wrong task.

WHAT THESE MODELS ARE
- A static is made by an EDITING model. It is handed one of the seller's own
  photographs and told what to change about it. It is not drawing a product.
- A video is one continuous ten-second shot that begins on that photograph and
  moves. There is no cutting, so never write cuts, shots, or "then".

RULES THAT SURVIVE EVERY REVISION, whatever the complaint says
- THE PRODUCT IS NEVER REDRAWN OR RESTYLED. Not its shape, colour, materials,
  markings, labelling or proportions. It was photographed; it is a real object
  that a real person will be sent in the post. You may change everything around
  it.
- Never ask for text, numbers, prices, badges, logos, stickers or captions to be
  drawn into the picture. These models spell them wrong, and the real headline
  is rendered by Meta around the ad.
- No people who are identifiable as a specific real person, no children in
  close-up, no medical or clinical claims staged as fact.
- If the complaint asks for something these rules forbid — usually "put the
  price on it" or "make the bottle taller" — do NOT do it. Say so plainly in
  what_changed, and revise the parts of the request you can honour.

FAULTS THAT HAVE A KNOWN CAUSE, so name the cause rather than repeating the
complaint back
- "It changed / morphed / turned into something else by the end" on a video is
  drift: ten seconds is long enough for the model to lose the object. The fix is
  to describe the product's fixed features as unchanging THROUGHOUT the shot and
  to ask for a smaller, slower move, not to add the word "consistent".
- "It invented a word / the writing is gibberish" means text was requested,
  directly or by asking for a label, sign or packaging detail. The fix is to
  remove the request, not to spell it out.
- "Wrong setting / doesn't look like my customer" is under-specification. Name
  the room, the surface, the light and the time of day.
- "Too busy / cluttered" is usually a list of props. Cut props rather than
  adding the word "minimal".`;

const RevisionSchema = z.object({
  revised_prompt: z.string().describe(
    'The full instruction to use next time. Complete and usable on its own, not '
    + 'a diff and not a note about what to change.',
  ),
  revised_visual_concept: z.string().describe(
    'One or two sentences describing what the ad will now show, in plain English '
    + 'rather than as an instruction. Same voice as the description it replaces. '
    + 'It must agree with the revised instruction — this is the line the operator '
    + 'reads instead of the prompt, and one that still describes the old version '
    + 'is worse than none.',
  ),
  what_changed: z.string().describe(
    'One or two plain sentences naming what was altered and why, for the person '
    + 'who wrote the complaint. If part of the complaint could not be honoured, '
    + 'say which part and why.',
  ),
});

export type Revision = z.infer<typeof RevisionSchema>;

/**
 * Revise one instruction. Throws on a model failure; the caller decides what
 * that means, because a failed revision must NOT lose the operator's note.
 */
export async function revisePrompt(input: {
  mediaType: 'image' | 'video';
  /** The instruction that produced the file being complained about. */
  currentPrompt: string;
  /** What the operator says is wrong with it, in their words. */
  note: string;
  /** What the ad is meant to show, so a revision cannot wander off the idea. */
  visualConcept: string;
  /** What is in the photograph the model starts from, if it was ever captioned. */
  sourceCaption?: string | null;
  /** Earlier complaints on this same idea, oldest first. */
  previousNotes?: string[];
}): Promise<Revision> {
  const priorFaults = (input.previousNotes ?? []).filter((n) => n.trim());

  const { data } = await generate({
    system: SYSTEM,
    prompt: `THIS IS A ${input.mediaType === 'image' ? 'STATIC IMAGE' : 'TEN-SECOND VIDEO'}.\n\n`
      + `WHAT THE AD IS MEANT TO SHOW\n${input.visualConcept}\n\n`
      + (input.sourceCaption
        ? `THE PHOTOGRAPH IT STARTS FROM\n${input.sourceCaption}\n\n`
        : '')
      + `THE INSTRUCTION THAT WAS USED\n---\n${input.currentPrompt}\n---\n\n`
      + `WHAT IS WRONG WITH THE FILE IT MADE\n---\n${input.note.trim()}\n---\n\n`
      + (priorFaults.length
        // Repeats matter: a fault raised twice was not fixed by the last
        // revision, so the same change written more emphatically is the one
        // thing guaranteed not to work.
        ? `THIS IDEA HAS BEEN SENT BACK BEFORE. Earlier complaints, oldest first:\n`
          + `${priorFaults.map((n) => `- ${n}`).join('\n')}\n`
          + 'If the current complaint repeats an earlier one, the previous revision did '
          + 'not fix it. Change the approach rather than restating the same instruction '
          + 'more firmly.\n\n'
        : '')
      + 'Return the full revised instruction and a short note on what you changed.',
    schema: RevisionSchema,
    maxTokens: 3000,
  });

  const revised = data.revised_prompt.trim();
  if (!revised) {
    throw new Error('The revision came back empty, so the instruction was left as it was.');
  }
  return {
    revised_prompt: revised,
    revised_visual_concept: data.revised_visual_concept.trim(),
    what_changed: data.what_changed.trim(),
  };
}

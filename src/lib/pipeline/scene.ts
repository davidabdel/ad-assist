import { z } from 'zod';
import { generate } from '@/lib/llm';

/**
 * A picture for an ad that has no photograph behind it.
 *
 * WHY THIS IS A SEPARATE STAGE RATHER THAN PART OF WRITING THE IDEAS. It is
 * part of writing the ideas — a photograph-less idea comes out of that call
 * carrying its own scene, free, in the same tokens. This exists for the rows
 * that were written before it did, and for the rare row where the model chose
 * -1 and then forgot to describe anything. Both are the same job: an idea whose
 * words are fine and whose picture does not exist.
 *
 * IT COSTS TOKENS AND NOTHING ELSE. Nothing here submits to KIE. What it
 * produces is a sentence the operator reads on the card, and Approve is still
 * the only button that spends.
 *
 * THE ONE RULE. A generated picture never depicts the product. Nobody
 * photographed it, so every detail described of it is invented, and an invented
 * product inside a real ad is found out at delivery. The picture shows the
 * buyer's situation instead — and for the campaigns that need this most, where
 * the product is software, that was always the honest picture anyway.
 */

const SYSTEM = `You are a photographer being briefed for a Meta ad.

There is no photograph for this ad. The seller either has none you can use or
has none at all — a company that sells software has never photographed a
product. So the picture has to be made, and you write the brief for it.

THE RULE THAT OVERRIDES EVERYTHING: DO NOT PUT THE PRODUCT IN THE FRAME.
Not the object, not its packaging, not its logo, not a screen or phone showing
its interface, not a mock-up of it on a desk. You have never seen it. Anything
you describe of it is invented, and an invented product inside a real ad is a
promise the buyer finds out about when the box arrives.

WHAT YOU PHOTOGRAPH INSTEAD
The buyer's world, at the moment the ad is about. The mess before. The hands.
The desk at eleven at night. The face when it is finally off their plate. The
thing they are trying to get away from, or the life they get back. That is a
true photograph of what the ad is actually selling, and it is the picture that
stops the scroll anyway.

HOW TO WRITE IT
- One paragraph, written as a photograph that exists: subject, setting, light,
  time of day, lens and distance, what the person is doing with their hands and
  where they are looking.
- Real, unstyled, editorial. Somebody's actual kitchen, actual office, actual
  weather. Not a stock-photo handshake and not a lit studio set.
- People are ordinary and unrecognisable as anyone in particular. No celebrity,
  no lookalike, no child in close-up.

NEVER IN THE FRAME
- Any text at all: no words, numbers, prices, signage, labels, packaging copy,
  book titles, screens with writing on them, watermarks. Image models spell them
  wrong, and Meta renders the real headline and price around the ad anyway.
- Logos or brand marks of any kind, including invented ones.
- Anything that stages a medical, financial or outcome claim as fact.`;

const SceneSchema = z.object({
  scene_prompt: z.string().describe(
    'The photograph, as one paragraph, complete and usable on its own. It is '
    + 'handed straight to the image model, so write the picture rather than '
    + 'instructions about the picture.',
  ),
  visual_concept: z.string().describe(
    'One or two plain sentences saying what the ad will show, for the person '
    + 'deciding whether to pay for it. Not the prompt.',
  ),
});

export type Scene = z.infer<typeof SceneSchema>;

/**
 * Write the picture for one photograph-less idea.
 *
 * Throws on a model failure. The caller decides what that means; nothing has
 * been written and nothing has been charged, so trying again is free.
 */
export async function writeScene(input: {
  /**
   * Whether this picture IS the ad, or the frame a ten-second shot opens on.
   * The two want different framing — a first frame has to survive being moved
   * through, so it leaves somewhere for the camera to go.
   */
  role: 'static' | 'first_frame';
  brandName: string;
  productName: string;
  productSummary: string;
  /** Who this ad is for, and what hurts. */
  buyer: string;
  /** What the ad argues, and what it was already meant to show. */
  angle: string;
  headline: string;
  visualConcept: string;
  /**
   * The instruction that was written when this row still expected a photograph.
   * Given as intent only — it is an edit instruction addressed to a retoucher
   * holding a photograph that does not exist, so it is never reused verbatim.
   */
  previousPrompt?: string | null;
}): Promise<Scene> {
  const { data } = await generate({
    system: SYSTEM,
    prompt: `THE PRODUCT\n${input.brandName} — ${input.productName}\n`
      + `${input.productSummary}\n\n`
      + `THE BUYER THIS AD IS FOR\n${input.buyer}\n\n`
      + `WHAT THE AD ARGUES\n${input.angle}\n`
      + `Its headline: ${input.headline}\n`
      + `What it was meant to show: ${input.visualConcept}\n\n`
      + (input.previousPrompt?.trim()
        ? 'AN EARLIER INSTRUCTION EXISTS FOR THIS AD, written when it still expected a '
          + 'photograph to edit. Take the intent from it and nothing else — it describes '
          + 'changes to a photograph that does not exist, and following it would have you '
          + `drawing the product.\n---\n${input.previousPrompt.trim()}\n---\n\n`
        : '')
      + (input.role === 'first_frame'
        ? 'THIS IS THE OPENING FRAME OF A TEN-SECOND SHOT. It will be moved through, so '
          + 'compose it with somewhere for the camera to go — room at the edges, depth, a '
          + 'subject that is doing something rather than posing. Vertical, 9:16.\n\n'
        : 'THIS IS THE AD ITSELF, a single still in a phone feed. Vertical, 4:5. It has to '
          + 'be understood in the half-second before somebody scrolls past.\n\n')
      + 'Write the photograph.',
    schema: SceneSchema,
    maxTokens: 2000,
  });

  const scene = data.scene_prompt.trim();
  if (!scene) throw new Error('The picture came back empty.');
  return { scene_prompt: scene, visual_concept: data.visual_concept.trim() };
}

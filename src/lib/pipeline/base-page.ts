import { generate } from '@/lib/llm';
import { BasePageSchema, type BasePage, type ProductBrief } from './schemas';

/**
 * Stage 2a — the base listicle.
 *
 * Built BEFORE the personas, because a persona's job is to override reasons 1-3
 * of this page. It cannot sensibly override something that does not exist yet,
 * and reasons 4-10 have to hold for all twenty buyers, which is only true if
 * they were written once for the product rather than assembled from whoever
 * happened to be generated first.
 */

const SYSTEM = `You are a direct-response copywriter who writes listicle landing pages
for e-commerce products advertised on Meta.

You are writing the BASE page. Twenty different buyer personas will each get
their own version of it, and each persona replaces only the first three reasons.
So:

- Reasons 1-3 are placeholders that will be swapped out. Write them for the
  broadest, most common buyer.
- Reasons 4-10 are LOCKED. They appear on all twenty pages unchanged, so every
  one of them must be true and compelling regardless of who is reading. A reason
  that only lands for one kind of buyer belongs in a persona, not here.

RULES
- Exactly 10 reasons, numbered 1 to 10, ordered strongest first.
- Every reason must be supported by a real feature in the brief. Do not invent
  capability, certification, guarantees, delivery times or stock claims.
- Do not state a price, a discount or a deadline anywhere except the offer
  fields, and only if the brief gives you one.
- testimonials must be VERBATIM from review_snippets in the brief. If the brief
  has none, return an empty array. Never write a testimonial.
- The hero headline leads with the number of reasons, because that is the promise
  the page keeps.
- Write in plain sentences a busy person reads at a glance. No hype stacking, no
  em-dash-joined clauses running past three lines.
- If the brief's "gaps" list says something is unknown, work around it. Never
  fill a gap with a plausible guess.`;

/**
 * `guidance` is what the operator said was wrong with the previous attempt. It
 * arrives only on a rewrite, and it is appended rather than folded into the
 * system prompt so a rejected page is corrected on the stated point instead of
 * rerolled and hoped over.
 */
export async function buildBasePage(
  brief: ProductBrief,
  guidance?: string | null,
): Promise<{ page: BasePage; usage: { input: number; output: number } }> {
  const note = guidance?.trim();
  const { data, usage } = await generate({
    system: SYSTEM,
    cachedContext: `PRODUCT BRIEF\n---\n${JSON.stringify(brief, null, 2)}\n---`,
    prompt: note
      ? 'Write the base listicle page for this product. A previous attempt was '
        + `rejected. What the operator asked to be different:\n\n${note}\n\n`
        + 'Address that specifically. Every rule above still applies — in particular, '
        + 'do not invent a feature, a testimonial or an offer to satisfy the request. '
        + 'If what was asked for is not supported by the brief, write the closest thing '
        + 'that is true.'
      : 'Write the base listicle page for this product.',
    schema: BasePageSchema,
    maxTokens: 16000,
  });

  if (data.reasons.length !== 10) {
    throw new Error(
      `base page came back with ${data.reasons.length} reasons, not 10 — `
      + 'the persona merge assumes 10 and would leave short pages',
    );
  }
  // Renumber rather than trust: the merge slices reasons 4-10 by position, and a
  // gap or a repeat in the numbering would show up as a mis-numbered live page.
  data.reasons = data.reasons.map((r, i) => ({ ...r, number: i + 1 }));

  return { page: data, usage };
}

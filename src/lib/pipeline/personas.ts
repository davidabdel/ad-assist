import { generate } from '@/lib/llm';
import { normalisePainPoint, uniqueSlug } from '@/lib/slug';
import { PersonaBatchSchema, type BasePage, type PersonaDraft, type ProductBrief } from './schemas';

/**
 * Stage 2b — twenty buyer personas, five at a time.
 *
 * WHY BATCHES. The spec asks for one call producing all twenty. Twenty personas
 * with three reasons each is a very long single generation: it risks the output
 * cap, it takes long enough to bump serverless time limits, and a failure
 * anywhere throws away all twenty. Five at a time is resumable — a failed batch
 * costs one batch — and every batch after the first can see who already exists,
 * which is a better duplicate defence than asking one call to stay varied
 * across twenty items.
 *
 * DIVERSITY IS ENFORCED HERE, NOT HOPED FOR IN THE PROMPT. Personas whose pain
 * point normalises to one already taken are dropped and the shortfall is
 * re-requested.
 */

const SYSTEM = `You are an elite performance marketing director who builds
persona-specific landing pages for e-commerce products advertised on Meta.

Each persona gets its own copy of a listicle page. Only four things change per
persona: the top bar, the H1, the first three reasons, and the proof quote.
Everything else on the page is shared, so your job is to write the part that
makes ONE kind of buyer feel the page was written for them.

RULES
- Personas come from the product, its price point, and the voice in its reviews.
  Nothing else. Do not import personas from the category generally.
- Each persona must differ in WHO THEY ARE and WHAT THEY FEAR. Two personas with
  the same fear worded differently is a failure. If you cannot find a genuinely
  different buyer, return fewer personas rather than a near-duplicate.
- Cover the natural spread across the campaign: first-time buyers, upgraders,
  gift buyers, performance seekers, budget-driven, problem-driven,
  identity-driven, professionals, replacers, and reluctant buyers.
- Every custom_reason must matter to THIS buyer specifically and must be
  supported by a real feature in the brief. Do not invent capability.
- custom_hero_headline keeps the listicle count from the base headline. It
  reframes who the page is for, it does not change what the page contains.
- proof_quote must be VERBATIM from the brief's review_snippets, chosen because
  it fits this buyer. If no real review fits, leave the quote empty. A
  fabricated testimonial is not acceptable under any circumstances.
- custom_topbar_notice may be an empty string, which means "use the campaign's
  own offer bar".
- Exactly 3 custom_reasons per persona, numbered 1, 2 and 3.`;

export type ExistingPersona = { persona_name: string; primary_pain_point: string; slug: string };

function batchPrompt(want: number, existing: ExistingPersona[]): string {
  if (!existing.length) {
    return `Write ${want} distinct buyer personas for this product. `
      + 'These are the first of twenty, so start with the buyers who make up the '
      + 'largest share of demand.';
  }
  const taken = existing
    .map((p, i) => `${i + 1}. ${p.persona_name} — fears: ${p.primary_pain_point}`)
    .join('\n');
  return `These personas already exist for this campaign:\n\n${taken}\n\n`
    + `Write ${want} MORE, each a genuinely different buyer. A new persona must `
    + 'not share a fear with any above, even if worded differently. Reach further '
    + 'into the spread — the buyers not yet covered are the point.';
}

export type PersonaBatchResult = {
  personas: PersonaDraft[];
  rejected: { persona_name: string; reason: string }[];
  usage: { input: number; output: number };
};

/**
 * One batch. Returns only the personas that survived the duplicate check, so a
 * caller can loop until it has twenty rather than assume it got what it asked
 * for.
 */
export async function generatePersonaBatch(
  brief: ProductBrief,
  base: BasePage,
  existing: ExistingPersona[],
  want: number,
): Promise<PersonaBatchResult> {
  const { data, usage } = await generate({
    system: SYSTEM,
    cachedContext:
      `PRODUCT BRIEF\n---\n${JSON.stringify(brief, null, 2)}\n---\n\n`
      + `BASE PAGE (reasons 1-3 are what you are replacing; 4-10 are locked and `
      + `will appear below yours)\n---\n${JSON.stringify(base, null, 2)}\n---`,
    prompt: batchPrompt(want, existing),
    schema: PersonaBatchSchema,
    maxTokens: 16000,
  });

  const takenPains = new Set(existing.map((p) => normalisePainPoint(p.primary_pain_point)));
  const takenSlugs = new Set(existing.map((p) => p.slug));
  const kept: PersonaDraft[] = [];
  const rejected: { persona_name: string; reason: string }[] = [];

  for (const p of data.personas) {
    if (p.custom_reasons.length !== 3) {
      rejected.push({
        persona_name: p.persona_name,
        reason: `${p.custom_reasons.length} custom reasons, needs exactly 3`,
      });
      continue;
    }
    const key = normalisePainPoint(p.primary_pain_point);
    if (!key) {
      rejected.push({ persona_name: p.persona_name, reason: 'empty pain point' });
      continue;
    }
    if (takenPains.has(key)) {
      rejected.push({
        persona_name: p.persona_name,
        reason: `pain point duplicates one already in the campaign: "${p.primary_pain_point}"`,
      });
      continue;
    }
    takenPains.add(key);

    const slug = uniqueSlug(p.slug || p.persona_name, takenSlugs);
    takenSlugs.add(slug);
    kept.push({
      ...p,
      slug,
      custom_reasons: p.custom_reasons.map((r, i) => ({ ...r, number: i + 1 })),
    });
  }

  return { personas: kept, rejected, usage };
}

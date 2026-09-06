import { generate } from '@/lib/anthropic';
import { ProductBriefSchema, type ProductBrief } from './schemas';

/**
 * Stage 1b — raw scrape into a fixed product brief.
 *
 * Kept separate from the scrape itself so a prompt change costs nothing: the
 * payload is already on the campaign row, so re-briefing never means opening
 * Chrome again.
 */

const SYSTEM = `You convert a raw web scrape of a single product into a structured brief.

You are an extractor, not a copywriter. Every field must be traceable to the
source below. This brief is the ONLY thing the rest of the pipeline sees, so
anything you invent here is repeated across twenty landing pages and sixty ads.

RULES
- Never invent a feature, a price, a rating or a review. If the source does not
  say it, leave the field empty and add a line to "gaps" saying what is missing.
- review_snippets must be VERBATIM. Copy the reviewer's words exactly, typos and
  all. Do not tidy, translate, shorten or merge two reviews.
- top_objections and top_desires come from what buyers actually say in the
  reviews, plus what the product page itself pre-empts. They are not your guesses
  about the category.
- practical_benefit says what the owner can now DO. "Merino wool" is a feature;
  "wear them a second day without them smelling" is the benefit.
- Prefer the structured data over the page text where they disagree — it came
  from the store's own product record.
- If a warning says the page redirected to a homepage or has no structured data,
  say so plainly in "gaps". Do not paper over a bad scrape.`;

/** Trimmed so a 200 KB markdown dump does not push the real signal out of view. */
function payloadForPrompt(raw: Record<string, unknown>): string {
  const clone: Record<string, unknown> = { ...raw };
  if (typeof clone.markdown === 'string' && clone.markdown.length > 24_000) {
    clone.markdown = `${clone.markdown.slice(0, 24_000)}\n\n[...truncated for length]`;
  }
  if (Array.isArray(clone.reviews)) clone.reviews = clone.reviews.slice(0, 40);
  return JSON.stringify(clone, null, 2);
}

export async function buildProductBrief(
  scraped: Record<string, unknown>,
  extra: { checkoutUrl?: string | null; currentOffer?: string | null } = {},
): Promise<{ brief: ProductBrief; usage: { input: number; output: number } }> {
  const context = [
    payloadForPrompt(scraped),
    extra.currentOffer ? `\nCurrent offer the operator is running: ${extra.currentOffer}` : '',
    extra.checkoutUrl ? `\nCheckout URL: ${extra.checkoutUrl}` : '',
  ].join('\n');

  const { data, usage } = await generate({
    system: SYSTEM,
    cachedContext: `SOURCE SCRAPE\n---\n${context}\n---`,
    prompt: 'Produce the product brief from the source above.',
    schema: ProductBriefSchema,
    // Extraction, not invention — the reasoning here is shallow by design.
    effort: 'medium',
    maxTokens: 12000,
  });

  return { brief: data, usage };
}

/** Same shape, built by hand when the operator pasted text instead of a URL. */
export async function buildProductBriefFromText(
  text: string,
  extra: { checkoutUrl?: string | null; currentOffer?: string | null } = {},
): Promise<{ brief: ProductBrief; usage: { input: number; output: number } }> {
  return buildProductBrief(
    {
      source: 'pasted_text',
      markdown: text,
      reviews: [],
      warnings: ['operator pasted this text; nothing was scraped, so treat every '
        + 'claim as coming from the operator rather than from a live product page'],
    },
    extra,
  );
}

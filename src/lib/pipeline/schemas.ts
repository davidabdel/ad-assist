import { z } from 'zod';

/**
 * Structured-output schemas. Deliberately free of length constraints
 * (`.min()`, `.max()`) — the API's JSON Schema subset drops them, so enforcing
 * "exactly 10 reasons" here would validate client-side and throw AFTER we have
 * paid for the generation. Counts are checked in the stage code, where a
 * shortfall can be handled rather than crashed on.
 */

export const ProductBriefSchema = z.object({
  brand_name: z.string().describe('The brand that sells it. Empty string if the page never says.'),
  product_name: z.string(),
  category: z.string().describe('What kind of thing it is, in the words a buyer would use.'),
  one_line_summary: z.string().describe('One sentence a stranger would understand.'),
  features: z.array(z.object({
    feature: z.string().describe('The capability, as stated by the source.'),
    practical_benefit: z.string().describe('What it lets the owner actually do.'),
  })),
  price: z.object({
    amount: z.number().describe('0 when the source gives no price.'),
    currency: z.string().describe('ISO code, or empty string when unknown.'),
    offer_structure: z.string().describe('Sale, bundle, subscription, free shipping. Empty if none.'),
  }),
  top_objections: z.array(z.string()).describe('Reasons a real buyer would hesitate, from the source only.'),
  top_desires: z.array(z.string()).describe('What buyers say they wanted, in their own framing.'),
  review_snippets: z.array(z.object({
    quote: z.string().describe('VERBATIM from a real review. Never write one.'),
    reviewer: z.string().describe('Empty string when the source does not name them.'),
    rating: z.number().describe('0 when no rating was captured.'),
  })),
  image_urls: z.array(z.string()),
  gaps: z.array(z.string()).describe(
    'What the source did not tell you and you refused to guess. This is a feature: '
    + 'an empty price or no reviews must be reported, never filled in.',
  ),
});
export type ProductBrief = z.infer<typeof ProductBriefSchema>;

const ReasonSchema = z.object({
  number: z.number(),
  title: z.string().describe('The reason as a headline. Specific, not a category.'),
  body: z.string().describe('2-4 sentences. Grounded in a real feature from the brief.'),
  image_prompt: z.string().describe('What a supporting image would show. Empty string if none fits.'),
});

export const BasePageSchema = z.object({
  page_title: z.string(),
  meta_description: z.string(),
  hero_headline: z.string().describe('The listicle promise. Leads with the count.'),
  hero_subheadline: z.string(),
  reasons: z.array(ReasonSchema).describe('Exactly 10, numbered 1-10, ordered strongest first.'),
  testimonials: z.array(z.object({
    quote: z.string().describe('VERBATIM from the brief review_snippets. Never invented.'),
    reviewer: z.string(),
    rating: z.number(),
  })),
  offer_headline: z.string(),
  offer_body: z.string(),
  cta_button_text: z.string(),
});
export type BasePage = z.infer<typeof BasePageSchema>;

export const PersonaSchema = z.object({
  persona_name: z.string().describe('Who they are, 2-4 words. "Shift-Working Nurse", not "Persona 3".'),
  slug: z.string().describe('lowercase-hyphenated, derived from the name.'),
  primary_pain_point: z.string().describe('The specific thing that hurts. Must differ in KIND from every persona already listed.'),
  core_desire: z.string(),
  angle_hook: z.string().describe('The one-line angle an ad would lead with for this buyer.'),
  custom_topbar_notice: z.string().describe('Short offer bar copy for this buyer. Empty string to inherit the campaign default.'),
  custom_hero_headline: z.string().describe('Replaces the base H1 for this buyer. Keeps the listicle count.'),
  custom_reasons: z.array(ReasonSchema).describe('Exactly 3, numbered 1-3. These replace the base page reasons 1-3.'),
  proof_quote: z.object({
    quote: z.string().describe('VERBATIM from the brief. Empty string when no real review fits this buyer.'),
    reviewer: z.string(),
    rating: z.number(),
  }).describe('Leave quote empty rather than writing one. A fabricated testimonial is not acceptable.'),
});
export type PersonaDraft = z.infer<typeof PersonaSchema>;

export const PersonaBatchSchema = z.object({
  personas: z.array(PersonaSchema),
});

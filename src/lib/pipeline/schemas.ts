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

/**
 * The same reason, written by the persona stage, which DOES get to choose its
 * own picture.
 *
 * The base page cannot: it is written before anything has looked at the photos,
 * so its slots stay empty and the operator approves the words against a
 * placeholder that names what should fill it. The picture arrives afterwards,
 * from `images.ts`.
 *
 * A persona is written after that pass, so the library and its captions already
 * exist and the buyer's own three reasons can each take a different photograph.
 * An index, never a URL: a model asked for a URL invents one that resolves.
 */
const PersonaReasonSchema = ReasonSchema.extend({
  image_index: z.number().describe(
    'Index of the photo from the IMAGE LIBRARY that genuinely illustrates this '
    + 'reason. Use -1 when no photo in the library shows what this reason claims. '
    + '-1 is a correct answer and is expected often.',
  ),
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

/**
 * The brand pass. One call, one look at the seller's own logo, and a decision
 * about which of the colours and typefaces on their site are the brand.
 *
 * A MODEL RATHER THAN ARITHMETIC, FOR ONE SPECIFIC REASON. The candidate list
 * this call receives is noisy in a way no counting rule survives: page builders
 * ship their own defaults in the customer's stylesheet, under exactly the names
 * a counting rule would trust. GoHighLevel declares `--primary` as a green that
 * appears nowhere on the rendered page, while the real brand — two teals — sits
 * under machine-generated names. The tie-break that works is looking at the
 * logo, so the thing that decides has to be able to see it.
 *
 * Contrast is NOT asked for here. "What colour text goes on this button" is
 * arithmetic and is computed in `lib/brand.ts`, because a model answers white
 * nine times in ten and the tenth is unreadable.
 */
export const BrandChoiceSchema = z.object({
  primary_color: z.string().describe(
    'The colour this brand leads with, as #rrggbb. Must be one of the candidate '
    + 'colours listed, copied exactly.',
  ),
  accent_color: z.string().describe(
    'The colour their own buy buttons are, as #rrggbb, from the candidates. '
    + 'Often the same as primary — repeat it rather than inventing a second one.',
  ),
  ink_color: z.string().describe(
    'Body text colour, as #rrggbb. Almost always a near-black from the neutrals.',
  ),
  surface_color: z.string().describe(
    'Page background, as #rrggbb. Almost always white or a near-white from the neutrals.',
  ),
  heading_font_family: z.string().describe(
    'The ONE family name their headings use — "Urbanist", not the whole stack, '
    + 'and no quotes. Empty string when the evidence does not say.',
  ),
  heading_font_generic: z.enum(['serif', 'sans-serif']).describe(
    'Which generic the heading family belongs to, so the fallback matches.',
  ),
  body_font_family: z.string().describe('Same, for body text. Empty string when unknown.'),
  body_font_generic: z.enum(['serif', 'sans-serif']),
  logo_index: z.number().describe(
    'Index of the image that is the brand\'s logo — the one to put at the top of '
    + 'a page. -1 when none of them is a logo. A photograph is not a logo.',
  ),
  icon_index: z.number().describe(
    'Index of the square icon for the browser tab. -1 when there is none. May be '
    + 'the same image as the logo.',
  ),
  site_name: z.string().describe('The brand name as it appears on their site. Empty if unclear.'),
  confidence: z.enum(['high', 'low']).describe(
    "'low' when the evidence is thin or contradictory and the operator should "
    + 'check the colours against their site before running ads.',
  ),
  reasoning: z.string().describe(
    'One or two plain sentences saying what told you. Shown to the operator, so '
    + 'write it for them: "the logo is teal and that teal is on the buy button".',
  ),
});
export type BrandChoice = z.infer<typeof BrandChoiceSchema>;

export const PersonaSchema = z.object({
  persona_name: z.string().describe('Who they are, 2-4 words. "Shift-Working Nurse", not "Persona 3".'),
  slug: z.string().describe('lowercase-hyphenated, derived from the name.'),
  primary_pain_point: z.string().describe('The specific thing that hurts. Must differ in KIND from every persona already listed.'),
  core_desire: z.string(),
  angle_hook: z.string().describe('The one-line angle an ad would lead with for this buyer.'),
  custom_topbar_notice: z.string().describe('Short offer bar copy for this buyer. Empty string to inherit the campaign default.'),
  custom_hero_headline: z.string().describe('Replaces the base H1 for this buyer. Keeps the listicle count.'),
  hero_image_index: z.number().describe(
    'Index of the photo from the IMAGE LIBRARY to put under this buyer\'s headline. '
    + '-1 to inherit the main page\'s hero photo, which is the right answer unless a '
    + 'different photo speaks to THIS buyer specifically.',
  ),
  custom_reasons: z.array(PersonaReasonSchema).describe('Exactly 3, numbered 1-3. These replace the base page reasons 1-3.'),
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

/**
 * The image pass. One call, one look at every photograph, two jobs:
 *
 *   1. caption the library, because the persona stage is a batched text call and
 *      can never see a picture — a sentence per photo is all it will ever have;
 *   2. fill the main page's slots, which were left deliberately empty so the
 *      words could be approved before anything was illustrated.
 *
 * Doing both in one call is not a shortcut. Choosing which photo illustrates
 * reason 6 requires having looked at all thirteen, which is the same work as
 * captioning them, so splitting it would mean paying to look twice.
 */
export const ImagePlanSchema = z.object({
  images: z.array(z.object({
    index: z.number().describe('The 0-based label of the image, exactly as given in the prompt.'),
    caption: z.string().describe(
      'What this photograph actually shows, in one plain sentence. Written for '
      + 'somebody choosing it later without being able to see it.',
    ),
    kind: z.enum(['photo', 'graphic', 'logo']).describe(
      "'photo' = a real photograph. 'graphic' = a diagram, chart or illustration. "
      + "'logo' = a wordmark, badge, banner or icon.",
    ),
    usable: z.boolean().describe(
      'False for logos, wordmarks, banners, icons, and anything that is mostly '
      + 'text. These render badly at editorial width and are never the answer to '
      + '"what does this reason look like".',
    ),
  })),
  hero_image_index: z.number().describe(
    'The photo to put under the headline: the widest, most human, most '
    + 'immediately understandable one. -1 if none of them work.',
  ),
  slots: z.array(z.object({
    reason_number: z.number().describe('Which reason this is for, 1-10.'),
    image_index: z.number().describe(
      '-1 when no photo in the library genuinely shows what this reason claims.',
    ),
    alt: z.string().describe(
      'Alt text describing the chosen photo in the context of this reason. Empty string when the index is -1.',
    ),
  })).describe('One entry per reason, in order. Every reason gets an entry, including the -1s.'),
});
export type ImagePlan = z.infer<typeof ImagePlanSchema>;

import { z } from 'zod';
import { CTA_LABELS } from '@/lib/ad-fields';

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

/**
 * The firewall, as a schema.
 *
 * This is the ONLY thing that leaves the scanned ads and travels forward into
 * the stage that writes David's copy. Every field is a description of SHAPE —
 * what the ad does and in what order — and none of them is allowed to be the
 * ad's own words. That distinction is enforced in the field descriptions
 * because it cannot be enforced by a type: `hook_pattern` is a string either
 * way, and the difference between "opens by naming a cost the viewer is already
 * paying" and "Stop wasting $400 a year on razors" is the whole point of the
 * table.
 *
 * `ad_indexes` rather than ids: a model asked for a uuid invents one that
 * parses. It gets a numbered list and hands back numbers, and the mapping to
 * real rows happens in `formats.ts` where a bad index can be dropped.
 */
export const FormatSpecBatchSchema = z.object({
  formats: z.array(z.object({
    format_name: z.string().describe(
      'A short name for the shape, the way an editor would refer to it: '
      + '"problem-first testimonial", "side-by-side comparison", "unboxing to '
      + 'offer". Never the name of a brand in the sample.',
    ),
    description: z.string().describe(
      'Two or three sentences on what this format does and why it holds '
      + 'attention. Written so somebody could build one without seeing the '
      + 'examples.',
    ),
    hook_pattern: z.string().describe(
      'What the opening DOES, described as a move rather than quoted. '
      + '"Names a specific everyday cost, then pauses" — not the sentence '
      + 'itself. Copying an advertiser\'s words into this field defeats the '
      + 'purpose of the field.',
    ),
    visual_recipe: z.string().describe(
      'What is on screen, in order, and how it is shot: framing, who is in it, '
      + 'what changes between the start and the end. Generic to the format, not '
      + 'a description of one particular ad.',
    ),
    offer_placement: z.string().describe(
      'Where the price, discount or guarantee appears relative to everything '
      + 'else — "withheld until the last third", "stated in the first line", '
      + '"never stated, deferred to the landing page". Empty string when the '
      + 'ads in this format carry no offer at all.',
    ),
    ad_indexes: z.array(z.number()).describe(
      'EVERY ad in the numbered list that follows this format, not just a few '
      + 'illustrative ones. These numbers decide the format\'s observed count '
      + 'and its median run time, so a short list understates a real pattern. '
      + 'An ad belongs to exactly one format: put it under the shape it fits '
      + 'best rather than listing it twice.',
    ),
  })).describe(
    'One entry per shape you can actually see repeating. Report the patterns '
    + 'that are there — a format observed once is noise, and inventing a fifth '
    + 'to round the list out is worse than returning four.',
  ),
  unclassified_indexes: z.array(z.number()).describe(
    'Ads that follow no shape shared with any other ad in the list. Reporting '
    + 'them is expected and useful; forcing them into a format is not.',
  ),
});
export type FormatSpecBatch = z.infer<typeof FormatSpecBatchSchema>;

/**
 * The ad ideas for one buyer.
 *
 * WHAT THIS PROMPT IS AND IS NOT ALLOWED TO SEE. It sees the product brief, one
 * persona, and the FORMAT SPECS — descriptions of what winning ads DO. It never
 * sees a scanned ad. That separation is the whole architecture of the scan
 * stage (see formats.ts) and it is the reason none of David's ads can come out
 * wearing somebody else's sentences.
 *
 * `image_prompt` is the field that does the most work and the one most easily
 * got wrong. The image model is an EDITOR: it is handed one of the seller's own
 * photographs and told what to change. So the prompt is an instruction to a
 * retoucher, not a description to a painter — "keep the product exactly as
 * photographed, place it on …" — and anything that would repaint the product
 * itself is a picture of a thing that does not exist.
 */
const AdIdeaSchema = z.object({
  format_index: z.number().describe(
    'Index of the format from the FORMATS list this idea is built on. -1 only '
    + 'when the list is empty.',
  ),
  angle: z.string().describe(
    'The argument this ad makes to THIS buyer, in one line. Not the format name '
    + '— what is being claimed and why they would care.',
  ),
  hook: z.string().describe(
    'The first thing the viewer reads or sees, written out. This is real copy, '
    + 'in the product\'s own voice, following the format\'s hook PATTERN — not a '
    + 'restatement of the pattern.',
  ),
  headline: z.string().describe(
    'Meta\'s headline field. Short — it truncates around 40 characters on a '
    + 'phone, so the point has to be inside that.',
  ),
  primary_text: z.string().describe(
    'Meta\'s primary text: the body above the image. Roughly 50-150 words. '
    + 'Everything before the first line break has to work alone, because that is '
    + 'all that shows before "See more".',
  ),
  cta_label: z.enum(CTA_LABELS).describe(
    'The Ads Manager button. Must be one a buyer of THIS thing would press.',
  ),
  visual_concept: z.string().describe(
    'What is on screen, in plain English, for somebody deciding whether this ad '
    + 'is worth making. One or two sentences. Not the prompt.',
  ),
  source_image_index: z.number().describe(
    'Index of the photograph from the IMAGE LIBRARY this ad is built out of — '
    + 'the picture the editor starts from, or the first frame of the video. '
    + 'Choose the one that already shows what the ad is about. -1 only when the '
    + 'library genuinely contains nothing usable, and an idea with -1 cannot be '
    + 'generated, so use it as a last resort rather than a default.',
  ),
  image_prompt: z.string().describe(
    'THE EDIT INSTRUCTION, written to a retoucher who is holding the chosen '
    + 'photograph. Say what to keep and what to change. The product itself is '
    + 'always kept — its shape, colour, materials, labelling and proportions are '
    + 'photographic fact and must never be restyled, recoloured or redrawn. '
    + 'Change the setting, the light, the framing, the props, the people. Do not '
    + 'ask for words, logos, prices or badges to be rendered into the picture: '
    + 'image models spell them wrong, and Meta puts the real copy around the ad '
    + 'anyway. Empty string ONLY for a video idea.',
  ),
  video_prompt: z.string().describe(
    'For a video idea: one continuous ten-second shot that STARTS from the '
    + 'chosen photograph and moves. Describe the camera move, what enters or '
    + 'changes, and the ending frame. The product stays exactly as photographed '
    + 'throughout. No dialogue, no on-screen text, no music cues — the ad plays '
    + 'muted in the feed. Empty string for a static idea.',
  ),
  storyboard_beats: z.array(z.object({
    at_second: z.number().describe('When this beat starts, in seconds from 0.'),
    on_screen: z.string().describe('What the viewer sees at that moment.'),
  })).describe(
    'For a video idea, the shot broken into 3-4 beats — shown to the operator so '
    + 'they can judge the ad before paying for it. Empty array for a static.',
  ),
  why_this_works: z.string().describe(
    'One sentence: what this borrows from the format, and what makes it this '
    + 'buyer\'s ad rather than a generic one. Written for the operator.',
  ),
});

export const AdIdeaBatchSchema = z.object({
  ideas: z.array(AdIdeaSchema).describe(
    'One entry per idea requested, in the order the prompt asks for them.',
  ),
});
export type AdIdeaDraft = z.infer<typeof AdIdeaSchema>;

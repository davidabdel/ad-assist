import { generate } from '@/lib/llm';
import { COPY_RULES, type ProductType } from '@/lib/product-type';
import { imageCost, VIDEO_SECONDS, videoCost } from '@/lib/kie';
import { AdIdeaBatchSchema, type AdIdeaDraft, type ProductBrief } from './schemas';

/**
 * Stage 4 — three ad ideas per buyer.
 *
 * ONE PERSONA PER CALL. Same reasoning as the persona batches: a call that
 * covers one buyer finishes in well under a serverless function's life, a
 * failure costs one buyer rather than twenty, and the unit is naturally
 * idempotent because a persona either has its ideas or it does not.
 *
 * THE FIREWALL, RESTATED. This prompt is given format specs — descriptions of
 * what long-running ads DO — and never a scanned ad. Nothing an advertiser
 * wrote reaches this call. That is the entire reason the extraction stage
 * exists, and it is enforced here by what gets passed in, not by an instruction.
 */

const SYSTEM = `You write Meta ads.

You are given ONE buyer, the product they would buy, and a set of FORMATS —
descriptions of how ads that have been running profitably for months are BUILT.
Not their words. Their shape: how they open, what is on screen, where the offer
sits. Your job is to build that shape around this product and this buyer.

WHAT MAKES THESE ADS RATHER THAN COPY
- Every claim must be supported by the brief. If the brief does not say it, it
  does not go in the ad. An invented feature is found out at delivery.
- Write to the ONE buyer described, not to everybody. The reason this buyer's
  page exists is that they are not the same as the others.
- The three ideas must be three different ARGUMENTS, not three phrasings of one.
  If two of them could swap headlines and still make sense, one of them is not
  an idea.
- No superlatives you cannot substantiate, no fake urgency, no invented
  discount, no invented review, no health, income or outcome guarantee.

THE PICTURE
The image is made by an EDITING model. It is handed one of the seller's own
photographs and told what to change. So:
- Choose the photograph the ad is genuinely about. It is listed with a
  description of what is in it; you cannot see it, so the description is all you
  have.
- THE PRODUCT ITSELF IS NEVER CHANGED. Not its shape, colour, materials,
  markings, labelling or proportions. It was photographed; it is a fact. You may
  change everything around it — the setting, the light, the surface it sits on,
  the framing, who is holding it.
- Never ask for text, numbers, prices, badges, logos or stickers to be drawn
  into the picture. Editing models spell them wrong, and Meta renders the real
  headline and price around the ad anyway.

THE VIDEO
One continuous ten-second shot that begins on the chosen photograph and moves.
There is no cutting available, so do not write cuts — write a single move.
It plays MUTED in the feed, so there is no dialogue, no voiceover and no music.
Everything that has to be understood must be understood by looking.`;

export type FormatForPrompt = {
  id: string;
  media_type: string;
  format_name: string;
  description: string;
  hook_pattern: string;
  visual_recipe: string;
  offer_placement: string | null;
  observed_count: number;
  median_days_running: number | null;
};

export type PersonaForPrompt = {
  id: string;
  persona_name: string;
  primary_pain_point: string;
  core_desire: string;
  angle_hook: string;
  custom_hero_headline: string;
  custom_reasons: unknown;
};

export type ImageForPrompt = { position: number; source_url: string; caption: string | null };

export type PlannedIdea = { index: number; mediaType: 'image' | 'video' };

/**
 * Which of the three ideas are statics and which is the video.
 *
 * The split is the campaign's (`media_split`, 2 static + 1 video by default),
 * but a media type with NO observed formats cannot be built on — the whole
 * premise of this stage is that an idea inherits a shape that has been proven
 * to keep running. So a type with no formats gives its slots to the other one,
 * and the caller says so on screen rather than silently shipping three statics
 * when the operator was expecting a video.
 */
export function planIdeas(input: {
  split: { static?: number; video?: number } | null;
  hasImageFormats: boolean;
  hasVideoFormats: boolean;
}): { plan: PlannedIdea[]; note: string | null } {
  const wantStatic = Math.max(0, Math.round(input.split?.static ?? 2));
  const wantVideo = Math.max(0, Math.round(input.split?.video ?? 1));
  const total = Math.min(3, Math.max(1, wantStatic + wantVideo));

  if (!input.hasImageFormats && !input.hasVideoFormats) {
    return { plan: [], note: 'No formats were extracted, so there is no observed shape to build on.' };
  }

  let statics = input.hasImageFormats ? wantStatic : 0;
  let videos = input.hasVideoFormats ? wantVideo : 0;
  let note: string | null = null;

  if (!input.hasVideoFormats && wantVideo > 0) {
    statics = total;
    note = `No video formats came out of the scan, so all ${total} ideas for each buyer are `
      + 'statics. A video idea with no observed format behind it would be a guess wearing '
      + 'the same table row as the rest.';
  } else if (!input.hasImageFormats && wantStatic > 0) {
    videos = total;
    note = `No static formats came out of the scan, so all ${total} ideas for each buyer are `
      + 'videos.';
  }

  const plan: PlannedIdea[] = [];
  for (let i = 0; i < statics && plan.length < total; i++) {
    plan.push({ index: plan.length + 1, mediaType: 'image' });
  }
  for (let i = 0; i < videos && plan.length < total; i++) {
    plan.push({ index: plan.length + 1, mediaType: 'video' });
  }
  return { plan, note };
}

function renderFormats(formats: FormatForPrompt[]): string {
  return formats.map((f, i) => [
    `[${i}] ${f.format_name} (${f.media_type === 'image' ? 'static' : 'video'})`,
    `  what it does: ${f.description}`,
    `  how it opens: ${f.hook_pattern}`,
    `  what is on screen: ${f.visual_recipe}`,
    f.offer_placement ? `  where the offer sits: ${f.offer_placement}` : null,
    `  seen in ${f.observed_count} ads`
    + (f.median_days_running != null ? `, running ${f.median_days_running} days on average` : ''),
  ].filter(Boolean).join('\n')).join('\n\n');
}

function renderImages(images: ImageForPrompt[]): string {
  if (!images.length) return '(empty — there are no usable photographs, so use -1)';
  return images.map((i) => `${i.position}: ${i.caption ?? 'no description'}`).join('\n');
}

export type IdeaRow = {
  campaign_id: string;
  persona_id: string;
  idea_index: number;
  media_type: 'image' | 'video';
  format_spec_id: string | null;
  angle: string;
  hook: string;
  headline: string;
  primary_text: string;
  cta_label: string;
  visual_concept: string;
  them_vs_us: { why_this_works: string } | null;
  kie_model: string;
  kie_prompt: string | null;
  video_storyboard: { beats: { at_second: number; on_screen: string }[]; seconds: number } | null;
  est_credits: number;
  est_usd: number;
  destination_url: string;
  source_image_url: string | null;
};

export type IdeaBatchResult = {
  rows: IdeaRow[];
  /** Ideas the model returned that could not be used, and why. Never silent. */
  rejected: { idea_index: number; reason: string }[];
};

/**
 * Write one buyer's ideas. Returns rows ready to insert; writing them is the
 * caller's job, so a failure here costs a model call and nothing else.
 */
export async function generateIdeasForPersona(input: {
  campaignId: string;
  productType: ProductType;
  brief: ProductBrief;
  persona: PersonaForPrompt;
  formats: FormatForPrompt[];
  images: ImageForPrompt[];
  plan: PlannedIdea[];
  destinationUrl: string;
  /** What the offer bar says, if anything. Real offers only — never invented. */
  currentOffer: string | null;
}): Promise<IdeaBatchResult> {
  const { plan } = input;
  if (!plan.length) return { rows: [], rejected: [] };

  const usableFormats = input.formats.filter(
    (f) => plan.some((p) => p.mediaType === f.media_type),
  );
  const rules = COPY_RULES[input.productType];

  const order = plan
    .map((p) => `Idea ${p.index}: a ${p.mediaType === 'image' ? 'STATIC image' : 'VIDEO'} ad.`)
    .join('\n');

  const { data } = await generate({
    system: rules ? `${SYSTEM}\n\n${rules}` : SYSTEM,
    // Everything identical across all twenty personas of this campaign sits in
    // the cached prefix: the brief, the formats and the photo library do not
    // change between buyers, and they are the bulk of the tokens.
    cachedContext:
      `PRODUCT BRIEF\n---\n${JSON.stringify(input.brief, null, 2)}\n---\n\n`
      + `FORMATS — shapes taken from ads that keep running. Build on these; they are `
      + `descriptions of structure, and no advertiser's words appear in them.\n---\n`
      + `${renderFormats(usableFormats)}\n---\n\n`
      + `IMAGE LIBRARY — the seller's own photographs. Choose by index.\n---\n`
      + `${renderImages(input.images)}\n---`,
    prompt: `THE BUYER\n`
      + `Name: ${input.persona.persona_name}\n`
      + `What hurts: ${input.persona.primary_pain_point}\n`
      + `What they want: ${input.persona.core_desire}\n`
      + `The angle their landing page leads with: ${input.persona.angle_hook}\n`
      + `Their page headline: ${input.persona.custom_hero_headline}\n`
      + `The three reasons written for them: `
      + `${JSON.stringify(input.persona.custom_reasons)}\n\n`
      + (input.currentOffer
        ? `THE OFFER CURRENTLY RUNNING: ${input.currentOffer}\n`
          + 'This is real and may be used. Do not invent any other discount.\n\n'
        : 'THERE IS NO OFFER RUNNING. Do not invent a discount, a deadline or a bonus.\n\n')
      + `WRITE ${plan.length} IDEAS, in this exact order:\n${order}\n\n`
      + 'Each one builds on a different format where the list allows it. Fill '
      + 'image_prompt for a static and leave video_prompt and storyboard_beats empty; '
      + 'fill video_prompt and storyboard_beats for a video and leave image_prompt empty.',
    schema: AdIdeaBatchSchema,
    maxTokens: 12000,
  });

  const byIndex = new Map(input.images.map((i) => [i.position, i.source_url]));
  const rows: IdeaRow[] = [];
  const rejected: { idea_index: number; reason: string }[] = [];

  plan.forEach((planned, i) => {
    const draft: AdIdeaDraft | undefined = data.ideas[i];
    if (!draft) {
      rejected.push({ idea_index: planned.index, reason: 'the model returned fewer ideas than asked for' });
      return;
    }

    // The plan decides the media type, never the model. It is arithmetic over
    // `media_split` and what the scan actually found, and letting a generation
    // override it would mean the cost shown on screen was for a different ad
    // from the one that gets made.
    const mediaType = planned.mediaType;

    // The format the model picked, constrained to one of the right media type.
    // A wrong-type or out-of-range index falls back to the most-observed format
    // of the right type rather than being dropped: the idea is still usable,
    // and which format it is filed under is metadata.
    const chosen = usableFormats[draft.format_index];
    const format = chosen && chosen.media_type === mediaType
      ? chosen
      : usableFormats.find((f) => f.media_type === mediaType) ?? null;

    const prompt = (mediaType === 'image' ? draft.image_prompt : draft.video_prompt).trim();
    if (!prompt) {
      rejected.push({
        idea_index: planned.index,
        reason: `no ${mediaType === 'image' ? 'image' : 'video'} prompt was written`,
      });
      return;
    }

    const sourceUrl = byIndex.get(draft.source_image_index) ?? null;
    const cost = mediaType === 'image' ? imageCost() : videoCost(VIDEO_SECONDS);

    rows.push({
      campaign_id: input.campaignId,
      persona_id: input.persona.id,
      idea_index: planned.index,
      media_type: mediaType,
      format_spec_id: format?.id ?? null,
      angle: draft.angle,
      hook: draft.hook,
      headline: draft.headline,
      primary_text: draft.primary_text,
      cta_label: draft.cta_label,
      visual_concept: draft.visual_concept,
      them_vs_us: { why_this_works: draft.why_this_works },
      kie_model: mediaType === 'image' ? 'google/nano-banana-edit' : 'bytedance/seedance-2-fast',
      kie_prompt: prompt,
      // Written for both, but only ever non-null on a video — the table's own
      // check constraint requires it there, and a static with a storyboard would
      // be a field nobody reads.
      video_storyboard: mediaType === 'video'
        ? { beats: draft.storyboard_beats, seconds: VIDEO_SECONDS }
        : null,
      est_credits: cost.credits,
      est_usd: cost.usd,
      destination_url: input.destinationUrl,
      // Null is allowed and is visible on screen as "no photo chosen". It blocks
      // generation rather than the row: the copy is still worth having, and a
      // photo can be picked by hand.
      source_image_url: sourceUrl,
    });
  });

  return { rows, rejected };
}

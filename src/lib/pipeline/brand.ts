import { generate } from '@/lib/llm';
import { NEUTRAL_BRAND, type BrandKit } from '@/lib/brand';
import { BrandChoiceSchema, type BrandChoice } from './schemas';
import { collectBrandEvidence, normaliseColour, type BrandEvidence } from './brand-sources';
import { asDataUrl } from './image-bytes';

/**
 * Stage 1c — read the seller's brand off their own website.
 *
 * Runs before the base page is written, so the operator reviews the words in
 * the clothes the buyer will see them in rather than approving a grey page and
 * being surprised later.
 *
 * NON-FATAL BY CONSTRUCTION. Every failure here returns the neutral kit and a
 * note. A campaign must never die because a stylesheet 404'd or a logo was an
 * SVG — the pages read perfectly well unbranded, and the whole feature is an
 * improvement on top of a page that already works.
 */

/** Enough to see the mark. More than this and we are captioning a gallery. */
const MAX_LOGO_CANDIDATES = 4;

const SYSTEM = `You identify a brand's visual identity from evidence taken off
its own website, so a landing page can be dressed to match it.

WHY THIS MATTERS. A buyer reads the page, believes it, clicks buy, and lands in
a shop that looks like a different company. That break loses the sale. Your job
is to make the page and the shop look like one place.

THE EVIDENCE IS NOISY AND YOU MUST EXPECT IT TO BE.

Website builders ship their OWN default colours inside the customer's
stylesheet, under exactly the names you would trust. A variable literally called
"--primary" is frequently a builder default that appears nowhere on the rendered
page. Colour counts mislead the same way: a default declared once in a framework
and inherited everywhere outranks the colour on the actual buy button.

So use this order:

1. THE LOGO. It is attached below when we could read it. Whatever colour the
   logo is, the brand is. This outranks everything else.
2. Colours marked "on a button/CTA". A brand paints the thing it wants clicked.
3. Colours marked "on the header/nav".
4. A meta theme-color, which is a site stating its identity to the browser.
5. Raw frequency, last and least.

RULES
- Every colour you return must be copied EXACTLY from the candidate list. Do not
  invent, adjust, lighten or "improve" one. A colour that is not on the list is
  not this brand's colour.
- Primary and accent may be the same value. Most brands have one colour. Two
  different values only when the evidence genuinely shows two.
- Never return a near-grey as primary or accent. If the only strong candidates
  are greys, say so with confidence "low" and pick the darkest neutral — a
  black-and-white brand is a real brand.
- Fonts: return the family NAME only, without quotes and without the fallback
  stack. Where a heading font and a body font differ, respect that.
- A logo is a mark or a wordmark. A photograph of the product is not a logo,
  and neither is a lifestyle shot used as a social image. Return -1 rather than
  putting a photograph at the top of the page.
- confidence "low" is a real answer and costs nothing. Use it whenever the
  colours came from frequency alone, or the logo could not be read.`;

function colourLines(evidence: BrandEvidence): string {
  const line = (c: BrandEvidence['colours'][number]) => {
    const where: string[] = [];
    if (c.onAction) where.push('on a button/CTA');
    if (c.onChrome) where.push('on the header/nav');
    if (c.names.length) where.push(`declared as ${c.names.join(', ')}`);
    return `${c.hex} — ${c.hits} mentions${where.length ? `; ${where.join('; ')}` : ''}`;
  };
  return [
    'BRAND COLOUR CANDIDATES (strongest evidence first)',
    ...evidence.colours.map(line),
    '',
    'NEUTRALS (for text and page background only)',
    ...evidence.neutrals.map(line),
  ].join('\n');
}

function fontLines(evidence: BrandEvidence): string {
  const seen = evidence.fonts.map(
    (f) => `${f.family} — seen ${f.hits}×${f.role === 'unknown' ? '' : ` on ${f.role}s`}`,
  );
  return [
    'FONT STACKS DECLARED IN THEIR CSS',
    ...(seen.length ? seen : ['(none found)']),
    '',
    'FAMILIES THIS PAGE LOADS FROM GOOGLE FONTS',
    ...(evidence.google_fonts.length ? evidence.google_fonts : ['(none)']),
  ].join('\n');
}

/**
 * Turn the model's answer into the kit the renderer reads, refusing anything it
 * should not have said.
 *
 * Every rule the prompt states is re-checked here. A colour that is not a
 * colour, an index out of range, a photograph chosen as a logo — all cheap to
 * detect and expensive to notice once twenty ad destinations are live. A rule
 * that lives only in a prompt is a rule that holds most of the time.
 */
export function resolveBrand(
  choice: BrandChoice,
  evidence: BrandEvidence,
  readable: number[],
): BrandKit {
  const notes = [...evidence.notes];

  const colour = (raw: string, fallback: string, what: string): string => {
    const hex = normaliseColour(raw);
    if (!hex) {
      notes.push(`${what}: "${raw}" is not a colour, so the neutral was kept.`);
      return fallback;
    }
    return hex;
  };

  const primary = colour(choice.primary_color, NEUTRAL_BRAND.primary, 'Primary colour');
  const accent = colour(choice.accent_color, primary, 'Button colour');

  const stack = (family: string, generic: 'serif' | 'sans-serif', fallback: string): string => {
    const name = family.trim().replace(/^["']|["']$/g, '');
    if (!name) return fallback;
    const tail = generic === 'serif'
      ? 'ui-serif, Georgia, Cambria, "Times New Roman", serif'
      : 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    return `"${name}", ${tail}`;
  };

  // Only families the source page itself pulls from Google Fonts get loaded.
  // Anything else is self-hosted on their CDN under a licence that is theirs,
  // not ours, and a bad @font-face is a worse page than a good fallback.
  const wanted = [choice.heading_font_family, choice.body_font_family]
    .map((f) => f.trim().toLowerCase())
    .filter(Boolean);
  const google = evidence.google_fonts.filter((f) => wanted.includes(f.trim().toLowerCase()));
  const missing = [choice.heading_font_family, choice.body_font_family]
    .map((f) => f.trim())
    .filter((f) => f && !google.some((g) => g.toLowerCase() === f.toLowerCase()));
  if (missing.length) {
    notes.push(`${[...new Set(missing)].join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not `
      + 'loaded from Google Fonts by their site, so the pages fall back to a matching '
      + 'system typeface rather than shipping a font we do not have.');
  }

  const pickImage = (index: number, what: string): string | null => {
    if (index < 0) return null;
    if (index >= evidence.images.length) {
      notes.push(`${what}: image ${index} does not exist, so none was used.`);
      return null;
    }
    if (!readable.includes(index)) {
      // It was never shown to the model, so "it chose it" means it guessed from
      // the description. Allowed for the icon, refused for the logo: an icon is
      // small and a wrong one costs a tab, a wrong logo is the top of the page.
      notes.push(`${what}: image ${index} could not be read, so it was chosen sight unseen.`);
    }
    return evidence.images[index].url;
  };

  const logo = pickImage(choice.logo_index, 'Logo');
  const icon = pickImage(choice.icon_index, 'Icon');
  if (!logo) notes.push('No logo was placed on the pages — none of the images on the site is one.');

  if (choice.reasoning.trim()) notes.push(choice.reasoning.trim());

  return {
    source_url: evidence.url,
    site_name: choice.site_name.trim() || evidence.site_name,
    logo_url: logo,
    icon_url: icon,
    primary,
    accent,
    ink: colour(choice.ink_color, NEUTRAL_BRAND.ink, 'Text colour'),
    surface: colour(choice.surface_color, NEUTRAL_BRAND.surface, 'Background colour'),
    heading_font: stack(choice.heading_font_family, choice.heading_font_generic,
      NEUTRAL_BRAND.heading_font),
    body_font: stack(choice.body_font_family, choice.body_font_generic, NEUTRAL_BRAND.body_font),
    google_fonts: google,
    radius: evidence.radius ?? NEUTRAL_BRAND.radius,
    confidence: choice.confidence,
    notes,
  };
}

export type BrandResult = {
  brand: BrandKit;
  /** True when we read a real brand; false when the neutral kit is standing in. */
  branded: boolean;
  usage?: { input: number; output: number };
};

/**
 * The whole stage: fetch the site, gather candidates, look at the logo, decide.
 *
 * Never throws. A brand we could not read is a plain page, which is the page we
 * were already shipping yesterday.
 */
export async function readBrand(pageUrl: string): Promise<BrandResult> {
  let evidence: BrandEvidence;
  try {
    evidence = await collectBrandEvidence(pageUrl);
  } catch (e) {
    return {
      brand: { ...NEUTRAL_BRAND, source_url: pageUrl, notes: [(e as Error).message] },
      branded: false,
    };
  }

  if (!evidence.colours.length && !evidence.neutrals.length && !evidence.images.length) {
    return {
      brand: {
        ...NEUTRAL_BRAND,
        source_url: pageUrl,
        notes: ['This site gave up no colours, fonts or logo, so the pages use the neutral '
          + 'editorial theme.'],
      },
      branded: false,
    };
  }

  // The logo is the tie-break, so it goes in front of the model as a picture
  // rather than as a filename. Indexes stay stable across the readable/unread
  // split for the same reason they do in the image stage: index 2 is index 2
  // whether or not index 1 loaded.
  const candidates = evidence.images.slice(0, MAX_LOGO_CANDIDATES);
  const fetched = await Promise.all(candidates.map((i) => asDataUrl(i.url)));
  const readable = fetched
    .map((dataUrl, index) => ({ index, dataUrl }))
    .filter((i): i is { index: number; dataUrl: string } => i.dataUrl !== null);

  const imageList = evidence.images.map((img, index) => {
    const shown = readable.some((r) => r.index === index);
    return `IMAGE ${index}: ${img.why}${shown ? '' : ' (could not be read — described only)'}`;
  }).join('\n');

  let choice: BrandChoice;
  let usage;
  try {
    const result = await generate({
      system: SYSTEM,
      prompt: `SITE\n---\n${evidence.url}\n`
        + `${evidence.site_name ?? evidence.page_title ?? ''}\n---\n\n`
        + `${colourLines(evidence)}\n\n${fontLines(evidence)}\n\n`
        + `IMAGES FROM THIS SITE\n---\n${imageList || '(none)'}\n---\n\n`
        + `${readable.length} of them are attached below in index order: `
        + `${readable.map((r) => `IMAGE ${r.index}`).join(', ') || '(none)'}.\n\n`
        + 'Identify this brand.',
      images: readable.map((r) => r.dataUrl),
      schema: BrandChoiceSchema,
      // Weighing contradictory evidence against a picture, not extraction.
      effort: 'high',
      maxTokens: 2000,
    });
    choice = result.data;
    usage = result.usage;
  } catch (e) {
    return {
      brand: {
        ...NEUTRAL_BRAND,
        source_url: pageUrl,
        notes: [`The brand could not be identified (${(e as Error).message}), so the pages `
          + 'use the neutral editorial theme.'],
      },
      branded: false,
    };
  }

  return {
    brand: resolveBrand(choice, evidence, readable.map((r) => r.index)),
    branded: true,
    usage: { input: usage.input, output: usage.output },
  };
}

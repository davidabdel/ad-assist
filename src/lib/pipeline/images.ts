import { generate } from '@/lib/llm';
import { ImagePlanSchema, type ImagePlan, type ProductBrief } from './schemas';
import type { Reason } from '@/lib/page-data';

/**
 * Stage 2c — pictures, after the words are approved.
 *
 * THE PHOTOS ARE THE CUSTOMER'S OWN. Nothing here generates an image and
 * nothing here pays for one. The ingest already read every photograph off the
 * source page into `brief.image_urls`; this stage looks at them, writes down
 * what each one shows, and puts them against the reasons they genuinely
 * illustrate. That constraint is not a cost saving, it is the accuracy
 * argument: a generated photograph of somebody else's product on somebody
 * else's page is a misrepresentation, and these pages are ad destinations.
 *
 * WHY IT RUNS AFTER APPROVAL. The main page is reviewed as slots — each reason
 * shows where its picture goes and what the copy says it should show. Choosing
 * pictures first would mean illustrating a page that might be sent back, and
 * would put a photograph in front of the operator at the moment he is supposed
 * to be reading the words.
 *
 * -1 IS A REAL ANSWER. A library of thirteen photos does not contain eleven
 * honest illustrations, and a page with four good pictures reads better than
 * one with eleven where seven are a bottle on a bench captioned as recycling.
 * An unfilled slot renders as nothing on a live page.
 */

/**
 * Enough to cover any product gallery, capped because a page that returns two
 * hundred images is a page whose gallery we misread, and each one costs tokens.
 */
const MAX_IMAGES = 24;

/**
 * Well above a product photo and well below anything that would make the
 * request unwieldy. A URL that serves more than this is not a product photo.
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * WE FETCH THE PHOTOS OURSELVES RATHER THAN HANDING OVER URLs.
 *
 * The first live run failed on exactly that: the model was given the seller's
 * own image URLs and came back `400 Unable to download content from the
 * provided URL before the timeout`. Those URLs were fine — curl pulls them in
 * 40ms — but they are behind a CDN that refuses some clients (python-urllib
 * gets a bare 403) and they carry a second unencoded `https://` inside the
 * path, which is enough to defeat a fetcher that normalises URLs.
 *
 * Neither of those is fixable from here, and both will recur: every campaign
 * points at somebody else's CDN. Reading the bytes on our own server and
 * sending them inline removes the third party from the loop entirely, and it
 * is the same fetch, with the same browser headers, that already reads the
 * product page.
 */
const IMAGE_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Sec-Fetch-Dest': 'image',
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Site': 'cross-site',
};

async function asDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: IMAGE_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    // The four the API accepts. A CDN that returns `application/octet-stream`
    // for a webp is common enough to be worth the sniff below rather than a
    // rejection.
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;

    const mime = /^image\/(png|jpeg|webp|gif)$/.test(type) ? type : sniff(buf);
    return mime ? `data:${mime};base64,${buf.toString('base64')}` : null;
  } catch {
    return null;
  }
}

/** Magic bytes, for the CDNs that mislabel what they serve. */
function sniff(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const SYSTEM = `You are an art director choosing photographs for a listicle
landing page. Every photograph you are shown was taken off the seller's own
website, so it is the real product and the real brand.

You do two things in one pass.

FIRST, caption every image. The stage that writes the twenty buyer-specific
pages is a text-only call — it will never see these pictures, and your caption
is the only thing it will have to choose from. Write what is actually in the
frame: the object, the setting, who is in it and what they are doing.

SECOND, put photographs against the reasons they illustrate.

RULES
- A photograph may be used ONCE on the page. The same picture twice reads as a
  broken template.
- Only assign a photograph that genuinely shows what the reason claims. A reason
  about recycling is not illustrated by a bottle on a bench. When nothing fits,
  return -1. That is a correct answer and you should expect to return several.
- Never assign a logo, a wordmark, a banner, an icon, or an image that is mostly
  text. Mark those unusable instead.
- The hero is the widest, most human, most immediately understandable shot —
  what somebody arriving from an ad should see first. It does not go in a slot
  as well.
- Alt text describes the photograph, not the reason. Somebody who cannot see it
  should learn what is in it.`;

function slotList(reasons: Reason[]): string {
  return reasons.map((r) => {
    const want = r.image_prompt?.trim();
    return `REASON ${r.number}: ${r.title}\n`
      + `  says: ${r.body}\n`
      + `  the copy expects a picture of: ${want || '(nothing specified)'}`;
  }).join('\n\n');
}

export type ImagePlanResult = {
  plan: ImagePlan;
  /** Positions whose bytes could not be read. Never usable, never chosen. */
  unreadable: number[];
  usage: { input: number; output: number };
};

export async function planImages(
  brief: ProductBrief,
  reasons: Reason[],
  imageUrls: string[],
): Promise<ImagePlanResult> {
  const urls = imageUrls.slice(0, MAX_IMAGES);

  // Positions are the library's identity — the persona stage refers to a photo
  // by its number — so a photo we cannot read is skipped rather than closing the
  // gap. Index 7 is index 7 whether or not index 3 loaded.
  const fetched = await Promise.all(urls.map((u) => asDataUrl(u)));
  const readable = fetched
    .map((dataUrl, position) => ({ position, dataUrl }))
    .filter((i): i is { position: number; dataUrl: string } => i.dataUrl !== null);
  const unreadable = fetched
    .map((d, position) => (d === null ? position : -1))
    .filter((p) => p >= 0);

  if (!readable.length) {
    throw new Error(
      `none of the ${urls.length} photographs on the page could be downloaded `
      + '— the site may be blocking us, or the links may be dead',
    );
  }

  const labels = readable.map((i) => `IMAGE ${i.position}`).join(', ');

  const { data, usage } = await generate({
    system: SYSTEM,
    cachedContext: `PRODUCT\n---\n${brief.brand_name} — ${brief.product_name}\n`
      + `${brief.one_line_summary}\n---`,
    prompt: `${readable.length} photographs from this seller's website are attached below, `
      + `in this order: ${labels}. Use those numbers as the index — they are not `
      + 'always consecutive, because a photo that could not be downloaded is '
      + 'skipped and keeps its number.\n\n'
      + 'Caption all of them, pick the hero, and fill the slots below.\n\n'
      + `THE PAGE'S ${reasons.length} SLOTS\n---\n${slotList(reasons)}\n---`,
    images: readable.map((i) => i.dataUrl),
    schema: ImagePlanSchema,
    maxTokens: 8000,
  });

  return { plan: data, unreadable, usage };
}

export type ResolvedImages = {
  /** One row per source image, ready to insert into `campaign_images`. */
  library: {
    position: number;
    source_url: string;
    caption: string;
    kind: 'photo' | 'graphic' | 'logo';
    usable: boolean;
  }[];
  hero: { url: string; alt: string } | null;
  /** Reason number → the picture that goes in it. Missing means the slot stays empty. */
  bySlot: Map<number, { url: string; alt: string }>;
  /** Said out loud on the progress screen rather than swallowed. */
  notes: string[];
};

/**
 * Turns the model's indexes into URLs, and refuses the ones it should not have
 * chosen.
 *
 * Every rule the prompt states is re-checked here. An index out of range, a
 * logo in a slot, or the same photograph used twice are all cheap to detect and
 * expensive to notice on a live page, and a rule that is only in a prompt is a
 * rule that holds most of the time.
 */
export function resolveImages(
  plan: ImagePlan,
  imageUrls: string[],
  unreadable: number[] = [],
): ResolvedImages {
  const urls = imageUrls.slice(0, MAX_IMAGES);
  const notes: string[] = [];
  const couldNotRead = new Set(unreadable);

  const described = new Map(plan.images.map((i) => [i.index, i]));
  const library = urls.map((source_url, position) => {
    const d = described.get(position);
    return {
      position,
      source_url,
      caption: d?.caption ?? '',
      kind: d?.kind ?? 'photo' as const,
      // No caption means the model skipped it, or we never got the bytes to show
      // it. Unusable either way rather than assumed usable: the persona stage
      // picks by caption, and an empty caption is an invitation to pick blind.
      usable: d ? d.usable && d.kind === 'photo' && !couldNotRead.has(position) : false,
    };
  });

  if (couldNotRead.size) {
    notes.push(`${couldNotRead.size} of ${urls.length} photos could not be downloaded from `
      + 'your site and were left out.');
  }

  const used = new Set<number>();
  const take = (index: number, what: string): { url: string; alt: string } | null => {
    if (index < 0) return null;
    if (index >= urls.length) {
      notes.push(`${what}: image ${index} does not exist, left empty.`);
      return null;
    }
    if (!library[index].usable) {
      notes.push(`${what}: image ${index} is a ${library[index].kind}, not editorial. Left empty.`);
      return null;
    }
    if (used.has(index)) {
      notes.push(`${what}: image ${index} is already used on this page. Left empty.`);
      return null;
    }
    used.add(index);
    return { url: urls[index], alt: '' };
  };

  const heroPick = take(plan.hero_image_index, 'Hero');
  const hero = heroPick
    ? { url: heroPick.url, alt: library[plan.hero_image_index].caption }
    : null;

  const bySlot = new Map<number, { url: string; alt: string }>();
  for (const slot of plan.slots) {
    const pick = take(slot.image_index, `Reason ${slot.reason_number}`);
    if (pick) {
      bySlot.set(slot.reason_number, {
        url: pick.url,
        alt: slot.alt || library[slot.image_index].caption,
      });
    }
  }

  return { library, hero, bySlot, notes };
}

/** Writes the chosen pictures into the reason objects the page renders from. */
export function applyImages(reasons: Reason[], bySlot: ResolvedImages['bySlot']): Reason[] {
  return reasons.map((r) => {
    const pick = bySlot.get(r.number);
    return pick
      ? { ...r, image_url: pick.url, image_alt: pick.alt }
      : { ...r, image_url: null, image_alt: null };
  });
}

/**
 * The library as the persona stage sees it: an index and a sentence. Only the
 * usable ones, because an index the persona is not allowed to pick is an index
 * it will occasionally pick anyway.
 */
export function libraryForPrompt(
  library: { position: number; caption: string; usable: boolean }[],
): string {
  const usable = library.filter((i) => i.usable && i.caption);
  if (!usable.length) return '';
  return usable.map((i) => `${i.position}: ${i.caption}`).join('\n');
}

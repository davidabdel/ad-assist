// linkedom, not jsdom, and the reason is production-only: Next treats jsdom as an
// external package, so the serverless function `require()`s it — and jsdom now
// pulls in an ESM-only encoding sniffer, which cannot be required. The build is
// clean and the route 500s with "Failed to load external module jsdom". linkedom
// gets bundled instead, so no require() of ESM happens, and it gives Readability
// and the selectors below the same DOM surface. The Mac worker keeps jsdom: it
// runs on plain Node, where none of this applies.
import { parseHTML } from 'linkedom';
import {
  dedupeReviews,
  extractAmazon,
  extractJsonLdProduct,
  jsonLdScripts,
  mapShopifyProduct,
  mergeStructured,
  readableFromDocument,
  redirectedToHomepage,
  reviewsFromDocument,
  shopifyEndpointFor,
} from './extract.js';

/**
 * Reading a product page from the server, over a plain HTTP fetch.
 *
 * This is the default path. It needs no browser and no Mac, which is the whole
 * point: creating a campaign used to require David's machine to be awake.
 *
 * What it gets, measured against two real Shopify stores: the store's own product
 * JSON (title, price, every image, every variant), the JSON-LD Product block
 * (currency, aggregate rating), and the page text. Sub-second.
 *
 * What it does NOT get, and this is the honest cost of moving off the Mac:
 * verbatim customer reviews. On most Shopify stores those live in a third-party
 * widget that only exists after JavaScript runs, so a fetch sees an empty
 * container. The rating and the review COUNT still come through, so the payload
 * can say "938 reviews exist and none of them are readable from here" rather than
 * implying the product has none. When that happens the caller falls back to the
 * Mac, which does run a real browser.
 *
 * Sites that refuse a bare fetch entirely (Amazon answers "Server Busy" in 2 KB)
 * are detected here and handed to the Mac rather than guessed at.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/**
 * A bare `fetch` announces itself as a robot by what it does NOT send. These are
 * the headers a real Chrome tab sends on a top-level navigation.
 */
const HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'no-cache',
};

/** Phrases that mean "you are a bot", not "here is the product". */
const WALL_MARKERS = [
  'server busy',
  'robot check',
  'enter the characters you see below',
  'access denied',
  'attention required',
  'just a moment',
  'checking your browser',
  'pardon our interruption',
  'are you a human',
  'verify you are human',
];

export type IngestPayload = {
  url: string;
  final_url: string;
  http_status: number | null;
  fetched_at: string;
  ingest_route: 'server' | 'mac';
  structured: Record<string, unknown> | null;
  structured_source: string | null;
  page_title: string | null;
  markdown: string;
  review_widget: string | null;
  reviews: { text: string; rating: number | null; author: string | null }[];
  warnings: string[];
};

export type CloudIngestResult = {
  payload: IngestPayload | null;
  /** Enough real product data to build a brief from. */
  usable: boolean;
  /** Why not, in words meant for whoever is watching the wizard. */
  reason: string | null;
};

async function get(url: string, headers: Record<string, string>, ms: number) {
  return fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(ms) });
}

/** Shopify serves /products/<handle>.js as text/javascript, NOT json. */
async function fetchShopifyProduct(url: string) {
  const endpoint = shopifyEndpointFor(url);
  if (!endpoint) return null;
  try {
    const res = await get(endpoint, { ...HEADERS, Accept: 'application/json' }, 15_000);
    if (!res.ok) return null;
    // Gating on an application/json content-type here silently threw away the
    // best product source we get. Parse the text and let JSON.parse decide.
    const body = await res.text();
    try { return mapShopifyProduct(JSON.parse(body)); } catch { return null; }
  } catch {
    return null;
  }
}

export async function ingestProductFromServer(url: string): Promise<CloudIngestResult> {
  const warnings: string[] = [];
  let res: Response;
  let html: string;

  try {
    res = await get(url, HEADERS, 25_000);
    html = await res.text();
  } catch (e) {
    return {
      payload: null,
      usable: false,
      reason: `The page could not be fetched from the server (${(e as Error).message}).`,
    };
  }

  const lower = html.slice(0, 4000).toLowerCase();
  const wall = WALL_MARKERS.find((m) => lower.includes(m));
  // A bot wall is short AND says so. Length alone is not enough — plenty of real
  // pages are small — and a marker alone is not enough either, because a genuine
  // product page can contain the words "just a moment" in its copy.
  if (wall && html.length < 20_000) {
    return {
      payload: null,
      usable: false,
      reason: `The store blocked the server ("${wall}"). This one needs a real browser.`,
    };
  }
  if (res.status >= 400) {
    return {
      payload: null,
      usable: false,
      reason: `The page returned HTTP ${res.status}.`,
    };
  }

  const { document } = parseHTML(html);

  const shopify = await fetchShopifyProduct(url) ?? extractAmazon(document, url);
  const ld = extractJsonLdProduct(jsonLdScripts(document));
  const structured = mergeStructured(shopify, ld?.structured ?? null);
  const readable = readableFromDocument(document);

  // Reviews, best source first: JSON-LD review nodes are verbatim and structured;
  // anything rendered into the static HTML is second best.
  const fromDom = reviewsFromDocument(document);
  const reviews = dedupeReviews([...(ld?.reviews ?? []), ...fromDom.reviews]);
  const widget = ld?.reviews?.length ? 'json_ld' : fromDom.widget;

  if (!structured) {
    warnings.push('no structured product data (no Shopify JSON, no JSON-LD); '
      + 'parsed from page text only');
  }
  if (!reviews.length) {
    const count = (structured?.rating as { count?: number } | null)?.count;
    warnings.push(count
      // The difference between "no reviews exist" and "reviews exist and I cannot
      // read them" changes what the operator should do, so it is spelled out.
      ? `this product has ${count} reviews but none of them are readable without a `
        + 'browser — they load after JavaScript. Persona proof quotes will be blank '
        + 'unless this page is re-read on the Mac'
      : 'no on-page reviews found — persona proof quotes will be left blank');
  }
  if (redirectedToHomepage(url, res.url)) {
    warnings.push(`redirected to the site homepage (${new URL(res.url).origin}) — the product `
      + 'URL is probably dead; this is NOT product data');
  }

  const payload: IngestPayload = {
    url,
    final_url: res.url,
    http_status: res.status,
    fetched_at: new Date().toISOString(),
    ingest_route: 'server',
    structured,
    structured_source: (structured?.source as string) ?? null,
    page_title: readable.title,
    markdown: readable.markdown,
    review_widget: widget,
    reviews,
    warnings,
  };

  // The gate. Structured data is the strong signal; failing that, enough page text
  // to describe a product at all. Below both, the Mac gets the job rather than the
  // pipeline building twenty landing pages out of a navigation menu.
  const usable = Boolean(structured) || readable.markdown.length >= 400;
  return {
    payload,
    usable,
    reason: usable ? null
      : 'The server read the page but found no product data on it — no store JSON, '
        + 'no product schema, and almost no text.',
  };
}

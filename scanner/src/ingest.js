// Product ingestion in a real browser — now the FALLBACK, not the default.
//
// The server reads product pages by itself (src/lib/ingest/cloud.ts) and only
// hands one to this file when a plain HTTP fetch will not do: a store that blocks
// non-browser traffic, or a page whose product data only exists after JavaScript.
// Amazon is the standing example — it answers a bare fetch with "Server Busy".
//
// The parsing itself is NOT duplicated here. Both paths import the same
// extractors from src/lib/ingest/extract.js, so a fix to a selector fixes both.
// The one thing this file still does its own way is reviews: a live page can be
// scrolled and read with innerText, which is how the widgets that render after
// JavaScript get harvested at all. That is the whole reason the Mac path exists.

import { JSDOM } from 'jsdom';
import {
  dedupeReviews,
  extractAmazon,
  extractJsonLdProduct,
  jsonLdScripts,
  mapShopifyProduct,
  mergeStructured,
  readableFromDocument,
  redirectedToHomepage,
  REVIEW_WIDGETS,
  shopifyEndpointFor,
} from '../../src/lib/ingest/extract.js';
import { getBrowser, newPage, scrollThrough, sleep } from './browser.js';

/**
 * Shopify hands over a clean product object if you just ask for it. Fetched from
 * inside the page rather than from Node, so it is same-origin and carries
 * whatever cookies the store expects.
 */
async function tryShopifyJson(page, url) {
  const endpoint = shopifyEndpointFor(url);
  if (!endpoint) return null;
  try {
    const data = await page.evaluate(async (ep) => {
      const r = await fetch(ep, { headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      // Shopify serves this as text/javascript, not application/json. Gating on
      // content-type here silently threw away the best product source we get.
      const body = await r.text();
      try { return JSON.parse(body); } catch { return null; }
    }, endpoint);
    return mapShopifyProduct(data);
  } catch {
    return null;
  }
}

/**
 * Reviews off the LIVE page. A real browser is the whole point here: these
 * widgets render after JS, often lazily, so we scroll first and read innerText,
 * which respects what is actually visible.
 */
async function harvestReviews(page, limit = 50) {
  await scrollThrough(page, { maxScrolls: 25 });
  await sleep(1200);

  const found = await page.evaluate((widgets) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const read = (nodes) => nodes.map((n) => {
      const text = clean(n.innerText);
      const starEl = n.querySelector('[class*="star"], [class*="rating"], [aria-label*="star" i]');
      const label = starEl?.getAttribute('aria-label') || starEl?.getAttribute('title') || '';
      const rating = Number((label.match(/([0-5](?:\.\d)?)/) || [])[1]) || null;
      const author = clean(
        n.querySelector('[class*="author"], [class*="name"], [itemprop="author"]')?.innerText);
      return { text, rating, author: author || null };
    }).filter((r) => r.text && r.text.length > 25);

    // Fast path: a widget we already know.
    for (const w of widgets) {
      const nodes = [...document.querySelectorAll(w.sel)];
      if (nodes.length < 2) continue;   // one match is usually a template, not a review
      const out = read(nodes);
      if (out.length) return { widget: w.name, reviews: out };
    }

    // Structural fallback: find the repeated review CARD without knowing the
    // vendor. Any class containing "review" that appears 3+ times and whose median
    // text is paragraph-length is the container; the class with the LONGEST median
    // is the outermost card rather than an inner fragment. This is what lets a
    // widget we have never seen still produce quotes.
    const byClass = new Map();
    for (const el of document.querySelectorAll('[class*="review" i]')) {
      const len = clean(el.innerText).length;
      for (const c of el.classList) {
        if (!/review/i.test(c)) continue;
        if (!byClass.has(c)) byClass.set(c, []);
        byClass.get(c).push(len);
      }
    }
    const candidates = [...byClass.entries()]
      .map(([c, lens]) => {
        const sorted = lens.slice().sort((a, b) => a - b);
        return { c, n: lens.length, med: sorted[Math.floor(sorted.length / 2)] };
      })
      .filter((x) => x.n >= 3 && x.med > 60)
      .sort((a, b) => b.med - a.med);

    if (candidates.length) {
      const best = candidates[0];
      const out = read([...document.querySelectorAll(`.${CSS.escape(best.c)}`)]);
      if (out.length) return { widget: `discovered:${best.c}`, reviews: out };
    }
    return { widget: null, reviews: [] };
  }, REVIEW_WIDGETS);

  return { widget: found.widget, reviews: dedupeReviews(found.reviews, limit) };
}

/**
 * Scrape one product URL into a raw payload. Deliberately does NOT call an LLM —
 * that is a separate stage running server-side, so a scrape can be re-parsed
 * without re-scraping and a prompt change costs nothing.
 */
export async function ingestProduct(url, { keepOpen = false } = {}) {
  const browser = await getBrowser();
  const page = await newPage(browser);
  const warnings = [];
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const httpStatus = res?.status() ?? null;
    if (httpStatus && httpStatus >= 400) {
      warnings.push(`page returned HTTP ${httpStatus}`);
    }
    await page.waitForNetworkIdle({ idleTime: 1200, timeout: 20_000 }).catch(() => {
      warnings.push('network never went idle; read the page as it stood');
    });

    const shopify = await tryShopifyJson(page, url);

    // One parse of the rendered DOM, shared by the readers that do not need a live
    // page. This is the same document shape the server path builds, which is what
    // keeps the two routes producing identical output from identical HTML.
    const dom = new JSDOM(await page.content(), { url: page.url() });
    const { document } = dom.window;

    const primary = shopify || extractAmazon(document, url);
    const ld = extractJsonLdProduct(jsonLdScripts(document));
    const structured = mergeStructured(primary, ld?.structured ?? null);
    const readable = readableFromDocument(document, await page.title());

    const live = await harvestReviews(page);
    const reviews = dedupeReviews([...(ld?.reviews ?? []), ...live.reviews]);
    const widget = live.widget ?? (ld?.reviews?.length ? 'json_ld' : null);

    if (!reviews.length) {
      warnings.push('no on-page reviews found — persona proof quotes will be left blank');
    }
    if (!structured) {
      warnings.push('no structured product data (no Shopify JSON, no JSON-LD); '
        + 'parsed from page text only');
    }
    // A store that redirects a dead product URL to its homepage returns HTTP 200,
    // and everything downstream would happily build 20 personas for "the
    // homepage". Cheap check, catches the silent version of a 404.
    if (redirectedToHomepage(url, page.url())) {
      warnings.push(`redirected to the site homepage (${new URL(page.url()).origin}) — the product `
        + 'URL is probably dead; this is NOT product data');
    }

    return {
      url,
      final_url: page.url(),
      http_status: httpStatus,
      fetched_at: new Date().toISOString(),
      ingest_route: 'mac',
      structured,
      structured_source: structured?.source ?? null,
      page_title: readable.title,
      markdown: readable.markdown,
      review_widget: widget,
      reviews,
      warnings,
    };
  } finally {
    if (!keepOpen) await page.close().catch(() => {});
    browser.disconnect();
  }
}

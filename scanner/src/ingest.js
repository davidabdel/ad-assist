// Product ingestion — the Firecrawl replacement (David, 6 Sep: "just use the
// chrome browser").
//
// Order of preference, best source first:
//   1. Shopify's own product JSON (/products/<handle>.js). Structured, exact,
//      no parsing guesswork. Roughly a third of DTC stores hand it over.
//   2. JSON-LD Product schema. Most serious e-commerce templates emit it.
//   3. Readability + turndown over the rendered DOM. The always-works fallback.
// Reviews are harvested separately, because on Shopify they almost always live in
// a third-party widget that only exists after JS runs — which is exactly the thing
// a fetch-based scraper misses and a real browser gets for free.

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { getBrowser, newPage, scrollThrough, sleep } from './browser.js';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
turndown.remove(['script', 'style', 'noscript', 'iframe', 'form']);

const REVIEW_WIDGETS = [
  { name: 'judgeme',  sel: '.jdgm-rev' },
  { name: 'loox',     sel: '.loox-review, [data-loox-review]' },
  { name: 'okendo',   sel: '[data-oke-reviews-review], .oke-review' },
  // .yotpo-review-card is the current markup; .yotpo-review is the legacy widget.
  // Matching only the old one made a Yotpo store look review-free.
  { name: 'yotpo',    sel: '.yotpo-review-card, .yotpo-review, .yotpo-regular-box' },
  { name: 'stamped',  sel: '.stamped-review' },
  { name: 'shopify',  sel: '.spr-review' },
  // Amazon ships no JSON-LD and hashes its class names, but data-hook is stable.
  { name: 'amazon',   sel: '[data-hook="review"]' },
  { name: 'generic',  sel: '[itemprop="review"], .review-item, .product-review' },
];

/**
 * Amazon. No Shopify JSON, no JSON-LD Product, and hashed class names — but the
 * element IDs have been stable for years, so it gets its own reader rather than
 * being left to the text fallback.
 */
async function tryAmazon(page, url) {
  if (!/(^|\.)amazon\./i.test(new URL(url).hostname)) return null;
  const data = await page.evaluate(() => {
    const t = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() || null;
    const title = t('#productTitle');
    if (!title) return null;
    const priceText = t('#corePrice_feature_div .a-offscreen')
      || t('.priceToPay .a-offscreen') || t('#price_inside_buybox');
    const bullets = [...document.querySelectorAll('#feature-bullets li')]
      .map((li) => li.textContent.replace(/\s+/g, ' ').trim())
      .filter((s) => s && !/see more/i.test(s));
    let images = [];
    const dyn = document.querySelector('#landingImage')?.getAttribute('data-a-dynamic-image');
    if (dyn) { try { images = Object.keys(JSON.parse(dyn)); } catch { /* ignore */ } }
    const ratingTxt = t('#acrPopover .a-icon-alt') || t('[data-hook="rating-out-of-text"]');
    const countTxt = t('#acrCustomerReviewText');
    return {
      title,
      brand: t('#bylineInfo'),
      priceText,
      bullets,
      images,
      ratingTxt,
      countTxt,
      breadcrumb: [...document.querySelectorAll('#wayfinding-breadcrumbs_feature_div a')]
        .map((a) => a.textContent.trim()).filter(Boolean),
    };
  });
  if (!data) return null;
  const price = data.priceText
    ? Number(String(data.priceText).replace(/[^0-9.]/g, '')) || null : null;
  return {
    source: 'amazon_dom',
    product_name: data.title,
    brand_name: (data.brand || '').replace(/^(visit the |brand: )/i, '').replace(/ store$/i, '') || null,
    category: data.breadcrumb.at(-1) || null,
    description_html: data.bullets.map((b) => `<li>${b}</li>`).join(''),
    features: data.bullets,
    price,
    currency: /\$/.test(data.priceText || '') ? 'AUD' : null,
    images: data.images.slice(0, 12),
    rating: data.ratingTxt
      ? {
          value: Number((data.ratingTxt.match(/([0-5](?:\.\d)?)/) || [])[1]) || null,
          count: Number((data.countTxt || '').replace(/[^0-9]/g, '')) || 0,
        }
      : null,
  };
}

/** Shopify hands over a clean product object if you just ask for it. */
async function tryShopifyJson(page, url) {
  const u = new URL(url);
  const m = u.pathname.match(/\/products\/([^/?#]+)/);
  if (!m) return null;
  const endpoint = `${u.origin}${u.pathname.split('/products/')[0]}/products/${m[1]}.js`;
  try {
    const data = await page.evaluate(async (ep) => {
      const r = await fetch(ep, { headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      // Shopify serves this as text/javascript, not application/json. Gating on
      // content-type here silently threw away the best product source we get.
      const body = await r.text();
      try { return JSON.parse(body); } catch { return null; }
    }, endpoint);
    if (!data || !data.title) return null;
    return {
      source: 'shopify_json',
      product_name: data.title,
      brand_name: data.vendor || null,
      category: data.product_type || null,
      description_html: data.description || '',
      price: data.price != null ? data.price / 100 : null,
      compare_at_price: data.compare_at_price != null ? data.compare_at_price / 100 : null,
      currency: null, // /products/x.js omits it; taken from JSON-LD or the page below
      images: (data.images || []).map((i) => (i.startsWith('//') ? `https:${i}` : i)),
      variants: (data.variants || []).map((v) => ({
        title: v.title, price: v.price / 100, available: v.available,
      })),
      tags: data.tags || [],
    };
  } catch {
    return null;
  }
}

/** JSON-LD Product schema — the second-best structured source. */
async function tryJsonLd(page) {
  const blocks = await page.evaluate(() =>
    [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => s.textContent)
      .filter(Boolean));

  const flatten = (node, out = []) => {
    if (Array.isArray(node)) { node.forEach((n) => flatten(n, out)); return out; }
    if (node && typeof node === 'object') {
      out.push(node);
      if (node['@graph']) flatten(node['@graph'], out);
    }
    return out;
  };

  for (const raw of blocks) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    for (const node of flatten(parsed)) {
      const type = node['@type'];
      const isProduct = type === 'Product'
        || (Array.isArray(type) && type.includes('Product'));
      if (!isProduct) continue;
      const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      return {
        source: 'json_ld',
        product_name: node.name || null,
        brand_name: typeof node.brand === 'object' ? node.brand?.name : node.brand,
        category: node.category || null,
        description_html: node.description || '',
        price: offers?.price != null ? Number(offers.price) : null,
        currency: offers?.priceCurrency || null,
        images: [node.image].flat().filter((i) => typeof i === 'string'),
        rating: node.aggregateRating
          ? {
              value: Number(node.aggregateRating.ratingValue),
              count: Number(node.aggregateRating.reviewCount
                || node.aggregateRating.ratingCount || 0),
            }
          : null,
      };
    }
  }
  return null;
}

/** Readability over the rendered DOM — the fallback that always produces something. */
async function readableMarkdown(page) {
  const html = await page.content();
  const url = page.url();
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  const body = article?.content || dom.window.document.body?.innerHTML || '';
  return {
    title: article?.title || (await page.title()),
    markdown: turndown.turndown(body).replace(/\n{3,}/g, '\n\n').trim(),
  };
}

/**
 * Reviews. A real browser is the whole point here: these widgets render after JS,
 * often lazily, so we scroll first and then read whatever matched.
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

  // De-duplicate: widgets frequently render the same review in a summary rail and
  // again in the full list.
  const seen = new Set();
  const reviews = [];
  for (const r of found.reviews) {
    const key = r.text.slice(0, 120).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    reviews.push(r);
    if (reviews.length >= limit) break;
  }
  return { widget: found.widget, reviews };
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

    const shopify = (await tryShopifyJson(page, url)) || (await tryAmazon(page, url));
    const jsonLd = await tryJsonLd(page);
    const readable = await readableMarkdown(page);
    const { widget, reviews } = await harvestReviews(page);

    if (!reviews.length) {
      warnings.push('no on-page reviews found — persona proof quotes will be left blank');
    }

    // Merge rather than pick. Shopify's JSON is the better spine (every image,
    // every variant) but omits currency and rating, which JSON-LD carries.
    let structured = null;
    if (shopify || jsonLd) {
      structured = { ...(jsonLd || {}), ...(shopify || {}) };
      structured.source = [shopify?.source, jsonLd?.source].filter(Boolean).join('+');
      for (const k of ['currency', 'rating', 'category', 'brand_name']) {
        if (structured[k] == null && jsonLd?.[k] != null) structured[k] = jsonLd[k];
      }
    } else {
      warnings.push('no structured product data (no Shopify JSON, no JSON-LD); '
        + 'parsed from page text only');
    }

    // A store that redirects a dead product URL to its homepage returns HTTP 200,
    // and everything downstream would happily build 20 personas for "the homepage".
    // Cheap check, catches the silent version of a 404.
    const landed = new URL(page.url());
    if (landed.pathname === '/' && new URL(url).pathname !== '/') {
      warnings.push(`redirected to the site homepage (${landed.origin}) — the product `
        + 'URL is probably dead; this is NOT product data');
    }

    return {
      url,
      final_url: page.url(),
      http_status: httpStatus,
      fetched_at: new Date().toISOString(),
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

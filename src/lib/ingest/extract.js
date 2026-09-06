// Product extractors, shared by both places a page can be read from.
//
// Two things read a product page now:
//   1. the server, over a plain HTTP fetch (src/lib/ingest/cloud.ts) — the default
//   2. Chrome on David's Mac (scanner/src/ingest.js) — the fallback for the stores
//      that refuse a bare fetch
//
// Everything in this file works on a parsed Document or on already-fetched text,
// never on a live browser page, which is what lets both callers share it. The one
// piece deliberately NOT shared is review harvesting off a live page: that needs
// `innerText` and a post-scroll DOM, and neither exists here. See harvestReviews
// in the scanner for that version.
//
// Plain JS rather than TypeScript on purpose: the scanner is a plain Node process
// with no build step, and it imports this file directly.

import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
turndown.remove(['script', 'style', 'noscript', 'iframe', 'form']);

export const REVIEW_WIDGETS = [
  { name: 'judgeme', sel: '.jdgm-rev' },
  { name: 'loox', sel: '.loox-review, [data-loox-review]' },
  { name: 'okendo', sel: '[data-oke-reviews-review], .oke-review' },
  // .yotpo-review-card is the current markup; .yotpo-review is the legacy widget.
  // Matching only the old one made a Yotpo store look review-free.
  { name: 'yotpo', sel: '.yotpo-review-card, .yotpo-review, .yotpo-regular-box' },
  { name: 'stamped', sel: '.stamped-review' },
  { name: 'shopify', sel: '.spr-review' },
  // Amazon ships no JSON-LD and hashes its class names, but data-hook is stable.
  { name: 'amazon', sel: '[data-hook="review"]' },
  { name: 'generic', sel: '[itemprop="review"], .review-item, .product-review' },
];

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

/** Turn Shopify's own product object into our shape. */
export function mapShopifyProduct(data) {
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
}

/** The Shopify product-JSON endpoint for a /products/<handle> URL, or null. */
export function shopifyEndpointFor(url) {
  const u = new URL(url);
  const m = u.pathname.match(/\/products\/([^/?#]+)/);
  if (!m) return null;
  return `${u.origin}${u.pathname.split('/products/')[0]}/products/${m[1]}.js`;
}

function flattenLd(node, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => flattenLd(n, out)); return out; }
  if (node && typeof node === 'object') {
    out.push(node);
    if (node['@graph']) flattenLd(node['@graph'], out);
  }
  return out;
}

/**
 * JSON-LD Product schema out of the raw <script> bodies.
 *
 * Also lifts `review` nodes when a store publishes them. Most do not — they carry
 * aggregateRating and nothing else — but where they exist these are verbatim
 * customer words, which is the one thing a fetch normally cannot reach.
 */
export function extractJsonLdProduct(scriptTexts) {
  // A page routinely carries the same product across SEVERAL ld+json blocks, each
  // holding a different slice of it. Allbirds publishes three: the first has the
  // name and price and no rating, a later one has "4.6 from 376 reviews". Reading
  // only the first block threw that rating away, so every Product node is read and
  // the first non-null value for each field wins.
  const products = [];
  const reviews = [];

  for (const raw of scriptTexts) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    for (const node of flattenLd(parsed)) {
      const type = node['@type'];
      const isProduct = type === 'Product'
        || (Array.isArray(type) && type.includes('Product'));
      if (!isProduct) continue;

      const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      products.push({
        source: 'json_ld',
        product_name: node.name || null,
        brand_name: (typeof node.brand === 'object' ? node.brand?.name : node.brand) || null,
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
      });

      for (const r of (node.review ? [node.review].flat().filter(Boolean) : [])) {
        reviews.push({
          text: clean(r.reviewBody || r.description),
          rating: Number(r.reviewRating?.ratingValue) || null,
          author: clean(typeof r.author === 'object' ? r.author?.name : r.author) || null,
        });
      }
    }
  }

  if (!products.length) return null;

  const structured = { source: 'json_ld' };
  for (const key of ['product_name', 'brand_name', 'category', 'description_html',
    'price', 'currency', 'images', 'rating']) {
    for (const p of products) {
      const v = p[key];
      const empty = v == null || v === '' || (Array.isArray(v) && !v.length);
      if (!empty) { structured[key] = v; break; }
    }
    if (!(key in structured)) structured[key] = products[0][key];
  }

  return {
    structured,
    reviews: reviews.filter((r) => r.text && r.text.length > 25),
  };
}

/** Every JSON-LD script body on a document. */
export function jsonLdScripts(document) {
  return [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map((s) => s.textContent)
    .filter(Boolean);
}

/**
 * Amazon. No Shopify JSON, no JSON-LD Product, and hashed class names — but the
 * element IDs have been stable for years, so it gets its own reader.
 */
export function extractAmazon(document, url) {
  if (!/(^|\.)amazon\./i.test(new URL(url).hostname)) return null;
  const t = (sel) => clean(document.querySelector(sel)?.textContent) || null;
  const title = t('#productTitle');
  if (!title) return null;

  const priceText = t('#corePrice_feature_div .a-offscreen')
    || t('.priceToPay .a-offscreen') || t('#price_inside_buybox');
  const bullets = [...document.querySelectorAll('#feature-bullets li')]
    .map((li) => clean(li.textContent))
    .filter((s) => s && !/see more/i.test(s));

  let images = [];
  const dyn = document.querySelector('#landingImage')?.getAttribute('data-a-dynamic-image');
  if (dyn) { try { images = Object.keys(JSON.parse(dyn)); } catch { /* ignore */ } }

  const ratingTxt = t('#acrPopover .a-icon-alt') || t('[data-hook="rating-out-of-text"]');
  const countTxt = t('#acrCustomerReviewText');
  const breadcrumb = [...document.querySelectorAll('#wayfinding-breadcrumbs_feature_div a')]
    .map((a) => clean(a.textContent)).filter(Boolean);

  return {
    source: 'amazon_dom',
    product_name: title,
    brand_name: (t('#bylineInfo') || '')
      .replace(/^(visit the |brand: )/i, '').replace(/ store$/i, '') || null,
    category: breadcrumb.at(-1) || null,
    description_html: bullets.map((b) => `<li>${b}</li>`).join(''),
    features: bullets,
    price: priceText ? Number(String(priceText).replace(/[^0-9.]/g, '')) || null : null,
    currency: /\$/.test(priceText || '') ? 'AUD' : null,
    images: images.slice(0, 12),
    rating: ratingTxt
      ? {
        value: Number((ratingTxt.match(/([0-5](?:\.\d)?)/) || [])[1]) || null,
        count: Number((countTxt || '').replace(/[^0-9]/g, '')) || 0,
      }
      : null,
  };
}

/** Readability + turndown over already-parsed HTML. The always-works fallback. */
export function readableFromDocument(document, fallbackTitle = null) {
  // Readability mutates the document it is given, so it gets a clone — otherwise
  // it strips the page out from under every extractor that runs after it.
  const article = new Readability(document.cloneNode(true)).parse();
  const body = article?.content || document.body?.innerHTML || '';
  return {
    title: article?.title || clean(document.querySelector('title')?.textContent) || fallbackTitle,
    markdown: turndown.turndown(body).replace(/\n{3,}/g, '\n\n').trim(),
  };
}

/**
 * Reviews from a static document, using textContent rather than innerText.
 *
 * This is the weaker of the two review readers and is honest about it: on a page
 * where the widget renders after JavaScript there is nothing here to find, and
 * the caller reports that rather than pretending the product has no reviews.
 */
export function reviewsFromDocument(document, limit = 50) {
  const read = (nodes) => nodes.map((n) => {
    const text = clean(n.textContent);
    const starEl = n.querySelector('[class*="star"], [class*="rating"], [aria-label*="star" i]');
    const label = starEl?.getAttribute('aria-label') || starEl?.getAttribute('title') || '';
    const rawAuthor = clean(
      n.querySelector('[class*="author"], [class*="name"], [itemprop="author"]')?.textContent);

    // Without layout there is no star graphic to read, so the score has to come out
    // of the words. Yotpo writes it into the byline as "— Michelle (5/5)"; others
    // put "4 out of 5 stars" in an aria-label. Try the label, then the byline.
    const score = (s) => {
      const m = String(s || '').match(/([0-5](?:\.\d)?)\s*(?:\/\s*5|out of\s*5)/i)
        || String(s || '').match(/([0-5](?:\.\d)?)\s*star/i);
      return m ? Number(m[1]) : null;
    };

    const author = rawAuthor
      .replace(/^[\s–—-]+/, '')          // leading en/em dash Yotpo prepends
      .replace(/\(\s*[0-5](?:\.\d)?\s*\/\s*5\s*\)\s*$/, '')
      .trim();

    return {
      text,
      rating: score(label) ?? score(rawAuthor) ?? null,
      author: author || null,
    };
  }).filter((r) => r.text && r.text.length > 25);

  let found = { widget: null, reviews: [] };

  for (const w of REVIEW_WIDGETS) {
    const nodes = [...document.querySelectorAll(w.sel)];
    if (nodes.length < 2) continue;   // one match is usually a template, not a review
    const out = read(nodes);
    if (out.length) { found = { widget: w.name, reviews: out }; break; }
  }

  if (!found.reviews.length) {
    // Structural fallback: find the repeated review CARD without knowing the
    // vendor. Any class containing "review" that appears 3+ times and whose median
    // text is paragraph-length is the container; the class with the LONGEST median
    // is the outermost card rather than an inner fragment.
    const byClass = new Map();
    for (const el of document.querySelectorAll('[class*="review" i]')) {
      const len = clean(el.textContent).length;
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
      const escaped = best.c.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      const out = read([...document.querySelectorAll(`.${escaped}`)]);
      if (out.length) found = { widget: `discovered:${best.c}`, reviews: out };
    }
  }

  return { widget: found.widget, reviews: dedupeReviews(found.reviews, limit) };
}

/**
 * Widgets frequently render the same review in a summary rail and again in the
 * full list, so the same quote arrives twice under two different classes.
 */
export function dedupeReviews(reviews, limit = 50) {
  const seen = new Set();
  const out = [];
  for (const r of reviews) {
    const key = r.text.slice(0, 120).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Merge rather than pick. Shopify's JSON is the better spine (every image, every
 * variant) but omits currency and rating, which JSON-LD carries.
 */
export function mergeStructured(primary, jsonLd) {
  if (!primary && !jsonLd) return null;
  const merged = { ...(jsonLd || {}), ...(primary || {}) };
  merged.source = [primary?.source, jsonLd?.source].filter(Boolean).join('+');
  for (const k of ['currency', 'rating', 'category', 'brand_name']) {
    if (merged[k] == null && jsonLd?.[k] != null) merged[k] = jsonLd[k];
  }
  return merged;
}

/**
 * A store that redirects a dead product URL to its homepage returns HTTP 200, and
 * everything downstream would happily build 20 personas for "the homepage".
 */
export function redirectedToHomepage(requestedUrl, finalUrl) {
  try {
    const landed = new URL(finalUrl);
    return landed.pathname === '/' && new URL(requestedUrl).pathname !== '/';
  } catch {
    return false;
  }
}

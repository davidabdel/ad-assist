// Meta Ad Library scan.
//
// The winning filter is run time, and only run time: currently active AND started
// 90+ days ago. Meta publishes no impressions, spend or reach for commercial ads —
// those fields exist only on political and social-issue ads — so there is nothing
// else in the page to sort on. An ad live a full quarter is live because it pays
// for itself.
//
// What leaves this file is raw. The extraction pass that turns it into format specs
// runs server-side, and IT is what the copywriting prompt sees. Raw ad text must
// never reach a prompt that writes David's headlines.

import { getBrowser, newPage, sleep } from './browser.js';

const BASE = 'https://www.facebook.com/ads/library/';

export const REGIONS = { AU: 'AU', US: 'US', GB: 'GB' };

export function buildSearchUrl({ region, mediaType, term }) {
  const p = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country: region,
    q: term,
    search_type: 'keyword_unordered',
    media_type: mediaType,          // 'image' | 'video'
  });
  return `${BASE}?${p}`;
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "Started running on 12 Jun 2026" / "Started running on Jun 12, 2026" */
export function parseStartDate(text) {
  if (!text) return null;
  const m = text.match(/started running on\s+(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})/i)
    || text.match(/started running on\s+([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (!m) return null;
  const [, a, b, y] = m;
  const monthFirst = Number.isNaN(Number(a));
  const month = MONTHS[(monthFirst ? a : b).toLowerCase().slice(0, 3)];
  const day = Number(monthFirst ? b : a);
  if (month == null || !day) return null;
  return new Date(Date.UTC(Number(y), month, day));
}

export function daysBetween(from, to = new Date()) {
  return Math.floor((to - from) / 86_400_000);
}

/**
 * Meta renders the library as a virtualised list, so ads only exist in the DOM once
 * you have scrolled past them. We harvest as we go rather than at the end, because
 * cards above the viewport get recycled away.
 */
async function harvestWhileScrolling(page, { ceiling, onProgress }) {
  const seen = new Map();
  let idleRounds = 0;

  for (let round = 0; round < 400 && seen.size < ceiling; round++) {
    const batch = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const out = [];
      // Library ID is the only stable per-ad anchor in this markup; Meta's class
      // names are generated and change without notice. Walk up from the leaf
      // that holds it to the card.
      //
      // The boundary is found by COUNTING IDS, not by measuring length. Size
      // used to decide it — climb while under 5000 characters — and that quietly
      // threw away exactly the ads worth having. A long-form advertorial ad, the
      // kind that runs for a year because it works, is around 28,000 characters
      // in one card. The walk hit the limit at the card itself and kept the
      // 122-character header instead: an ad with a run time, an ID, and no copy
      // at all. Only the shortest ads survived, so the sample was biased toward
      // the ads with the least to teach.
      //
      // One card contains exactly one Library ID. The results list contains
      // thirty. So climb while the count is still one, and stop at the last
      // ancestor where that holds — a boundary that does not care how much the
      // advertiser wrote.
      for (const el of document.querySelectorAll('div, span')) {
        const t = el.textContent || '';
        if (!/^\s*Library ID:\s*\d+/.test(t)) continue;
        if (el.children.length > 0) continue;
        const id = (t.match(/Library ID:\s*(\d+)/) || [])[1];
        if (!id) continue;

        let card = el;
        let node = el;
        for (let i = 0; i < 18 && node.parentElement; i++) {
          node = node.parentElement;
          const text = node.innerText || '';
          if ((text.match(/Library ID/g) || []).length !== 1) break;
          // The one case counting alone cannot catch: a search with a single
          // result, where the surrounding page also holds exactly one ID. The
          // results header is the marker that we have climbed out of the card.
          if (/results include ads that match/i.test(text)) break;
          card = node;
        }

        const rawText = card.innerText || '';
        const lines = rawText.split('\n').map(clean).filter(Boolean);
        const text = clean(rawText);

        // Cards follow a fixed running order:
        //   Active / Library ID / Started running on / Platforms / ... /
        //   <advertiser> / Sponsored / <primary text> / <DOMAIN> / <headline> /
        //   <description> / <CTA>
        const spon = lines.findIndex((l) => /^Sponsored$/i.test(l));
        const advertiser = spon > 0 ? lines[spon - 1] : null;
        const domainIdx = lines.findIndex((l, i) =>
          i > spon && spon !== -1 && /^[A-Z0-9][A-Z0-9.-]*\.[A-Z]{2,}$/.test(l));
        const primaryText = spon !== -1
          ? lines.slice(spon + 1, domainIdx === -1 ? spon + 2 : domainIdx).join(' ') || null
          : null;
        const headline = domainIdx !== -1 ? lines[domainIdx + 1] || null : null;
        const description = domainIdx !== -1 ? lines[domainIdx + 2] || null : null;

        const imgs = [...card.querySelectorAll('img')]
          .map((i) => i.src)
          .filter((s) => s && !s.startsWith('data:') && !/static\.xx\.fbcdn/.test(s));
        const vids = [...card.querySelectorAll('video')]
          .map((v) => v.src || v.querySelector('source')?.src).filter(Boolean);
        const links = [...card.querySelectorAll('a[href]')]
          .map((a) => a.href)
          .filter((h) => h && !h.includes('facebook.com/ads/library'));

        out.push({
          meta_ad_id: id,
          text,
          is_active: /\bActive\b/.test(text),
          // Meta does not publish a numeric impression count for commercial ads,
          // but it DOES badge the weakest ones. A long-running ad carrying this
          // flag is an always-on trickle, not a winner — it is the one impression
          // signal available and it is worth excluding on.
          low_impressions: /low impression count/i.test(text),
          started_raw: (text.match(/Started running on [^·|]+?(?=\s*(?:Platforms|Open Drop|See ad|$))/i) || [])[0] || null,
          variant_raw: (text.match(/(\d[\d,]*)\s+ads? use this creative/i) || [])[0] || null,
          cta_label: (text.match(/\b(Shop now|Learn more|Sign up|Buy now|Get offer|Order now|Book now|Download|Subscribe|Contact us|Get quote|Apply now|See menu|Send message)\b/i) || [])[1] || null,
          advertiser,
          primary_text: primaryText,
          headline,
          description,
          display_domain: domainIdx !== -1 ? lines[domainIdx] : null,
          images: imgs.slice(0, 4),
          videos: vids.slice(0, 2),
          landing_url: links.find((h) => !h.includes('facebook.com')) || null,
        });
      }
      return out;
    });

    const before = seen.size;
    for (const ad of batch) {
      if (!seen.has(ad.meta_ad_id) && seen.size < ceiling) seen.set(ad.meta_ad_id, ad);
    }
    if (seen.size === before) idleRounds++; else { idleRounds = 0; onProgress?.(seen.size); }
    if (idleRounds >= 8) break;   // list exhausted, or Meta stopped serving more

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
    await sleep(1100 + Math.random() * 600);
  }
  return [...seen.values()];
}

/**
 * One search: region × mediaType × term.
 * Returns every ad found, each tagged with whether it qualifies. We keep the
 * non-qualifying ones so the count is honest and David can widen the filter later
 * without paying for another scan.
 */
export async function scanAdLibrary({
  region, mediaType, term, ceiling = 300, minDays = 90, onProgress,
} = {}) {
  const browser = await getBrowser();
  const page = await newPage(browser);
  const notes = [];
  try {
    const url = buildSearchUrl({ region, mediaType, term });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(3500);

    // Cookie/consent walls block the list entirely in some regions.
    const consent = await page.$('[data-testid="cookie-policy-manage-dialog"], [aria-label*="Allow all" i]');
    if (consent) {
      await consent.click().catch(() => {});
      await sleep(1500);
      notes.push('dismissed a consent dialog');
    }

    // WAIT for the first card rather than sampling once at a fixed delay.
    //
    // This used to be a single check after 3.5 seconds, and it was wrong in a
    // way that took a while to see: the Ad Library renders its chrome — nav,
    // filters, result count — immediately, and fills in the cards a moment
    // later. The header carries a "Log in" button on every page whether you
    // need one or not. So a slow render read as "Ad Library asked for a login",
    // and the suggested fix was to go and sign a browser profile in, which
    // changes nothing, because the library serves ads to anonymous visitors
    // perfectly well. Measured on this machine: cards land around 3.5s, but not
    // reliably by 3.5s.
    //
    // A login wall is now only reported when the cards never arrive at all.
    const deadline = Date.now() + 25_000;
    let state = null;
    for (;;) {
      state = await page.evaluate(() => {
        const text = document.body.innerText;
        return {
          hasCards: /Library ID/.test(text),
          // Meta says so in as many words when a search genuinely matches
          // nothing. That is a result, not a failure.
          empty: /no ads match your search|0 results/i.test(text),
          login: /log in to continue|you must log in/i.test(text),
          head: text.slice(0, 500),
        };
      });
      if (state.hasCards || state.empty || Date.now() > deadline) break;
      await sleep(1000);
    }

    if (!state.hasCards) {
      if (state.empty) {
        // Returned, not thrown. A phrase that matches nothing in one region is
        // ordinary, and failing the whole job for it would throw away the five
        // other searches that did find something.
        notes.push(`no ads matched "${term}" in ${region}`);
        return {
          url, region, media_type: mediaType, term,
          found: 0, qualified: 0, notes, ads: [],
        };
      }
      throw new Error(state.login
        ? 'The Ad Library demanded a login for this search — this Chrome profile needs a '
          + 'signed-in Facebook session'
        : 'No ad cards appeared within 25 seconds. The library was reachable but served '
          + `nothing readable for "${term}" in ${region}.`);
    }

    const raw = await harvestWhileScrolling(page, { ceiling, onProgress });
    if (raw.length >= ceiling) {
      // Never silent: a capped scan that reads as complete is worse than one that says so.
      notes.push(`hit the ${ceiling}-ad ceiling — more ads exist for "${term}"`);
    }

    const now = new Date();
    const ads = raw.map((a) => {
      const started = parseStartDate(a.started_raw);
      const days = started ? daysBetween(started, now) : null;
      return {
        ...a,
        region,
        media_type: mediaType,
        started_running: started ? started.toISOString().slice(0, 10) : null,
        days_running: days,
        variant_count: a.variant_raw
          ? Number(a.variant_raw.replace(/[^0-9]/g, '')) || null : null,
        // Winning = still running, running a long time, and NOT badged as a
        // low-impression trickle. Run time alone would rank a 3-year always-on
        // ad above a genuinely heavy 120-day performer.
        qualified: Boolean(a.is_active && days != null && days >= minDays
          && !a.low_impressions),
      };
    });

    const lowImp = ads.filter((a) => a.low_impressions && a.is_active
      && a.days_running != null && a.days_running >= minDays).length;
    if (lowImp) notes.push(`${lowImp} long-running ads excluded: badged low impression count`);

    const undated = ads.filter((a) => a.days_running == null).length;
    if (undated) notes.push(`${undated} ads had no readable start date and cannot qualify`);

    return {
      url,
      region,
      media_type: mediaType,
      term,
      found: ads.length,
      qualified: ads.filter((a) => a.qualified).length,
      notes,
      ads,
    };
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
  }
}

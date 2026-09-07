import { parseHTML } from 'linkedom';

/**
 * Reading a brand off its own website — the evidence half.
 *
 * Nothing here decides anything. It gathers candidates with the evidence
 * attached (what the colour is called, how often it appears, whether it appears
 * on a button) and hands them to `brand.ts`, which looks at the logo and picks.
 *
 * THE SPLIT IS NOT TIDINESS, IT IS A BUG I ALREADY HIT. buzzcleaning.com.au is
 * built in GoHighLevel, and GHL ships its builder defaults in the same
 * stylesheet as the customer's chosen theme: `--primary:#37ca37` (a green) and
 * `--secondary:#188bf6` (a blue), neither of which appears anywhere on the
 * rendered page. The brand is `#006780` and `#5ac0d0`, two teals, declared
 * under machine-generated names like `--color-66c5b4f991201e717d357151`.
 *
 * So "most common colour wins" paints the page green, and "trust the variable
 * called primary" paints it green too. The names are worthless and the counts
 * are noisy. What is NOT worthless is the logo, which is why the pick is made
 * by something that can look at it.
 *
 * linkedom rather than jsdom for the same production-only reason as the ingest:
 * Next treats jsdom as an external package, so the serverless function
 * `require()`s it, and jsdom now pulls in an ESM-only encoding sniffer that
 * cannot be required. See the note at the top of ingest/cloud.ts.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const PAGE_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

/**
 * Budgets. A theme lives in the first few stylesheets; the twentieth is a
 * carousel plugin. These exist so a page with forty stylesheets costs the same
 * as a page with three rather than timing out the stage.
 */
const MAX_STYLESHEETS = 5;
const MAX_CSS_BYTES = 600 * 1024;
const MAX_TOTAL_CSS = 2 * 1024 * 1024;

/** Selectors that mean "this rule paints something a buyer clicks". */
const ACTION_SELECTOR = /(^|[\s.#[])(btn|button|cta|buy|checkout|add-to-cart|addtocart|submit|shop-now|primary)/i;
/** Selectors that mean "this rule paints the strip across the top". */
const CHROME_SELECTOR = /(^|[\s.#[])(header|nav|topbar|announcement|banner|masthead)/i;

/**
 * Colours every site has and no site is: the greys, the whites, the blacks.
 *
 * CHROMA ONLY, and the first version of this got it wrong in a way worth
 * recording. It also called anything with a channel above 246 "near-white",
 * which is true of #188bf6 — a fully saturated blue with a 246 in it. That blue
 * was filed under neutrals, where a brand colour can never be chosen from. A
 * colour is near-white when ALL of its channels are high, which chroma already
 * covers: three high channels cannot be far apart.
 */
function isNeutral(hex: string): boolean {
  const { r, g, b } = rgb(hex);
  return Math.max(r, g, b) - Math.min(r, g, b) <= 24;
}

export function rgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  return {
    r: parseInt(full.slice(0, 2), 16) || 0,
    g: parseInt(full.slice(2, 4), 16) || 0,
    b: parseInt(full.slice(4, 6), 16) || 0,
  };
}

/** #abc, #aabbcc and #aabbccdd all normalise to #aabbcc. Alpha is dropped. */
export function normaliseColour(raw: string): string | null {
  const v = raw.trim().toLowerCase();

  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const c = h.slice(0, 3).split('').map((x) => x + x).join('');
      return `#${c}`;
    }
    if (h.length === 6 || h.length === 8) return `#${h.slice(0, 6)}`;
    return null;
  }

  const fn = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (fn) {
    const [r, g, b] = [fn[1], fn[2], fn[3]].map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))));
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }

  return null;
}

const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]{5,60}\)/g;

export type ColourCandidate = {
  hex: string;
  /** How many declarations mention it, weighted by where they are. */
  weight: number;
  /** Raw occurrences, unweighted — a sanity check on the weight. */
  hits: number;
  /** True when it paints something clickable. The strongest single signal. */
  onAction: boolean;
  /** True when it paints the header, nav or announcement bar. */
  onChrome: boolean;
  /** The custom-property names it was declared under, if any. */
  names: string[];
};

export type BrandEvidence = {
  url: string;
  site_name: string | null;
  page_title: string | null;
  /** Strongest first. Neutrals excluded — those are picked separately. */
  colours: ColourCandidate[];
  /** Every near-grey/near-white/near-black, so ink and surface can be chosen. */
  neutrals: ColourCandidate[];
  /** Font stacks seen, with the selector context that mattered. */
  fonts: { family: string; role: 'heading' | 'body' | 'unknown'; hits: number }[];
  /** Families the page itself loads from Google Fonts, in link order. */
  google_fonts: string[];
  /** Logo, favicon and social-image URLs, best guess first. */
  images: { url: string; why: string }[];
  /** Corner radius the site uses on buttons, in CSS units. */
  radius: string | null;
  notes: string[];
};

async function text(url: string, headers: Record<string, string>, ms: number, cap: number) {
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(ms) });
  if (!res.ok) return null;
  const body = await res.text();
  return body.length > cap ? body.slice(0, cap) : body;
}

/**
 * Rules out of a CSS blob, without a real parser.
 *
 * `@media (...) { .btn { color: red } }` matches with the selector reading
 * `@media (...) { .btn` — ugly, and completely fine: every keyword test below
 * asks whether the selector CONTAINS something, so an at-rule prefix changes no
 * answer. A real CSS parser is a dependency and a build-size cost to buy an
 * outcome we already have.
 */
function* rules(css: string): Generator<{ selector: string; body: string }> {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m = re.exec(css);
  while (m) {
    yield { selector: m[1], body: m[2] };
    m = re.exec(css);
  }
}

function harvestCss(css: string, colours: Map<string, ColourCandidate>, radii: Map<string, number>,
  fonts: Map<string, { role: 'heading' | 'body' | 'unknown'; hits: number }>) {
  for (const { selector, body } of rules(css)) {
    const action = ACTION_SELECTOR.test(selector);
    const chrome = CHROME_SELECTOR.test(selector);

    // Declarations one at a time, because a colour's custom-property name is
    // the only bit of human intent in the whole file and it is lost if the
    // block is scanned as one string.
    for (const decl of body.split(';')) {
      const colon = decl.indexOf(':');
      if (colon < 0) continue;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const value = decl.slice(colon + 1);

      if (prop === 'font-family') {
        const family = usefulFamily(value);
        if (family && !family.startsWith('var(')) {
          const role: 'heading' | 'body' | 'unknown' = /\bh[1-6]\b|heading|title|headline/i.test(selector)
            ? 'heading'
            : /\bbody\b|\bhtml\b|content|paragraph/i.test(selector) ? 'body' : 'unknown';
          const prev = fonts.get(family);
          // A stack seen once on an h1 and forty times on nothing in particular
          // is a heading font. A real role beats "unknown" regardless of count.
          fonts.set(family, {
            role: prev && prev.role !== 'unknown' ? prev.role : role,
            hits: (prev?.hits ?? 0) + 1,
          });
        }
        continue;
      }

      // A custom property whose NAME mentions a font is how page builders
      // express "the customer chose this typeface" — GHL writes --headlinefont
      // and --contentfont. Worth more than the same stack appearing in a rule.
      if (prop.startsWith('--') && /font/.test(prop) && !/size|weight|style/.test(prop)) {
        const family = usefulFamily(value);
        if (family && !family.startsWith('var(')) {
          const role = /head|title|display/.test(prop) ? 'heading' as const
            : /content|body|text|paragraph/.test(prop) ? 'body' as const : 'unknown' as const;
          fonts.set(family, { role, hits: (fonts.get(family)?.hits ?? 0) + 5 });
        }
        continue;
      }

      if (prop === 'border-radius' && action) {
        const r = value.trim().split(/\s+/)[0];
        if (/^\d/.test(r)) radii.set(r, (radii.get(r) ?? 0) + 1);
      }

      for (const literal of value.match(COLOUR_LITERAL) ?? []) {
        const hex = normaliseColour(literal);
        if (!hex) continue;
        // A background is identity; a border or a shadow rarely is.
        const strong = /^(background|background-color|color|fill|--)/.test(prop);
        const weight = (action ? 6 : chrome ? 3 : 1) * (strong ? 1 : 0.4);
        const existing = colours.get(hex) ?? {
          hex, weight: 0, hits: 0, onAction: false, onChrome: false, names: [],
        };
        existing.weight += weight;
        existing.hits += 1;
        existing.onAction ||= action;
        existing.onChrome ||= chrome;
        if (prop.startsWith('--') && !existing.names.includes(prop) && existing.names.length < 4) {
          existing.names.push(prop);
        }
        colours.set(hex, existing);
      }
    }
  }
}

/** Families named in a fonts.googleapis.com URL, in the order it lists them. */
function googleFamilies(href: string): string[] {
  try {
    const u = new URL(href);
    if (!/fonts\.googleapis\.com$/.test(u.hostname)) return [];
    const out: string[] = [];
    // css2 repeats `family=`; the older css endpoint pipe-separates one value.
    for (const raw of u.searchParams.getAll('family')) {
      for (const part of raw.split('|')) {
        const name = part.split(':')[0].replace(/\+/g, ' ').trim();
        if (name) out.push(name);
      }
    }
    return out;
  } catch {
    return [];
  }
}

const LOGOISH = /logo|brand|wordmark|masthead/i;

/**
 * Font names that are not typefaces a page is set in.
 *
 * `inherit`, `revert` and friends are CSS keywords that landed in a
 * font-family declaration; `Font Awesome` and its kin are icon fonts, which are
 * on nearly every site and are never its identity. Left in, they crowded out
 * the two families that mattered on the first real page tested.
 */
const NOT_A_TYPEFACE = /^(inherit|revert|unset|initial|none|)$/i;
const ICON_FONT = /font\s*awesome|material icons|glyphicon|fontello|icomoon|dashicons|feather/i;

function usefulFamily(raw: string): string | null {
  const family = raw.replace(/!important/i, '').trim().replace(/^["']|["']$/g, '').trim();
  if (!family || NOT_A_TYPEFACE.test(family) || ICON_FONT.test(family)) return null;
  return family;
}

/**
 * A CDN resize wrapper puts the real asset inside the URL — GoHighLevel serves
 * `images.leadconnectorhq.com/image/f_webp/r_1200/u_https://assets.../abc.png`.
 * The tail is the asset's identity, so three sizes of one logo collapse to one
 * candidate instead of eating three of the four slots.
 */
function assetKey(url: string): string {
  const inner = url.lastIndexOf('https://');
  const tail = inner > 0 ? url.slice(inner) : url;
  return tail.split('?')[0].toLowerCase();
}

/**
 * Everything a brand can be read from, in one fetch of the page plus a handful
 * of its stylesheets. Throws only on a page that cannot be fetched at all —
 * every other failure is a missing candidate, not an error.
 */
export async function collectBrandEvidence(pageUrl: string): Promise<BrandEvidence> {
  const notes: string[] = [];
  const html = await text(pageUrl, PAGE_HEADERS, 20_000, 3 * 1024 * 1024);
  if (!html) throw new Error(`the page could not be fetched for branding (${pageUrl})`);

  const { document } = parseHTML(html);
  const abs = (href: string | null | undefined): string | null => {
    if (!href) return null;
    try { return new URL(href, pageUrl).href; } catch { return null; }
  };

  // ── stylesheets ─────────────────────────────────────────────────────
  const sheetHrefs: string[] = [];
  const google: string[] = [];
  for (const link of document.querySelectorAll('link[rel~="stylesheet"], link[rel="preload"][as="style"]')) {
    const href = abs(link.getAttribute('href'));
    if (!href) continue;
    const families = googleFamilies(href);
    if (families.length) {
      // A Google Fonts URL is a font manifest, not a theme. Read the families
      // out of it and do NOT spend one of the five stylesheet slots on it.
      for (const f of families) if (!google.includes(f)) google.push(f);
      continue;
    }
    if (!sheetHrefs.includes(href) && sheetHrefs.length < MAX_STYLESHEETS) sheetHrefs.push(href);
  }

  const colours = new Map<string, ColourCandidate>();
  const radii = new Map<string, number>();
  const fontMap = new Map<string, { role: 'heading' | 'body' | 'unknown'; hits: number }>();

  // Inline <style> first, and it usually IS the theme: page builders write the
  // customer's chosen colours into the document and ship generic CSS in files.
  let total = 0;
  for (const style of document.querySelectorAll('style')) {
    const css = style.textContent ?? '';
    if (!css || total + css.length > MAX_TOTAL_CSS) continue;
    total += css.length;
    harvestCss(css, colours, radii, fontMap);
  }

  const sheets = await Promise.all(sheetHrefs.map(
    (href) => text(href, { 'User-Agent': UA, Accept: 'text/css,*/*;q=0.1' }, 12_000, MAX_CSS_BYTES)
      .catch(() => null),
  ));
  sheets.forEach((css, i) => {
    if (!css) { notes.push(`stylesheet not readable: ${sheetHrefs[i]}`); return; }
    if (total + css.length > MAX_TOTAL_CSS) return;
    total += css.length;
    harvestCss(css, colours, radii, fontMap);
  });

  if (!colours.size) notes.push('no colours found in this page\'s CSS at all');

  // ── the theme-colour meta, if there is one ──────────────────────────
  const themeColour = normaliseColour(
    document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? '',
  );
  if (themeColour) {
    const existing = colours.get(themeColour) ?? {
      hex: themeColour, weight: 0, hits: 0, onAction: false, onChrome: false, names: [],
    };
    // A brand that declares a theme-colour has told the browser what it is.
    // That is a statement of identity, not a paint instruction, so it outranks
    // any single rule.
    existing.weight += 12;
    existing.names.push('meta[theme-color]');
    colours.set(themeColour, existing);
  }

  const ranked = [...colours.values()].sort((a, b) => b.weight - a.weight);

  // ── logo candidates ─────────────────────────────────────────────────
  const images: { url: string; why: string }[] = [];
  const seenAssets = new Set<string>();
  const addImage = (url: string | null, why: string) => {
    if (!url || images.length >= 6) return;
    const key = assetKey(url);
    if (seenAssets.has(key)) return;
    seenAssets.add(key);
    images.push({ url, why });
  };

  // JSON-LD Organization.logo is the only one of these a site states on purpose.
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed: unknown;
    try { parsed = JSON.parse(script.textContent ?? ''); } catch { continue; }
    const stack: unknown[] = [parsed];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) { stack.push(...node); continue; }
      if (!node || typeof node !== 'object') continue;
      const n = node as Record<string, unknown>;
      if (n['@graph']) stack.push(n['@graph']);
      const logo = typeof n.logo === 'string' ? n.logo
        : (n.logo as { url?: string } | undefined)?.url;
      if (logo) addImage(abs(logo), 'declared as the organisation logo in JSON-LD');
    }
  }

  const pageImages = [...document.querySelectorAll('header img, nav img, .logo img, img')]
    .map((img) => ({
      src: abs(img.getAttribute('src') ?? img.getAttribute('data-src')),
      hint: `${img.getAttribute('alt') ?? ''} ${img.getAttribute('class') ?? ''} `
        + `${img.getAttribute('src') ?? ''}`,
    }))
    .filter((i): i is { src: string; hint: string } => Boolean(i.src));

  for (const img of pageImages) {
    if (!LOGOISH.test(img.hint)) continue;
    addImage(img.src, 'an image the page itself calls a logo');
    if (images.length >= 3) break;
  }

  const icon = abs(document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'))
    ?? abs(document.querySelector('link[rel~="icon"]')?.getAttribute('href'));
  // A FAVICON THAT IS ALSO PRINTED ON THE PAGE IS THE LOGO. It is the one
  // reliable signal on a page-builder site, where every <img> ships with
  // alt="" and a class like `img-none hl-optimized` and the markup says
  // nothing at all. buzzcleaning.com.au is exactly that page: the mark in its
  // header and the icon in the tab are the same asset, and nothing else
  // connects them.
  const iconAlsoOnPage = icon
    && pageImages.some((i) => assetKey(i.src) === assetKey(icon));
  addImage(icon, iconAlsoOnPage
    ? 'the browser-tab icon, and the same image is printed on the page — very likely the logo'
    : 'the browser-tab icon');

  addImage(
    abs(document.querySelector('meta[property="og:image"]')?.getAttribute('content')),
    'the social sharing image',
  );

  // Last resort, and it is a real one: a page builder can leave every image
  // unlabelled, so the first few in document order are offered as "these are
  // what is at the top of the page" and the model is told a photograph is not
  // a logo. Better than a branded page with no mark on it because the markup
  // was unhelpful.
  for (const img of pageImages.slice(0, 8)) {
    if (images.length >= 5) break;
    // Every site has these and no site is one. They sit at the top of a lot of
    // templates, so without this the fallback spends all its slots on Facebook,
    // Instagram and YouTube glyphs.
    if (/facebook|instagram|youtube|twitter|linkedin|tiktok|social|pinterest/i.test(img.hint)) {
      continue;
    }
    addImage(img.src, 'one of the first images on the page, unlabelled by the site');
  }

  if (!images.length) notes.push('no logo or icon could be found on the page');

  const fonts = [...fontMap.entries()]
    .map(([family, v]) => ({ family, ...v }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 12);

  const radius = [...radii.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    url: pageUrl,
    site_name: document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')
      ?? null,
    page_title: document.querySelector('title')?.textContent?.trim() ?? null,
    colours: ranked.filter((c) => !isNeutral(c.hex)).slice(0, 28),
    neutrals: ranked.filter((c) => isNeutral(c.hex)).slice(0, 10),
    fonts,
    google_fonts: google,
    images,
    radius,
    notes,
  };
}

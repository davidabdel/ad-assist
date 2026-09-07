/**
 * The brand kit as the pages wear it.
 *
 * This module is imported by the renderer, so it must stay free of anything
 * server-only: no fetch, no model, no Supabase. Reading a brand off a website
 * lives in `pipeline/brand-sources.ts` and `pipeline/brand.ts`; what a page
 * DOES with the answer lives here.
 *
 * WHY THE PAGES ARE BRANDED AT ALL. A buyer reads the listicle, believes it,
 * clicks buy — and lands in a shop that looks like a different company. The
 * page did the persuading and the checkout undoes it at the one moment that
 * costs money. Continuity of colour, type and logo across that handover is the
 * entire purpose of this file.
 *
 * WHAT IS NOT BRANDED, DELIBERATELY: the structure. Numbered reasons, an
 * article measure, long copy, no product grid. That shape is why a listicle
 * beats a product page in a cold feed, and it survives being repainted.
 */

import type { CSSProperties } from 'react';

export type BrandKit = {
  source_url: string;
  site_name: string | null;
  /** The mark to put at the top of the page. Null renders no logo, not a box. */
  logo_url: string | null;
  /** The browser-tab icon, so even the tab matches. */
  icon_url: string | null;
  /** The colour the brand leads with: top bar, rules, the offer frame. */
  primary: string;
  /** The colour its own buy buttons are. Often the same as primary. */
  accent: string;
  ink: string;
  surface: string;
  /** Ready-to-use CSS font stacks, built from the family the site actually uses. */
  heading_font: string;
  body_font: string;
  /** Families to pull from Google Fonts — only ones the source page loads itself. */
  google_fonts: string[];
  radius: string;
  /** 'low' when the site gave weak evidence and the pick is a guess worth checking. */
  confidence: 'high' | 'low';
  /** Said out loud on the review screen rather than swallowed. */
  notes: string[];
};

function channel(hex: string, at: number): number {
  const v = parseInt(hex.slice(at, at + 2), 16) / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  return 0.2126 * channel(h, 0) + 0.7152 * channel(h, 2) + 0.0722 * channel(h, 4);
}

/**
 * Text that can actually be read on a given background.
 *
 * COMPUTED, NEVER ASKED FOR. A model asked "what colour text goes on this
 * button" answers white about nine times in ten, and the tenth is a yellow
 * brand with white type on it that nobody can read. This is arithmetic, so it
 * is done in arithmetic.
 */
export function readableOn(background: string): string {
  const l = luminance(background);
  const onWhite = (1.05) / (l + 0.05);
  const onBlack = (l + 0.05) / 0.05;
  return onWhite >= onBlack ? '#ffffff' : '#111111';
}

/** The brand colour mixed toward white — a tint for panels and rules. */
export function tint(hex: string, amount: number): string {
  const h = hex.replace('#', '');
  const mix = (at: number) => {
    const v = parseInt(h.slice(at, at + 2), 16);
    return Math.round(v + (255 - v) * amount).toString(16).padStart(2, '0');
  };
  return `#${mix(0)}${mix(2)}${mix(4)}`;
}

/**
 * The neutral kit. Exactly what the pages look like today, expressed as a
 * brand, so the renderer has one code path instead of two.
 *
 * A campaign whose site gave up nothing readable uses this. That is a working
 * outcome, not a failure: a plain page reads fine, a half-branded one reads
 * broken.
 */
export const NEUTRAL_BRAND: BrandKit = {
  source_url: '',
  site_name: null,
  logo_url: null,
  icon_url: null,
  primary: '#171717',
  accent: '#171717',
  ink: '#171717',
  surface: '#ffffff',
  heading_font: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  body_font: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  google_fonts: [],
  radius: '0.5rem',
  confidence: 'high',
  notes: [],
};

/**
 * Every CSS variable the listicle reads, derived from the kit.
 *
 * Typed as CSSProperties because that is where it is spread. React passes
 * custom properties straight through; TypeScript's own CSSProperties has no
 * index signature for them, which is what the assertion at the end is for.
 */
export function brandVars(brand: BrandKit): CSSProperties {
  return {
    '--brand-primary': brand.primary,
    '--brand-on-primary': readableOn(brand.primary),
    '--brand-accent': brand.accent,
    '--brand-on-accent': readableOn(brand.accent),
    '--brand-accent-hover': tint(brand.accent, 0.18),
    '--brand-tint': tint(brand.primary, 0.92),
    '--brand-rule': tint(brand.primary, 0.75),
    '--brand-ink': brand.ink,
    '--brand-muted': tint(brand.ink, 0.42),
    '--brand-surface': brand.surface,
    '--brand-heading-font': brand.heading_font,
    '--brand-body-font': brand.body_font,
    '--brand-radius': brand.radius,
  } as CSSProperties;
}

/**
 * The stylesheet URL for the families this brand needs, or null.
 *
 * Only families the source page itself loads from Google Fonts get here, so
 * this never invents a typeface — a self-hosted foundry font falls back to its
 * generic and the page stays readable rather than shipping a broken @font-face.
 */
export function googleFontsHref(brand: BrandKit): string | null {
  if (!brand.google_fonts.length) return null;
  const families = brand.google_fonts
    .slice(0, 3)
    .map((f) => `family=${encodeURIComponent(f.trim()).replace(/%20/g, '+')}:wght@400;500;600;700`)
    .join('&');
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

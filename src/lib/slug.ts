/**
 * Slugs end up in public URLs (/p/[campaign]/[persona]), so they have to be
 * stable, lowercase and free of anything that needs escaping.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')  // strip accents left by NFKD
    .toLowerCase()
    .replace(/['’]/g, '')                  // don't turn "David's" into "david-s"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
    || 'untitled';
}

/**
 * personas.slug is unique per campaign, so two personas that both slugify to
 * "gift-buyer" need separating. Suffix rather than reject: the LLM picked the
 * name, and a numeric tail is a smaller lie than renaming the persona.
 */
export function uniqueSlug(desired: string, taken: Iterable<string>): string {
  const base = slugify(desired);
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`could not find a free slug for "${desired}"`);
}

/** Normalised form used only for duplicate detection, never stored or shown. */
export function normalisePainPoint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .sort()
    .join(' ');
}

const STOPWORDS = new Set([
  'that', 'this', 'they', 'them', 'their', 'with', 'from', 'have', 'been',
  'about', 'into', 'over', 'than', 'then', 'what', 'when', 'which', 'while',
  'would', 'could', 'should', 'because', 'these', 'those', 'there', 'where',
]);

/**
 * Shape, validation and browser-side persistence for the new-campaign wizard.
 *
 * Kept out of the component so the rules that decide whether a step may be
 * completed sit next to the rules the API enforces, and drift is visible. The
 * limits here mirror `CreateSchema` in `app/api/campaigns/route.ts` — where they
 * disagree, the API wins and the operator gets a server error instead of a
 * helpful sentence, which is the failure this file exists to prevent.
 */

export type Region = 'AU' | 'US' | 'GB' | 'ALL';

export type Draft = {
  title: string;
  /** Which of the two product inputs the operator chose. Only one is sent. */
  mode: 'url' | 'text';
  source_url: string;
  raw_input_text: string;
  checkout_url: string;
  current_offer: string;
  region: Region;
  /** Videos per buyer, 1 or 2. Pictures are whatever is left of the three. */
  videos: 1 | 2;
};

export const EMPTY_DRAFT: Draft = {
  title: '',
  mode: 'url',
  source_url: '',
  raw_input_text: '',
  checkout_url: '',
  current_offer: '',
  region: 'AU',
  videos: 1,
};

export const MIN_TEXT = 40;

export const REGIONS: { value: Region; label: string }[] = [
  { value: 'AU', label: 'Australia' },
  { value: 'US', label: 'United States' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'ALL', label: 'All three' },
];

/**
 * People paste "allbirds.com.au/products/x" far more often than they type the
 * scheme. Adding https:// is the difference between the wizard working and the
 * wizard rejecting a perfectly good address.
 */
export function normaliseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!/^https?:$/.test(url.protocol)) return null;
    // A hostname with no dot is a local name, not a storefront the worker can reach.
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** A first guess at a campaign name from a product URL, always overridable. */
export function titleFromUrl(raw: string): string {
  const url = normaliseUrl(raw);
  if (!url) return '';
  try {
    const { pathname, hostname } = new URL(url);
    const last = pathname.split('/').filter(Boolean).pop();
    const source = last && last.length > 2 ? last : hostname.replace(/^www\./, '');
    return source
      .replace(/\.[a-z]{2,5}$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .slice(0, 60);
  } catch {
    return '';
  }
}

export type StepErrors = Partial<Record<keyof Draft, string>>;

/** Errors for one step only, so a later empty field never blocks an earlier one. */
export function validateStep(step: number, draft: Draft): StepErrors {
  const errors: StepErrors = {};

  if (step === 1) {
    if (draft.mode === 'url') {
      if (!draft.source_url.trim()) {
        errors.source_url = 'Paste the web address of the product you want to advertise.';
      } else if (!normaliseUrl(draft.source_url)) {
        errors.source_url = 'That does not look like a web address. It should look like '
          + 'https://yourshop.com/products/your-product';
      }
    } else {
      const length = draft.raw_input_text.trim().length;
      if (!length) {
        errors.raw_input_text = 'Describe the product, or switch back to using a link.';
      } else if (length < MIN_TEXT) {
        errors.raw_input_text = `A bit more, please — ${length} of ${MIN_TEXT} characters so far. `
          + 'What it is, who it is for, and what it costs.';
      }
    }
    if (draft.title.trim().length < 2) {
      errors.title = 'Give this campaign a name so you can find it later.';
    }
  }

  if (step === 2 && draft.checkout_url.trim() && !normaliseUrl(draft.checkout_url)) {
    errors.checkout_url = 'That does not look like a web address. Leave it empty if you are '
      + 'not sure — you can add it later.';
  }

  return errors;
}

/** Exactly what POST /api/campaigns wants, and nothing it does not. */
export function toCreateBody(draft: Draft) {
  const body: Record<string, unknown> = {
    title: draft.title.trim(),
    region: draft.region,
    media_split: { static: 3 - draft.videos, video: draft.videos },
  };
  if (draft.mode === 'url') {
    body.source_url = normaliseUrl(draft.source_url);
  } else {
    body.raw_input_text = draft.raw_input_text.trim();
  }
  const checkout = normaliseUrl(draft.checkout_url);
  if (checkout) body.checkout_url = checkout;
  if (draft.current_offer.trim()) body.current_offer = draft.current_offer.trim();
  return body;
}

const KEY = 'ad-assist:new-campaign-draft';

/**
 * Half-typed answers survive a refresh. Cheap to do and it removes the one
 * mistake this screen can make that actually costs the operator something.
 */
export function loadDraft(): Draft {
  if (typeof window === 'undefined') return EMPTY_DRAFT;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY_DRAFT;
    return { ...EMPTY_DRAFT, ...(JSON.parse(raw) as Partial<Draft>) };
  } catch {
    return EMPTY_DRAFT;
  }
}

export function saveDraft(draft: Draft): void {
  try { window.localStorage.setItem(KEY, JSON.stringify(draft)); } catch { /* private mode */ }
}

export function clearDraft(): void {
  try { window.localStorage.removeItem(KEY); } catch { /* private mode */ }
}

/**
 * Shape, validation and browser-side persistence for the new-campaign wizard.
 *
 * Kept out of the component so the rules that decide whether a step may be
 * completed sit next to the rules the API enforces, and drift is visible. The
 * limits here mirror `CreateSchema` in `app/api/campaigns/route.ts` — where they
 * disagree, the API wins and the operator gets a server error instead of a
 * helpful sentence, which is the failure this file exists to prevent.
 *
 * What is being sold is the FIRST question, because it changes the questions
 * after it: which input tabs exist, whether photographs are optional, and
 * whether the page ends in a checkout link or a phone number. Those rules live
 * in `lib/product-type.ts` and are read from here rather than repeated.
 */

import { spec, type InputMode, type ProductType } from './product-type';

export type Region = 'AU' | 'US' | 'GB' | 'ALL';

/** An uploaded file, after it has been put in storage. */
export type Upload = { url: string; name: string };

export type Draft = {
  product_type: ProductType;
  title: string;
  /** Which of the type's input modes the operator chose. Only one is sent. */
  mode: InputMode;
  source_url: string;
  raw_input_text: string;
  /** The ebook PDF, once uploaded. */
  source_file: Upload | null;
  /** The operator's own photographs, once uploaded. */
  images: Upload[];
  checkout_url: string;
  contact_phone: string;
  contact_name: string;
  current_offer: string;
  region: Region;
  /** Videos per buyer, 1 or 2. Pictures are whatever is left of the three. */
  videos: 1 | 2;
};

export const EMPTY_DRAFT: Draft = {
  product_type: 'ecom',
  title: '',
  mode: 'url',
  source_url: '',
  raw_input_text: '',
  source_file: null,
  images: [],
  checkout_url: '',
  contact_phone: '',
  contact_name: '',
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
 * Switching what is being sold has to reset the mode, because the tabs are not
 * the same set: an ebook has no "type it out" and a vehicle has no PDF. Leaving
 * a stale mode selected is how the wizard ends up validating a field that is not
 * on the screen.
 */
export function withProductType(draft: Draft, type: ProductType): Draft {
  const modes = spec(type).modes;
  return {
    ...draft,
    product_type: type,
    mode: modes.includes(draft.mode) ? draft.mode : modes[0],
  };
}

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

/**
 * Australian mobiles and landlines, with or without +61, spaces or brackets.
 * Deliberately loose: this is a tel: link, not a billing record, and rejecting a
 * number a buyer could have dialled is worse than accepting an odd one.
 */
export function normalisePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.replace(/\D/g, '').length < 8) return null;
  return trimmed;
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

/** A first guess at a campaign name from an uploaded file name. */
export function titleFromFileName(name: string): string {
  return name
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

export type StepErrors = Partial<Record<keyof Draft, string>>;

/** Errors for one step only, so a later empty field never blocks an earlier one. */
export function validateStep(step: number, draft: Draft): StepErrors {
  const errors: StepErrors = {};
  const kind = spec(draft.product_type);

  // Step 1 is the picker and cannot be wrong — one of three is always chosen.

  if (step === 2) {
    if (draft.mode === 'url') {
      if (!draft.source_url.trim()) {
        errors.source_url = draft.product_type === 'vehicle'
          ? 'Paste the address of the listing — the page a buyer would land on.'
          : 'Paste the web address of the product you want to advertise.';
      } else if (!normaliseUrl(draft.source_url)) {
        errors.source_url = 'That does not look like a web address. It should look like '
          + 'https://yourshop.com/products/your-product';
      }
    } else if (draft.mode === 'pdf') {
      if (!draft.source_file) {
        errors.source_file = 'Upload the PDF, or switch to using its sales page instead.';
      }
    } else {
      const length = draft.raw_input_text.trim().length;
      if (!length) {
        errors.raw_input_text = 'Describe it, or switch back to using a link.';
      } else if (length < MIN_TEXT) {
        errors.raw_input_text = `A bit more, please — ${length} of ${MIN_TEXT} characters so far. `
          + 'What it is, who it is for, and what it costs.';
      }
    }

    // A typed vehicle has no source of pictures at all — no storefront gallery,
    // no listing page. Without a photo the five pages are five walls of text
    // about a car nobody can see, so this is a real block rather than a nudge.
    if (kind.needsUploadedImages && draft.mode === 'text' && !draft.images.length) {
      errors.images = 'Add at least one photo. Nothing else on this campaign can supply one, '
        + 'and pages about a vehicle you cannot see do not sell it.';
    }

    if (draft.title.trim().length < 2) {
      errors.title = 'Give this campaign a name so you can find it later.';
    }
  }

  if (step === 3) {
    if (kind.ctaKind === 'contact') {
      if (!draft.contact_phone.trim()) {
        errors.contact_phone = 'Buyers ring about a vehicle. Put the number they should ring.';
      } else if (!normalisePhone(draft.contact_phone)) {
        errors.contact_phone = 'That does not look like a phone number.';
      }
    } else if (draft.checkout_url.trim() && !normaliseUrl(draft.checkout_url)) {
      errors.checkout_url = 'That does not look like a web address. Leave it empty if you are '
        + 'not sure — you can add it later.';
    }
  }

  return errors;
}

/** Exactly what POST /api/campaigns wants, and nothing it does not. */
export function toCreateBody(draft: Draft) {
  const kind = spec(draft.product_type);
  const body: Record<string, unknown> = {
    product_type: draft.product_type,
    title: draft.title.trim(),
    region: draft.region,
    media_split: { static: 3 - draft.videos, video: draft.videos },
  };

  if (draft.mode === 'url') body.source_url = normaliseUrl(draft.source_url);
  else if (draft.mode === 'pdf') body.source_file_url = draft.source_file?.url;
  else body.raw_input_text = draft.raw_input_text.trim();

  if (draft.images.length) body.uploaded_image_urls = draft.images.map((i) => i.url);

  if (kind.ctaKind === 'contact') {
    body.contact_phone = draft.contact_phone.trim();
    if (draft.contact_name.trim()) body.contact_name = draft.contact_name.trim();
  } else {
    const checkout = normaliseUrl(draft.checkout_url);
    if (checkout) body.checkout_url = checkout;
  }

  if (draft.current_offer.trim()) body.current_offer = draft.current_offer.trim();
  return body;
}

const KEY = 'ad-assist:new-campaign-draft';

/**
 * Half-typed answers survive a refresh. Cheap to do and it removes the one
 * mistake this screen can make that actually costs the operator something —
 * which now includes a file they already waited to upload.
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

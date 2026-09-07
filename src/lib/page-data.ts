import { publicClient } from './supabase';
import type { BrandKit } from './brand';
import type { ProductType } from './product-type';

export type Reason = {
  number: number;
  title: string;
  body: string;
  /**
   * What the copywriter said a picture here should show. Written at base-page
   * time, before anything has looked at the photos, and it is what the review
   * screen and the preview render in the empty slot.
   */
  image_prompt?: string | null;
  /** Filled by the image stage, after approval. Null means the slot stays empty. */
  image_url?: string | null;
  image_alt?: string | null;
};

export type Testimonial = {
  quote: string;
  reviewer?: string | null;
  rating?: number | null;
};

export type PublicPage = {
  campaign_id: string;
  persona_id: string | null;
  page_title: string;
  meta_description: string | null;
  topbar: string | null;
  headline: string;
  subheadline: string | null;
  hero_image_url: string | null;
  hero_image_alt: string | null;
  reasons: Reason[];
  testimonials: Testimonial[];
  offer_headline: string;
  offer_body: string | null;
  cta_button_text: string;
  cta_url: string;
  /**
   * How this sale closes, which is a property of what is being sold rather than
   * of the buyer reading it. `vehicle` swaps the checkout link for a phone
   * number and an enquiry form; see lib/product-type.ts.
   */
  product_type: ProductType;
  /** The number to ring. Only ever set on the kinds of sale that close on a call. */
  contact_phone: string | null;
  /**
   * The seller's own colours, type and logo. Belongs to the campaign, not to a
   * persona: all twenty pages wear the same identity, because the identity is
   * what has to survive the click through to their checkout. Null on a campaign
   * built before the brand stage existed, or one whose site gave up nothing —
   * the renderer falls back to the neutral editorial theme.
   */
  brand: BrandKit | null;
};

/**
 * The 80/20 merge lives in Postgres (get_public_page), not here. Two reasons:
 * the renderer can never drift from it, and anon never needs read access to
 * campaigns, personas or base_pages to display a page.
 */
export async function getPublicPage(
  campaignSlug: string,
  personaSlug?: string,
): Promise<PublicPage | null> {
  const { data, error } = await publicClient().rpc('get_public_page', {
    campaign_slug: campaignSlug,
    persona_slug: personaSlug ?? null,
  });
  if (error) throw new Error(`get_public_page failed: ${error.message}`);
  return (data as PublicPage) ?? null;
}

export async function listPublicPaths(): Promise<
  { campaignSlug: string; personaSlug: string }[]
> {
  // Build-time only. Missing config during a preview build should not fail the
  // build — the pages simply render on demand instead.
  try {
    const { data, error } = await publicClient().rpc('list_public_paths');
    if (error || !data) return [];
    return data as { campaignSlug: string; personaSlug: string }[];
  } catch {
    return [];
  }
}

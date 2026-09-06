import { publicClient } from './supabase';

export type Reason = {
  number: number;
  title: string;
  body: string;
  image_prompt?: string | null;
  image_url?: string | null;
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
  reasons: Reason[];
  testimonials: Testimonial[];
  offer_headline: string;
  offer_body: string | null;
  cta_button_text: string;
  cta_url: string;
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

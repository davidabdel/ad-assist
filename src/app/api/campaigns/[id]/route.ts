import { AuthError, requireCampaignOwner, requireOwner } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * Everything a progress screen needs in one call: where the campaign is, what
 * the worker is doing, and the live URLs as they appear. Deliberately does NOT
 * return scraped_data — it is up to a few hundred KB of page markdown.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const owner = await requireOwner(req);
    const campaign = await requireCampaignOwner(owner, id);
    const db = serviceClient();

    const [
      { data: personas }, { data: base }, { data: jobs }, { data: images }, { data: leads },
    ] = await Promise.all([
      db.from('personas')
        .select('id, persona_index, slug, persona_name, angle_hook, primary_pain_point, views_count, clicks_count')
        .eq('campaign_id', id).order('persona_index'),
      // The whole page, not a summary: the approval checkpoint is the operator
      // reading what will be copied onto twenty pages, and it has to be readable
      // without leaving the dashboard.
      db.from('base_pages')
        .select('hero_headline, hero_subheadline, hero_image_url, hero_image_alt, reasons, '
          + 'testimonials, offer_headline, offer_body, cta_button_text, cta_url')
        .eq('campaign_id', id).maybeSingle(),
      db.from('scanner_jobs')
        .select('kind, status, attempts, notes, error_message, created_at, completed_at')
        .eq('campaign_id', id).order('created_at', { ascending: false }),
      db.from('campaign_images')
        .select('position, source_url, caption, kind, usable')
        .eq('campaign_id', id).order('position'),
      // Enquiries from the public pages. Only ever non-empty on a campaign whose
      // CTA is a phone number and a form, but selected unconditionally: a
      // conditional read here is one more thing that can be wrong about what
      // kind of campaign this is.
      db.from('leads')
        .select('id, persona_id, name, phone, email, message, created_at')
        .eq('campaign_id', id).order('created_at', { ascending: false }).limit(200),
    ]);

    // Named rather than joined, so the screen can say WHICH page produced an
    // enquiry — the entire reason for building several of them.
    const personaName = new Map((personas ?? []).map((p) => [p.id as string, p.persona_name as string]));

    const site = process.env.NEXT_PUBLIC_SITE_URL ?? '';
    return Response.json({
      campaign: {
        id: campaign.id,
        title: campaign.title,
        slug: campaign.slug,
        status: campaign.status,
        region: campaign.region,
        source_url: campaign.source_url,
        product_type: campaign.product_type,
        persona_target: campaign.persona_target,
        contact_phone: campaign.contact_phone,
        error_message: campaign.error_message,
        has_brief: Boolean(campaign.scraped_data?.brief),
        base_page_guidance: campaign.base_page_guidance,
      },
      brief: campaign.scraped_data?.brief ?? null,
      base_page: base ?? null,
      // Empty until the picture stage runs, which is after approval. The review
      // screen falls back to the brief's raw `image_urls` so it can still show
      // WHAT was found before anything has been chosen.
      images: images ?? [],
      personas: (personas ?? []).map((p) => ({
        ...p,
        url: `${site}/p/${campaign.slug}/${p.slug}`,
      })),
      jobs: jobs ?? [],
      leads: (leads ?? []).map((l) => ({
        ...l,
        persona_name: l.persona_id ? personaName.get(l.persona_id) ?? null : null,
      })),
    });
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

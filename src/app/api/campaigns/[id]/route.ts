import { AuthError, requireCampaignOwner, requireOwner } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

type ScanJobRow = {
  kind: string;
  status: string;
  items_found: number | null;
  items_qualified: number | null;
  search_terms: string[] | null;
};

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
      { data: formats }, { data: ads }, { data: ideas }, { data: spend }, { data: settings },
    ] = await Promise.all([
      // Superseded pages are returned too, flagged rather than filtered. They
      // are still live on the web and still the destination of ads that have
      // been paid for, so a screen that hid them would be hiding traffic the
      // operator is responsible for. The dashboard groups them separately.
      db.from('personas')
        // One literal string, not a concatenation: the driver infers the row
        // type by parsing this at compile time and a joined expression resolves
        // to its error placeholder instead.
        .select('id, persona_index, slug, persona_name, angle_hook, primary_pain_point, views_count, clicks_count, superseded_at')
        .eq('campaign_id', id).order('persona_index'),
      // The whole page, not a summary: the approval checkpoint is the operator
      // reading what will be copied onto twenty pages, and it has to be readable
      // without leaving the dashboard.
      db.from('base_pages')
        .select('hero_headline, hero_subheadline, hero_image_url, hero_image_alt, reasons, '
          + 'testimonials, offer_headline, offer_body, cta_button_text, cta_url')
        .eq('campaign_id', id).maybeSingle(),
      db.from('scanner_jobs')
        .select('kind, status, attempts, notes, error_message, created_at, completed_at, '
          + 'region, media_type, search_terms, items_found, items_qualified')
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
      // The output of the scan, and the only part of it the copywriting stage
      // will ever be allowed to read.
      db.from('format_specs')
        .select('id, media_type, format_name, description, hook_pattern, visual_recipe, '
          + 'offer_placement, observed_count, median_days_running, example_ad_ids')
        .eq('campaign_id', id).order('observed_count', { ascending: false }),
      // The ads themselves, for browsing only — David asked to be able to see
      // what the formats were drawn from. Qualifying ones first and capped:
      // a scan can hold well over a thousand rows and this response is polled.
      db.from('scanned_ads')
        .select('id, meta_ad_id, advertiser_name, region, media_type, days_running, '
          + 'qualified, variant_count, primary_text, headline, cta_label, landing_url')
        .eq('campaign_id', id).eq('qualified', true)
        .order('days_running', { ascending: false, nullsFirst: false }).limit(120),
      // The ideas table, with whatever has been generated from each row hanging
      // off it. Embedded rather than fetched per row: sixty ideas would be sixty
      // requests on a screen that polls.
      db.from('ad_ideas')
        // `attempt`, `prompt_used` and the rejection fields are what let a row
        // show the ad it made LAST time next to the instruction that is about
        // to make the next one. Without them a redo looks like the first file
        // simply vanished.
        .select('*, generated_assets(id, state, result_url, stored_url, credits_charged, '
          + 'fail_reason, kie_task_id, created_at, completed_at, attempt, prompt_used, '
          + 'rejected_at, rejected_note)')
        .eq('campaign_id', id).order('persona_id').order('idea_index'),
      // The ledger, whole. It is short — one row per generation — and showing
      // the lines rather than only a total is what makes a ceiling believable.
      db.from('spend_log')
        .select('id, asset_id, credits, usd, note, created_at')
        .eq('campaign_id', id).order('created_at', { ascending: false }),
      db.from('settings')
        .select('campaign_spend_ceiling').eq('user_id', owner.id).maybeSingle(),
    ]);

    // Named rather than joined, so the screen can say WHICH page produced an
    // enquiry — the entire reason for building several of them.
    const personaName = new Map((personas ?? []).map((p) => [p.id as string, p.persona_name as string]));
    const personaIndex = new Map((personas ?? []).map((p) => [p.id as string, p.persona_index as number]));

    const site = process.env.NEXT_PUBLIC_SITE_URL ?? '';
    return Response.json({
      campaign: {
        id: campaign.id,
        title: campaign.title,
        slug: campaign.slug,
        status: campaign.status,
        // When the row itself last changed, kept by a trigger. This is the only
        // honest answer to "how long has this been sitting still" after a
        // reload — the browser's own record of what it has watched change
        // starts at nought every time the page opens, which would have
        // described an eight-minute stall as a one-second one.
        updated_at: campaign.updated_at,
        region: campaign.region,
        source_url: campaign.source_url,
        product_type: campaign.product_type,
        persona_target: campaign.persona_target,
        contact_phone: campaign.contact_phone,
        error_message: campaign.error_message,
        has_brief: Boolean(campaign.scraped_data?.brief),
        base_page_guidance: campaign.base_page_guidance,
        // The note left on each step, so a step that has been sent back before
        // opens showing what was said rather than an empty box. A correction
        // the operator cannot see is one they write again.
        step_guidance: campaign.step_guidance ?? {},
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
      formats: formats ?? [],
      // Named, so the table can group by buyer without a second request and
      // without the browser having to join two lists by id.
      // Sorted by BUYER ORDER, not by persona id. The database sort is on a
      // uuid, which puts the twenty buyers in an order that matches nothing on
      // the rest of the screen — the pages list is in persona_index order and
      // the tables have to agree.
      ideas: ((ideas ?? []) as unknown as { persona_id: string; idea_index: number }[])
        .map((i) => ({
          ...i,
          persona_name: personaName.get(i.persona_id as string) ?? null,
          persona_index: personaIndex.get(i.persona_id as string) ?? 0,
        }))
        .sort((a, b) => a.persona_index - b.persona_index || a.idea_index - b.idea_index),
      spend: (() => {
        const rows = (spend ?? []) as unknown as { usd: number | string }[];
        const total = rows.reduce((n, r) => n + Number(r.usd ?? 0), 0);
        // 150 is the schema's own default, used when this owner has no settings
        // row — the same fallback `record_spend` applies in SQL, so the number
        // on screen is the number that will actually be enforced.
        const ceiling = Number(
          (settings as { campaign_spend_ceiling?: number | string } | null)
            ?.campaign_spend_ceiling ?? 150,
        );
        return {
          total: Math.round(total * 100) / 100,
          ceiling,
          remaining: Math.round(Math.max(0, ceiling - total) * 100) / 100,
          lines: spend ?? [],
        };
      })(),
      // Capped above, so the count has to come from the jobs rather than from
      // `ads.length` — a list that stops at 120 must not be reported as the
      // whole scan.
      ads: ads ?? [],
      scan: (() => {
        // Through `unknown`: this client carries no generated schema, so a
        // select string resolves to the driver's error placeholder rather than
        // to a row type. Asserted here rather than pretended to be checked.
        const scanJobs = ((jobs ?? []) as unknown as ScanJobRow[])
          .filter((j) => j.kind === 'ad_scan');
        return {
          jobsTotal: scanJobs.length,
          jobsDone: scanJobs.filter((j) => j.status === 'completed').length,
          jobsFailed: scanJobs.filter((j) => j.status === 'failed').length,
          adsFound: scanJobs.reduce((n, j) => n + (j.items_found ?? 0), 0),
          adsQualified: scanJobs.reduce((n, j) => n + (j.items_qualified ?? 0), 0),
          // Deduplicated: the same phrase is searched in several regions, and a
          // list repeating "shop now" three times reads as a mistake.
          terms: [...new Set(scanJobs.flatMap((j) => (j.search_terms ?? []) as string[]))],
        };
      })(),
    });
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

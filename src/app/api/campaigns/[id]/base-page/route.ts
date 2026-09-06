import { AuthError, requireCampaignOwner, requireOwner } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * The approval checkpoint.
 *
 * Reasons 4-10 of the base page are copied unchanged onto all twenty persona
 * pages, so the base page is the one artefact where a mistake multiplies by
 * twenty and the only place it is cheap to catch. The pipeline stops at
 * `base_review` and nothing moves until this route is called.
 *
 *   POST { action: 'approve' }                    → write the twenty
 *   POST { action: 'rewrite', guidance?: string } → throw it away, write another
 *
 * Rewrite exists because approve-only is not a gate, it is a speed bump: an
 * operator who reads a wrong page and cannot reject it has nowhere to go.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const owner = await requireOwner(req);
    const campaign = await requireCampaignOwner(owner, id);

    const body = await req.json().catch(() => ({}));
    const action = (body as { action?: unknown }).action;
    const guidance = typeof (body as { guidance?: unknown }).guidance === 'string'
      ? ((body as { guidance: string }).guidance).trim().slice(0, 2000)
      : '';

    if (action !== 'approve' && action !== 'rewrite') {
      return Response.json({ error: 'action must be "approve" or "rewrite"' }, { status: 400 });
    }
    if (campaign.status !== 'base_review') {
      return Response.json(
        { error: `The main page is not waiting for approval — this campaign is "${campaign.status}".` },
        { status: 409 },
      );
    }

    const db = serviceClient();
    const { data: base } = await db.from('base_pages')
      .select('id').eq('campaign_id', id).maybeSingle();
    if (!base) {
      return Response.json({ error: 'There is no main page to approve yet.' }, { status: 409 });
    }

    if (action === 'approve') {
      const { error } = await db.from('campaigns').update({
        // Pictures next, then the twenty. Nothing was illustrated before this
        // point on purpose: the slots on the page above are what was approved,
        // and paying to fill them on a page that gets sent back is waste.
        status: 'images',
        error_message: null,
        // Approving clears the last rejection: it was answered, and leaving it
        // would steer a rewrite that happens three campaigns from now.
        base_page_guidance: null,
      }).eq('id', id);
      if (error) return Response.json({ error: error.message }, { status: 500 });

      return Response.json({
        status: 'images',
        did: 'Main page approved. Choosing photos for it, then writing the twenty pages.',
      });
    }

    // Delete rather than mark superseded: `advance()` treats "no base page" as
    // the instruction to write one, and one row per campaign is what the merge
    // in get_public_page assumes.
    const { error: deleteError } = await db.from('base_pages').delete().eq('campaign_id', id);
    if (deleteError) return Response.json({ error: deleteError.message }, { status: 500 });

    const { error } = await db.from('campaigns').update({
      base_page_guidance: guidance || null,
      error_message: null,
    }).eq('id', id);
    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({
      status: 'base_review',
      did: guidance
        ? `Writing the main page again, with your note: "${guidance}"`
        : 'Writing the main page again.',
    });
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

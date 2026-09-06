import { AuthError, requireCampaignOwner, requireOwner } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * Puts a failed campaign back on the path so `advance()` can carry on.
 *
 * Worth having because the most common failure is not a bug: the scrape runs in
 * Chrome on the Mac, and a Mac that was asleep fails the job. Without a retry the
 * only cure is a new campaign, which throws away everything that did succeed.
 *
 * It rewinds to the last stage whose OUTPUT is missing, never further. A brief
 * that exists is not rebuilt and personas that exist are not rewritten, so a
 * retry cannot cost model time that was already paid for. `advance()` at
 * `pending` ignores a failed ingest job and queues a fresh one, so nothing needs
 * deleting here.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const owner = await requireOwner(req);
    const campaign = await requireCampaignOwner(owner, id);

    if (campaign.status !== 'failed') {
      return Response.json(
        { error: `This campaign is not failed — it is "${campaign.status}". Nothing to retry.` },
        { status: 409 },
      );
    }

    const db = serviceClient();
    const [{ count }, { data: base }] = await Promise.all([
      db.from('personas').select('id', { count: 'exact', head: true }).eq('campaign_id', id),
      db.from('base_pages').select('id').eq('campaign_id', id).maybeSingle(),
    ]);
    const personaCount = count ?? 0;
    const hasBrief = Boolean(campaign.scraped_data?.brief);

    // A persona means the base page was approved, so the gate is behind us. A
    // base page with no personas is ambiguous — it may never have been approved —
    // so it rewinds to the checkpoint and asks again. Re-approving costs a click;
    // skipping a gate that was never passed costs twenty pages.
    const status = personaCount > 0 ? 'personas'
      : hasBrief || base ? 'base_review'
        : 'pending';

    const { error } = await db.from('campaigns').update({
      status,
      error_message: null,
      // A driver that died mid-batch left this set. Clearing it here means a
      // retry starts now rather than after the five-minute expiry.
      persona_lock_at: null,
    }).eq('id', id);
    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({
      status,
      did: status === 'pending'
        ? 'Starting again from reading your product page.'
        : status === 'base_review'
          ? 'Back to the main page, for you to approve before the twenty are written.'
          : `Carrying on from ${personaCount} of 20 landing pages.`,
    });
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

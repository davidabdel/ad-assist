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
    const { count } = await db.from('personas')
      .select('id', { count: 'exact', head: true }).eq('campaign_id', id);

    const hasBrief = Boolean(campaign.scraped_data?.brief);
    // A brief, or any persona already written, means the scrape is behind us.
    const status = hasBrief || (count ?? 0) > 0 ? 'personas' : 'pending';

    const { error } = await db.from('campaigns')
      .update({ status, error_message: null }).eq('id', id);
    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({
      status,
      did: status === 'pending'
        ? 'Starting again from reading your product page.'
        : `Carrying on from ${count ?? 0} of 20 landing pages.`,
    });
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

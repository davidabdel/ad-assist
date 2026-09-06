import { AuthError, requireCampaignOwner, requireOwner } from '@/lib/auth';
import { advance } from '@/lib/pipeline/advance';

export const dynamic = 'force-dynamic';
/**
 * One unit of pipeline work per call. A dashboard polls this while a campaign is
 * in flight; `waiting: true` means the next move belongs to the Mac-side worker,
 * so back off rather than hammering it.
 *
 * 300s covers the slowest single unit (a five-persona batch) with room to spare.
 * Vercel caps this by plan — if the plan is lower, the unit still fits, this
 * ceiling just never gets used.
 */
export const maxDuration = 300;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const owner = await requireOwner(req);
    const campaign = await requireCampaignOwner(owner, id);
    const result = await advance(campaign);
    return Response.json(result);
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

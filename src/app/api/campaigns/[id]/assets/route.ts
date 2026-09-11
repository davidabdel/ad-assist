import { AuthError, requireCampaignOwner, requireOwner } from '@/lib/auth';
import { makeAllPictures, pollCampaignAssets } from '@/lib/pipeline/assets';

export const dynamic = 'force-dynamic';
/**
 * Long enough to settle several finished tasks in one call: each one is a poll
 * plus a download of the file and an upload into our own storage, and a
 * ten-second video is the biggest thing this app ever moves.
 */
export const maxDuration = 300;

/**
 * Ask KIE how the campaign's in-flight generations are going, and finish the
 * ones that are done.
 *
 * Deliberately not part of `advance()`. The pipeline is finished by the time
 * anything is generating — the campaign sits at `ideas_ready` and the driver
 * loop has stopped — and folding a paid stage into the loop that runs itself is
 * how an app generates something nobody clicked on. Approving is a person's
 * act; this only ever tidies up after one.
 *
 * Polling costs nothing, so this is safe to call on a timer while the screen is
 * open.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const owner = await requireOwner(req);
    await requireCampaignOwner(owner, id);

    // One deliberate exception to "this route only tidies up": drawing every
    // missing picture at once. It spends — four credits a row — so it is a
    // body on a POST that a person pressed, never part of the timer that calls
    // this route with no body while the screen is open.
    const body = await req.json().catch(() => ({})) as { action?: string };
    if (body.action === 'make-pictures') {
      return Response.json(await makeAllPictures(id));
    }

    return Response.json(await pollCampaignAssets(id));
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

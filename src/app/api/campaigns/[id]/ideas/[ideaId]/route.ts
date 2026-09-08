import { z } from 'zod';
import { AuthError, requireCampaignOwner, requireOwner } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';
import { approveIdea, type IdeaRowForSubmit } from '@/lib/pipeline/assets';
import { CTA_LABELS } from '@/lib/ad-fields';

export const dynamic = 'force-dynamic';
/** A submit is a network round trip to KIE plus a photograph staged into storage. */
export const maxDuration = 120;

/**
 * One row of the ideas table.
 *
 *   PATCH  rewrite it
 *   POST   { action: 'approve' | 'reject' | 'reset' }
 *
 * WHY EDITING EXISTS AT ALL. These rows get pasted into Ads Manager by hand, so
 * the operator has the last word on every sentence. An approve-only table would
 * make a single wrong word into "reject and hope the next roll is better",
 * which is both slower and more expensive than changing the word.
 *
 * APPROVE IS THE ONLY BUTTON IN THIS APP THAT SPENDS MONEY. Everything it has
 * to get right — the double-click guard, the ceiling, the one-submit-ever rule
 * — lives in lib/pipeline/assets.ts; this route is the door.
 */

/**
 * Every field on the row that a person is allowed to change, and nothing else.
 *
 * Not editable, deliberately: `media_type` (it decides which model runs and
 * therefore the price), `est_credits` / `est_usd` (they are what the ceiling is
 * enforced against, so a row that could edit its own price could edit its way
 * past the ceiling), and `status`, which moves only through the actions below.
 */
const PatchSchema = z.object({
  angle: z.string().max(500).optional(),
  hook: z.string().max(1000).optional(),
  headline: z.string().min(1).max(300).optional(),
  primary_text: z.string().min(1).max(5000).optional(),
  cta_label: z.enum(CTA_LABELS).optional(),
  visual_concept: z.string().max(2000).optional(),
  kie_prompt: z.string().min(1).max(20000).optional(),
  destination_url: z.string().url().max(2000).optional(),
  source_image_url: z.string().url().max(2000).optional(),
});

/** Statuses a row can be edited in. A running task cannot be rewritten under itself. */
const EDITABLE = new Set(['draft', 'rejected', 'failed']);

async function loadIdea(campaignId: string, ideaId: string) {
  const { data, error } = await serviceClient().from('ad_ideas')
    .select('*').eq('id', ideaId).eq('campaign_id', campaignId).maybeSingle();
  if (error) throw new AuthError(`Could not read that idea: ${error.message}`, 500);
  if (!data) throw new AuthError('No such idea on this campaign', 404);
  return data;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; ideaId: string }> },
) {
  try {
    const { id, ideaId } = await params;
    const owner = await requireOwner(req);
    await requireCampaignOwner(owner, id);
    const idea = await loadIdea(id, ideaId);

    if (!EDITABLE.has(idea.status)) {
      return Response.json(
        { error: `This idea is "${idea.status}" and cannot be rewritten. A generated ad keeps the words it was made from.` },
        { status: 409 },
      );
    }

    const parsed = PatchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ error: z.treeifyError(parsed.error) }, { status: 400 });
    }
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined),
    );
    if (!Object.keys(patch).length) {
      return Response.json({ error: 'Nothing to change.' }, { status: 400 });
    }

    // Editing a row that was sent back or that failed puts it back in play.
    // Leaving it "failed" after it has been rewritten would describe the old
    // version of the row rather than the one on screen.
    const { data, error } = await serviceClient().from('ad_ideas').update({
      ...patch,
      edited_at: new Date().toISOString(),
      status: 'draft',
      rejected_reason: null,
      approved_at: null,
    }).eq('id', ideaId).select('*').single();
    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({ idea: data, did: 'Saved.' });
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

const ActionSchema = z.object({
  action: z.enum(['approve', 'reject', 'reset']),
  reason: z.string().max(1000).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; ideaId: string }> },
) {
  try {
    const { id, ideaId } = await params;
    const owner = await requireOwner(req);
    await requireCampaignOwner(owner, id);
    const idea = await loadIdea(id, ideaId);

    const parsed = ActionSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return Response.json({ error: 'action must be "approve", "reject" or "reset"' }, { status: 400 });
    }
    const db = serviceClient();

    if (parsed.data.action === 'reject') {
      const { error } = await db.from('ad_ideas').update({
        status: 'rejected',
        rejected_reason: parsed.data.reason?.trim() || null,
      }).eq('id', ideaId).eq('status', 'draft');
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ did: 'Sent back. It stays in the table — a rejected idea is still evidence about the format it came from.' });
    }

    if (parsed.data.action === 'reset') {
      const { error } = await db.from('ad_ideas').update({
        status: 'draft', rejected_reason: null, approved_at: null,
      }).eq('id', ideaId).in('status', ['rejected', 'failed']);
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ did: 'Back in the table.' });
    }

    // Approve. Everything expensive and everything that can only happen once
    // is inside approveIdea().
    const result = await approveIdea(idea as unknown as IdeaRowForSubmit);
    return Response.json(result);
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    // A refused approval is the operator's problem to read, not a server fault:
    // the ceiling, a missing photo and an already-approved row all land here.
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}

import { z } from 'zod';
import { AuthError, requireCampaignOwner, requireOwner } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';
import {
  approveIdea, makePicture, putOnLandingPage, type IdeaRowForSubmit,
} from '@/lib/pipeline/assets';
import { revisePrompt } from '@/lib/pipeline/revise';
import { CTA_LABELS } from '@/lib/ad-fields';

export const dynamic = 'force-dynamic';
/**
 * A submit is a network round trip to KIE plus a photograph staged into storage.
 * A redo is a model call instead, which is the slower of the two.
 */
export const maxDuration = 180;

/**
 * One row of the ideas table.
 *
 *   PATCH  rewrite it
 *   POST   { action: 'approve' | 'reject' | 'reset' | 'redo' | 'make-picture'
 *            | 'use-on-page' }
 *
 * WHY EDITING EXISTS AT ALL. These rows get pasted into Ads Manager by hand, so
 * the operator has the last word on every sentence. An approve-only table would
 * make a single wrong word into "reject and hope the next roll is better",
 * which is both slower and more expensive than changing the word.
 *
 * TWO BUTTONS HERE SPEND MONEY: `approve`, and `make-picture` on a row that has
 * no photograph. They are not two charges for one ad — `make-picture` is the
 * front half of the same approval, moved in front of the decision so the
 * operator can see the picture before saying yes to it, and `approve` charges
 * only for what is left. Everything they have to get right — the double-click
 * guard, the ceiling, the one-submit-ever rule — lives in
 * lib/pipeline/assets.ts; this route is the door.
 *
 * `redo` is deliberately NOT a second spending button. It rejects a finished
 * file, rewrites the instruction from what the operator says was wrong with it,
 * and puts the row back in front of them as a draft. The next generation is
 * bought by the same Approve as the first one, after they have read the revised
 * instruction. Buying a roll of a sentence nobody has read is exactly the thing
 * this table is built to prevent.
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
  action: z.enum(['approve', 'reject', 'reset', 'redo', 'make-picture', 'use-on-page']),
  reason: z.string().max(1000).optional(),
  /**
   * What is wrong with the finished file, for `redo`. Optional on purpose: an
   * empty note means "same instruction, another roll", which is a real and
   * frequently correct answer, because these models are stochastic and a video
   * that drifted once may not drift again.
   */
  note: z.string().max(2000).optional(),
});

/** Statuses a finished-or-failed result can be sent back from. */
const REDOABLE = new Set(['generated', 'failed']);

/**
 * Reject the file that was made and send the row back to be made again.
 *
 * Order of operations, which is the design:
 *
 *   1. REVISE FIRST, while nothing has changed. The model call is the only step
 *      that can fail for a reason outside this app, and doing it before any
 *      write means a failed revision loses nothing — not the note, not the
 *      file, not the row's status. The operator presses it again.
 *   2. CLAIM with a conditional update, so a double-click cannot bump the
 *      attempt counter twice.
 *   3. MARK the file rejected, keeping it. It was paid for, and attempt 1 next
 *      to attempt 2 is the only way to tell whether the note worked.
 */
async function redoIdea(
  idea: Record<string, unknown>,
  note: string | undefined,
): Promise<Response> {
  const db = serviceClient();
  const status = idea.status as string;
  const ideaId = idea.id as string;

  if (!REDOABLE.has(status)) {
    return Response.json(
      {
        error: status === 'generating' || status === 'approved'
          ? 'This one is still being made. Wait for the file before deciding about it.'
          : `Nothing has been made from this idea yet — it is "${status}", so there is no result to reject.`,
      },
      { status: 409 },
    );
  }

  const trimmed = note?.trim() ?? '';
  const currentPrompt = (idea.kie_prompt as string | null) ?? '';

  // ── 1. revise, before anything is written ───────────────────────────
  let revised = currentPrompt;
  let revisedConcept: string | null = null;
  let whatChanged: string | null = null;
  if (trimmed && currentPrompt) {
    const { data: earlier } = await db.from('generated_assets')
      .select('rejected_note').eq('ad_idea_id', ideaId)
      .not('rejected_note', 'is', null)
      .order('attempt');

    try {
      const revision = await revisePrompt({
        mediaType: idea.media_type as 'image' | 'video',
        currentPrompt,
        note: trimmed,
        visualConcept: (idea.visual_concept as string) ?? '',
        previousNotes: (earlier ?? []).map((r) => r.rejected_note as string),
      });
      revised = revision.revised_prompt;
      // The one-line description of what the ad shows is what most people read
      // instead of the prompt. Leaving it describing the version that was just
      // rejected is the same fault as leaving the old prompt in place.
      revisedConcept = revision.revised_visual_concept || null;
      whatChanged = revision.what_changed;
    } catch (e) {
      return Response.json(
        {
          error: `The instruction could not be rewritten (${(e as Error).message}). Nothing `
            + 'was changed and the ad is still here — try again, or rewrite the instruction '
            + 'yourself.',
        },
        { status: 502 },
      );
    }
  }

  const attempt = Number(idea.attempt ?? 1);

  // ── 2. claim ────────────────────────────────────────────────────────
  /**
   * A STATIC'S DRAWN PICTURE IS THE THING BEING SENT BACK, so it has to leave
   * the row with it.
   *
   * Its `kie_prompt` and its picture are the same object seen twice — the
   * sentence was drawn to make the file. A redo rewrites the sentence, and if
   * the file stayed attached, Approve would find a picture on the row and
   * simply keep it: the rejected one, made from the instruction that was just
   * replaced, approved without ever being drawn again.
   *
   * A VIDEO KEEPS ITS FRAME, and for the same reason read the other way. A
   * video's `kie_prompt` is the camera move; the frame it opens on is written
   * separately and has not been revised. Throwing it away would charge for an
   * identical picture to fix a complaint about the motion.
   */
  const dropsItsPicture = Boolean(idea.source_image_generated)
    && (idea.media_type as string) === 'image';

  const { data: claimed, error: claimError } = await db.from('ad_ideas').update({
    status: 'draft',
    kie_prompt: revised,
    ...(dropsItsPicture ? { source_image_url: null, source_image_generated: false } : {}),
    ...(revisedConcept ? { visual_concept: revisedConcept } : {}),
    attempt: attempt + 1,
    redo_note: trimmed || null,
    approved_at: null,
    // Whatever was in here described the last result, and there is about to be
    // a different one. `what_changed` replaces it when there is a revision to
    // explain, so the row on screen says why its instruction now reads
    // differently from the file sitting underneath it.
    rejected_reason: whatChanged,
  }).eq('id', ideaId).in('status', [...REDOABLE]).select('id').maybeSingle();

  if (claimError) return Response.json({ error: claimError.message }, { status: 500 });
  if (!claimed) {
    return Response.json(
      { error: 'This idea has already moved on — reload the page to see where it is.' },
      { status: 409 },
    );
  }

  // ── 3. keep the file, mark it rejected ──────────────────────────────
  // Everything finished and not already rejected: a redo means none of what has
  // been made so far is good enough, and an earlier attempt already carries its
  // own note.
  const { error: markError } = await db.from('generated_assets').update({
    rejected_at: new Date().toISOString(),
    rejected_note: trimmed || 'Sent back for another roll of the same instruction.',
  }).eq('ad_idea_id', ideaId).eq('state', 'success').is('rejected_at', null);

  return Response.json({
    did: trimmed
      ? `Sent back as attempt ${attempt + 1}. The instruction has been rewritten — read it, `
        + 'then approve it to spend.'
      : `Sent back as attempt ${attempt + 1}. Same instruction, so approving it is another roll `
        + 'of the same dice.',
    what_changed: whatChanged,
    revised_prompt: revised,
    attempt: attempt + 1,
    // Non-fatal and worth saying: the row IS back in the table, the old file is
    // simply no longer labelled as rejected.
    note: markError
      ? `The previous file could not be marked as rejected (${markError.message}).`
      : undefined,
  });
}

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
      return Response.json(
        {
          error: 'action must be "approve", "reject", "reset", "redo", "make-picture" '
            + 'or "use-on-page"',
        },
        { status: 400 },
      );
    }
    const db = serviceClient();

    // Draws the picture for a row that has no photograph, so it can be looked
    // at before it is approved. The second button in this app that spends, and
    // it spends four credits — the same call the approval would have made,
    // moved in front of the decision instead of behind it.
    if (parsed.data.action === 'make-picture') {
      return Response.json(await makePicture(idea as unknown as IdeaRowForSubmit));
    }

    // Costs nothing: the picture already exists. This only says which of a
    // buyer's ads their landing page should be wearing.
    if (parsed.data.action === 'use-on-page') {
      return Response.json(await putOnLandingPage({ ideaId, onlyIfEmpty: false }));
    }

    if (parsed.data.action === 'redo') {
      return await redoIdea(idea as Record<string, unknown>, parsed.data.note);
    }

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

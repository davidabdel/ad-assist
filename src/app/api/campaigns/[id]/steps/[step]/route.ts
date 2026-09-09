import { AuthError, requireCampaignOwner, requireOwner } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';
import { describeRedo, executeRedo, isRedoStep } from '@/lib/pipeline/redo';

export const dynamic = 'force-dynamic';

/**
 * One step of a campaign, sent back to be done again.
 *
 *   GET  → what a redo of this step WOULD do. Nothing is changed.
 *   POST { note?: string } → do it.
 *
 * THE GET EXISTS BECAUSE THE CASCADE HAS TO BE NAMED BEFORE IT HAPPENS. Every
 * stage is written from the one above it, so correcting the summary and leaving
 * the twenty pages as they are would produce a campaign whose live pages
 * contradict the brief they claim to come from. A redo therefore takes
 * everything below it — which is right, and is also exactly the kind of thing
 * that must never be a surprise. The dialog is built from this response, so
 * what it promises and what happens are read from the same code.
 *
 * WHY THE POST DOES NOT RUN ANYTHING. It rewinds and returns. The progress
 * screen is already the engine — it calls advance() in a loop for as long as it
 * is open — so a rewound campaign starts rebuilding itself on the next tick,
 * through the same stage code that built it the first time. A redo that drove
 * the pipeline itself would be a second implementation of every stage.
 */

async function load(req: Request, id: string, step: string) {
  const owner = await requireOwner(req);
  const campaign = await requireCampaignOwner(owner, id);
  if (!isRedoStep(step)) {
    return { error: Response.json({ error: `"${step}" is not a step.` }, { status: 404 }) };
  }
  return { campaign, step };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; step: string }> },
) {
  try {
    const { id, step } = await params;
    const loaded = await load(req, id, step);
    if ('error' in loaded) return loaded.error;

    const effects = await describeRedo(serviceClient(), loaded.campaign, loaded.step);
    return Response.json(effects);
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; step: string }> },
) {
  try {
    const { id, step } = await params;
    const loaded = await load(req, id, step);
    if ('error' in loaded) return loaded.error;
    const { campaign } = loaded;

    // A campaign mid-unit is a campaign with a model call in flight against the
    // rows this is about to delete. Refused rather than raced: the loser writes
    // personas onto a campaign that has been rewound underneath it, and the
    // result is a page set half from the old brief and half from the new one —
    // the single hardest kind of wrong to notice later.
    //
    // `base_review` and `ideas_ready` are the two resting states. `failed` is a
    // third, and is the state a redo is MOST useful in: something broke, and
    // sending the step back is how it gets fixed.
    const RESTING = ['base_review', 'ideas_ready', 'failed', 'pending'];
    if (!RESTING.includes(campaign.status)) {
      return Response.json({
        error: 'This campaign is working right now. Let it reach the next stopping point — '
          + 'the main page, the ideas table, or a failure — and send the step back from there. '
          + 'Redoing a step out from under a stage that is running would leave half the pages '
          + 'written from the old version.',
      }, { status: 409 });
    }

    const body = await req.json().catch(() => ({}));
    const note = typeof (body as { note?: unknown }).note === 'string'
      ? (body as { note: string }).note
      : '';

    const db = serviceClient();
    // Read again inside the request rather than trusting what the browser was
    // shown: the dialog may have been open for a while, and the sentence the
    // operator agreed to is worth being true at the moment they agreed to it.
    const effects = await describeRedo(db, campaign, loaded.step);
    const result = await executeRedo(db, campaign, loaded.step, note);

    return Response.json({ ...result, rebuilt: effects.rebuilds });
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

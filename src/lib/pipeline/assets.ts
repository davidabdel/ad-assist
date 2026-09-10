import { serviceClient } from '@/lib/supabase';
import { asDataUrl } from './image-bytes';
import { BUCKET, publicUrlFor } from '@/lib/uploads';
import {
  IMAGE_ASPECT, IMAGE_CREDITS, IMAGE_MODEL, TEXT_IMAGE_MODEL, VIDEO_ASPECT, VIDEO_MODEL,
  submitImage, submitImageFromText, submitVideo, taskStatus, usd, VIDEO_SECONDS,
} from '@/lib/kie';

/**
 * Approving an idea, and everything that follows from it.
 *
 * THIS IS THE ONLY FILE IN THE APP THAT SPENDS MONEY. Everything before it —
 * reading the page, twenty landing pages, the ad-library scan, the formats, the
 * ideas themselves — costs model tokens and nothing else. Clicking Approve is
 * the first irreversible act, so the order of operations here is the design:
 *
 *   1. CLAIM the row with a conditional update from draft → generating. Two
 *      clicks, two tabs or a double-tap on a phone all reach this, and only one
 *      of them can win. Without it the second click submits a second paid task.
 *   2. RESERVE the spend, which is where the campaign ceiling is enforced. It
 *      has to happen before the submit, because a submitted task is already
 *      billed.
 *   3. SUBMIT — exactly once, never retried.
 *   4. RECORD the task id immediately.
 *
 * Anything that fails before step 3 unwinds cleanly: the claim goes back to
 * draft and the reservation is deleted. Nothing that fails after step 3 unwinds
 * at all, so what happens instead is that the failure is written down somewhere
 * the operator can see it, with the task id in it.
 */

/** Where a generated file ends up. Public, like the pages that will carry it. */
const ASSET_PREFIX = 'generated';

export type IdeaRowForSubmit = {
  id: string;
  campaign_id: string;
  media_type: string;
  kie_model: string;
  kie_prompt: string | null;
  source_image_url: string | null;
  est_credits: number;
  est_usd: number;
  status: string;
  headline: string;
  /**
   * The picture to MAKE when there is no photograph, for a video only. A static
   * with no photograph carries its scene in `kie_prompt`, because there the
   * scene is the whole instruction; a video's `kie_prompt` is the camera move,
   * so the frame it opens on needs a field of its own.
   */
  generated_image_prompt?: string | null;
  /**
   * Which go this is. 1 unless a finished result was rejected and sent back —
   * it is written onto the asset so that two files hanging off one idea can be
   * told apart, and it is in the ledger note so a second charge on the same
   * idea is readable as a second attempt rather than a duplicate.
   */
  attempt?: number;
};

/**
 * KIE has to be able to fetch the source photograph, and the seller's CDN is
 * not ours to rely on.
 *
 * This is the same failure that produced `image-bytes.ts`: the first live image
 * run handed a model the seller's own image URLs and got back "unable to
 * download content from the provided URL", from URLs that curl pulls in 40ms.
 * A CDN that refuses one client will refuse another, and every campaign points
 * at somebody else's. So the bytes are read here — by the same fetch, with the
 * same browser headers, that already reads the product page — and put in our
 * own public bucket. What KIE is given is a URL we serve.
 *
 * A photo already in our bucket is passed through untouched.
 */
export async function mirrorForKie(input: {
  campaignId: string;
  url: string;
}): Promise<string> {
  const ours = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (ours && input.url.startsWith(`${ours.replace(/\/$/, '')}/storage/v1/object/public/`)) {
    return input.url;
  }

  const dataUrl = await asDataUrl(input.url);
  if (!dataUrl) {
    throw new Error(
      `That photograph could not be read (${input.url}). Pick a different one for this idea.`,
    );
  }
  const [head, b64] = dataUrl.split(',');
  const mime = head.slice(5, head.indexOf(';'));
  const ext = mime === 'image/png' ? 'png'
    : mime === 'image/webp' ? 'webp'
      : mime === 'image/gif' ? 'gif' : 'jpg';
  const bytes = Buffer.from(b64, 'base64');

  const path = `${ASSET_PREFIX}/${input.campaignId}/source-${crypto.randomUUID()}.${ext}`;
  const { error } = await serviceClient().storage.from(BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: false });
  if (error) throw new Error(`Could not stage the photograph for the image model: ${error.message}`);
  return publicUrlFor(path);
}

export type ApproveResult = {
  ideaId: string;
  taskId: string;
  credits: number;
  usd: number;
  did: string;
};

/**
 * Approve one idea and submit it. Throws with a sentence the operator can read
 * rather than a code; the caller turns that into an HTTP status.
 */
export async function approveIdea(idea: IdeaRowForSubmit): Promise<ApproveResult> {
  const db = serviceClient();
  const attempt = Math.max(1, Math.round(Number(idea.attempt ?? 1)));

  if (!idea.kie_prompt?.trim()) {
    throw new Error('This idea has no prompt, so there is nothing to generate.');
  }

  /**
   * Which of the three shapes this approval is, decided from the row rather
   * than from what was written when the idea was drafted — a photograph can be
   * attached or replaced by hand at any point up to the click.
   *
   *   'edit'   a photograph exists. The editing model changes what is around it.
   *   'draw'   a static with no photograph. One call makes the ad outright.
   *   'frame'  a video with no photograph. It cannot move through a frame that
   *            does not exist, so this buys the frame first and the video when
   *            the frame lands. Two charges from one click, which is why the
   *            estimate on the row already includes both.
   */
  const shape: 'edit' | 'draw' | 'frame' = idea.source_image_url
    ? 'edit'
    : (idea.media_type === 'image' ? 'draw' : 'frame');

  const scene = idea.generated_image_prompt?.trim() ?? '';
  if (shape === 'frame' && !scene) {
    throw new Error(
      'This video has no photograph and no picture has been described for its opening '
      + 'frame, so there is nothing for the shot to move through. Point it at one of your '
      + 'photos, or send it back so the picture can be written.',
    );
  }

  // ── 1. claim ────────────────────────────────────────────────────────
  // A conditional update is atomic under READ COMMITTED: the second transaction
  // re-checks its WHERE against the committed row and matches nothing. This is
  // what stops a double-click from buying two of the same ad.
  const { data: claimed, error: claimError } = await db.from('ad_ideas')
    .update({ status: 'generating', approved_at: new Date().toISOString(), rejected_reason: null })
    .eq('id', idea.id).eq('status', 'draft')
    .select('id').maybeSingle();
  if (claimError) throw new Error(`Could not take this idea: ${claimError.message}`);
  if (!claimed) {
    throw new Error(
      'This idea is not waiting for approval — it has already been approved, or sent back.',
    );
  }

  const unclaim = async (reason: string) => {
    await db.from('ad_ideas')
      .update({ status: 'draft', approved_at: null, rejected_reason: reason })
      .eq('id', idea.id);
  };

  // ── 2. reserve the spend, which is where the ceiling is enforced ────
  //
  // A video with no photograph reserves TWICE, both before anything is
  // submitted. The ceiling has to see the whole cost of the click up front: if
  // it only learned about the video after the frame had been paid for, a
  // campaign near its limit would buy a still it can never use.
  const reserve = async (cr: number, amount: number, what: string): Promise<string> => {
    const { data, error } = await db.rpc('reserve_spend', {
      cid: idea.campaign_id,
      cr: Math.max(1, Math.round(cr)),
      amount: Math.max(0, amount),
      // The attempt is in the note because the ledger is read to answer "why
      // was this campaign charged twice for the same ad?", and the honest
      // answer — the first one was rejected — has to be legible from the line.
      note: `estimate · ${what}${attempt > 1 ? ` · attempt ${attempt}` : ''} · `
        + `${idea.headline.slice(0, 60)}`,
    });
    if (error) throw new Error(error.message);
    return data as string;
  };

  const reservations: string[] = [];
  const releaseReservations = async () => {
    if (reservations.length) await db.from('spend_log').delete().in('id', reservations);
  };

  /** The reservation the FIRST submit is charged against. */
  let spendId: string;
  /** The reservation held for the video, once its frame exists. Null otherwise. */
  let videoSpendId: string | null = null;
  try {
    if (shape === 'frame') {
      const frameUsd = usd(IMAGE_CREDITS);
      spendId = await reserve(IMAGE_CREDITS, frameUsd, 'opening frame');
      reservations.push(spendId);
      videoSpendId = await reserve(
        idea.est_credits - IMAGE_CREDITS,
        Math.max(0, idea.est_usd - frameUsd),
        'video',
      );
      reservations.push(videoSpendId);
    } else {
      spendId = await reserve(idea.est_credits, idea.est_usd, idea.media_type);
      reservations.push(spendId);
    }
  } catch (e) {
    const message = (e as Error).message;
    await releaseReservations();
    await unclaim(message);
    throw new Error(
      /ceiling/i.test(message)
        ? `This campaign has reached its spend ceiling, so nothing was submitted. ${message}`
        : `Could not check this campaign's spend before submitting: ${message}`,
    );
  }

  // Staging the photograph can fail, and it costs nothing, so it happens while
  // both the claim and the reservations are still reversible. There is nothing
  // to stage when the picture is about to be made rather than edited.
  let sourceUrl: string | null = null;
  if (shape === 'edit') {
    try {
      sourceUrl = await mirrorForKie({
        campaignId: idea.campaign_id, url: idea.source_image_url as string,
      });
    } catch (e) {
      await releaseReservations();
      await unclaim((e as Error).message);
      throw e;
    }
  }

  // What is about to be sent, and what will be recorded as having been sent.
  // The model is derived from the shape rather than read off the row: the row's
  // `kie_model` was written when the idea was drafted, and a photograph
  // attached by hand since then changes which model runs.
  const model = shape === 'edit'
    ? (idea.media_type === 'image' ? IMAGE_MODEL : VIDEO_MODEL)
    : TEXT_IMAGE_MODEL;
  const promptSent = shape === 'frame' ? scene : idea.kie_prompt;

  // ── 3. submit. ONE createTask, EVER. Never retried. ─────────────────
  let taskId: string;
  try {
    let result;
    if (shape === 'draw') {
      result = await submitImageFromText({ prompt: idea.kie_prompt, aspect: IMAGE_ASPECT });
    } else if (shape === 'frame') {
      // 9:16, the shape the video will be. A 4:5 frame handed to the video
      // model is a crop nobody asked for.
      result = await submitImageFromText({ prompt: scene, aspect: VIDEO_ASPECT });
    } else if (idea.media_type === 'image') {
      result = await submitImage({ prompt: idea.kie_prompt, imageUrl: sourceUrl as string });
    } else {
      result = await submitVideo({
        prompt: idea.kie_prompt, firstFrameUrl: sourceUrl as string, seconds: VIDEO_SECONDS,
      });
    }
    taskId = result.taskId;
  } catch (e) {
    // KIE refused it, so nothing was billed and both the claim and the
    // reservations come back.
    await releaseReservations();
    await unclaim((e as Error).message);
    throw e;
  }

  // ── 4. write the task id down before anything else ──────────────────
  const { data: asset, error: assetError } = await db.from('generated_assets').insert({
    ad_idea_id: idea.id,
    clip_index: null,
    kie_task_id: taskId,
    kie_model: model,
    state: 'submitted',
    attempt,
    // 'first_frame' is what tells the poller to submit the video when this
    // lands rather than calling the ad finished.
    role: shape === 'frame' ? 'first_frame' : 'ad',
    pending_spend_id: videoSpendId,
    // Copied, not referenced. The idea's `kie_prompt` moves on the moment this
    // result is rejected and revised, and a file whose instruction is read live
    // from the row would start describing itself with the sentence written to
    // replace it.
    prompt_used: promptSent,
  }).select('id').single();

  if (assetError || !asset) {
    // Past the point of no return: the task is paid for and running. The only
    // useful thing left is to make sure the task id reaches a human, so it goes
    // where the operator will see it rather than into a log nobody reads.
    await db.from('ad_ideas').update({
      status: 'failed',
      rejected_reason: `Submitted to KIE as task ${taskId} and BILLED, but the record could not `
        + `be saved (${assetError?.message ?? 'no row returned'}). The image or video is being `
        + 'made and can be fetched with that task id.',
    }).eq('id', idea.id);
    throw new Error(
      `Submitted as task ${taskId} — it is running and has been charged — but recording it `
      + `failed: ${assetError?.message ?? 'no row returned'}`,
    );
  }

  // Links the reservation to what it paid for, so the reconciliation later can
  // find it. If this update fails the reservation is simply orphaned: it still
  // counts against the ceiling, which is the safe direction to be wrong in.
  await db.from('spend_log').update({ asset_id: asset.id }).eq('id', spendId);

  return {
    ideaId: idea.id,
    taskId,
    credits: idea.est_credits,
    usd: idea.est_usd,
    did: shape === 'frame'
      ? 'Submitted. The picture it opens on is being made first, then the video starts on '
        + `its own — about four minutes altogether, $${idea.est_usd.toFixed(2)} estimated.`
      : `Submitted. About ${idea.media_type === 'image' ? 'a minute' : 'three minutes'}, `
        + `$${idea.est_usd.toFixed(2)} estimated.`
        + (shape === 'draw' ? ' No photograph of yours fitted this one, so the picture is '
          + 'being made from the description above.' : ''),
  };
}

export type PollResult = {
  checked: number;
  finished: number;
  failed: number;
  notes: string[];
};

/**
 * Ask KIE about every task this campaign has in flight, and settle the ones
 * that have finished.
 *
 * Polling is free, so this is safe to call as often as a screen wants. What is
 * not free is the file: a KIE result URL is temporary, so a finished asset is
 * copied into our own bucket here and `stored_url` is what everything else
 * reads. A result that expired before anyone fetched it is a paid-for ad that
 * no longer exists.
 */
export async function pollCampaignAssets(campaignId: string): Promise<PollResult> {
  const db = serviceClient();
  const notes: string[] = [];

  const { data: ideas } = await db.from('ad_ideas')
    .select('id').eq('campaign_id', campaignId);
  const ideaIds = (ideas ?? []).map((i) => i.id as string);
  if (!ideaIds.length) return { checked: 0, finished: 0, failed: 0, notes };

  const { data: pending } = await db.from('generated_assets')
    .select('id, ad_idea_id, kie_task_id, kie_model, state, attempt, role, pending_spend_id')
    .in('ad_idea_id', ideaIds)
    .in('state', ['submitted', 'generating']);

  const live = (pending ?? []) as unknown as {
    id: string; ad_idea_id: string; kie_task_id: string; kie_model: string; state: string;
    attempt: number; role: string | null; pending_spend_id: string | null;
  }[];
  if (!live.length) return { checked: 0, finished: 0, failed: 0, notes };

  let finished = 0;
  let failed = 0;

  // Sequential rather than parallel. Twenty tasks is the realistic ceiling on
  // one campaign, each poll is a fast GET, and a burst of them against a
  // rate-limited API is a worse failure than taking a few extra seconds.
  for (const asset of live) {
    let status;
    try {
      status = await taskStatus(asset.kie_task_id);
    } catch (e) {
      notes.push(`Could not read task ${asset.kie_task_id}: ${(e as Error).message}`);
      continue;
    }

    if (status.state === 'waiting' || status.state === 'generating') {
      if (asset.state !== 'generating') {
        await db.from('generated_assets').update({ state: 'generating' }).eq('id', asset.id);
      }
      continue;
    }

    const isFrame = asset.role === 'first_frame';

    if (status.state === 'fail') {
      failed++;
      await db.from('generated_assets').update({
        state: 'fail',
        fail_reason: status.failMessage ?? 'KIE reported the task failed and gave no reason.',
        credits_charged: 0,
        completed_at: new Date().toISOString(),
      }).eq('id', asset.id);
      await db.from('ad_ideas').update({
        status: 'failed',
        rejected_reason: isFrame
          ? `The picture the video opens on could not be made (${status.failMessage ?? 'KIE gave no reason'}), `
            + 'so the video was never started. Neither was charged.'
          : status.failMessage ?? 'The generation failed at KIE.',
      }).eq('id', asset.ad_idea_id);
      // A failed task is not billed, so the reservation comes back rather than
      // sitting against the ceiling forever. A frame takes the video's
      // reservation down with it: that video is not going to be submitted.
      await db.from('spend_log').delete().eq('asset_id', asset.id);
      if (asset.pending_spend_id) {
        await db.from('spend_log').delete().eq('id', asset.pending_spend_id);
      }
      notes.push(`One ad failed at KIE: ${status.failMessage ?? 'no reason given'}. It was not charged.`);
      continue;
    }

    // Success.
    const url = status.urls[0];
    if (!url) {
      notes.push(`Task ${asset.kie_task_id} reported success but returned no file.`);
      continue;
    }

    if (isFrame) {
      await settleFirstFrame({ campaignId, asset, url, credits: status.creditsConsumed, notes });
      continue;
    }

    let stored: string | null = null;
    try {
      stored = await storeResult({ campaignId, assetId: asset.id, url });
    } catch (e) {
      // The URL still works for a few days, so the ad is not lost — but say so
      // rather than presenting a link that will quietly stop resolving.
      notes.push(`Made, but could not be copied into your own storage (${(e as Error).message}). `
        + 'The temporary link below expires in a few days.');
    }

    finished++;
    await db.from('generated_assets').update({
      state: 'success',
      result_url: url,
      stored_url: stored,
      credits_charged: status.creditsConsumed ?? null,
      completed_at: new Date().toISOString(),
    }).eq('id', asset.id);
    await db.from('ad_ideas').update({ status: 'generated' }).eq('id', asset.ad_idea_id);

    // Replace the estimate with what KIE says it actually charged. Two rows —
    // a delete and an insert — rather than an update, so the ledger only ever
    // holds figures that came from KIE once a task has finished.
    if (status.creditsConsumed != null) {
      await db.from('spend_log').delete().eq('asset_id', asset.id);
      await db.from('spend_log').insert({
        campaign_id: campaignId,
        asset_id: asset.id,
        credits: Math.round(status.creditsConsumed),
        usd: usd(status.creditsConsumed),
        note: asset.attempt > 1 ? `charged by KIE · attempt ${asset.attempt}` : 'charged by KIE',
      });
    }
  }

  return { checked: live.length, finished, failed, notes };
}

/**
 * A generated opening frame has landed, so buy the video it exists for.
 *
 * THIS IS THE SECOND HALF OF ONE APPROVAL. The operator clicked once; both
 * charges were reserved against the ceiling at that click, and this spends the
 * second of them. It runs inside the poller rather than inside the approve
 * request because the frame takes half a minute to make, and a request that
 * sits waiting for it is a request that dies on a slow day and leaves a
 * paid-for still with nothing driving it.
 *
 * ORDER OF OPERATIONS, and it is the design: the frame is recorded and written
 * onto the idea BEFORE the video is submitted. A crash in between then leaves a
 * still that was paid for and is attached to the row, so approving again buys
 * the video and not a second picture.
 */
async function settleFirstFrame(input: {
  campaignId: string;
  asset: {
    id: string; ad_idea_id: string; kie_task_id: string; attempt: number;
    pending_spend_id: string | null;
  };
  url: string;
  credits: number | null;
  notes: string[];
}): Promise<void> {
  const db = serviceClient();
  const { asset, notes } = input;

  // ── 1. keep the file. A KIE result URL expires; ours does not. ──────
  let stored: string | null = null;
  try {
    stored = await storeResult({ campaignId: input.campaignId, assetId: asset.id, url: input.url });
  } catch (e) {
    notes.push('The picture the video opens on was made but could not be copied into your own '
      + `storage (${(e as Error).message}). The video is being made from KIE's temporary copy.`);
  }
  const frameUrl = stored ?? input.url;

  // ── 2. record it, and put it on the idea, before spending again ────
  await db.from('generated_assets').update({
    state: 'success',
    result_url: input.url,
    stored_url: stored,
    credits_charged: input.credits ?? null,
    completed_at: new Date().toISOString(),
  }).eq('id', asset.id);

  await db.from('ad_ideas').update({
    source_image_url: frameUrl,
    // Never inferred from the URL. Once this is written the picture is
    // indistinguishable from one of the seller's own, and a made picture must
    // never be presented on screen as a photograph of their product.
    source_image_generated: true,
  }).eq('id', asset.ad_idea_id);

  if (input.credits != null) {
    await db.from('spend_log').delete().eq('asset_id', asset.id);
    await db.from('spend_log').insert({
      campaign_id: input.campaignId,
      asset_id: asset.id,
      credits: Math.round(input.credits),
      usd: usd(input.credits),
      note: `charged by KIE · opening frame${asset.attempt > 1 ? ` · attempt ${asset.attempt}` : ''}`,
    });
  }

  const { data: ideaRow } = await db.from('ad_ideas')
    .select('id, kie_prompt, status').eq('id', asset.ad_idea_id).maybeSingle();
  const idea = ideaRow as unknown as { kie_prompt: string | null; status: string } | null;

  const abandon = async (reason: string) => {
    if (asset.pending_spend_id) {
      await db.from('spend_log').delete().eq('id', asset.pending_spend_id);
    }
    await db.from('ad_ideas').update({ status: 'failed', rejected_reason: reason })
      .eq('id', asset.ad_idea_id);
    notes.push(reason);
  };

  if (!idea?.kie_prompt?.trim()) {
    await abandon('The opening picture was made and charged, but the video has no instruction '
      + 'to follow, so it was not started. The picture is on the row and will be reused.');
    return;
  }

  // ── 3. submit the video. ONE createTask, EVER. Never retried. ──────
  let taskId: string;
  try {
    const result = await submitVideo({
      prompt: idea.kie_prompt, firstFrameUrl: frameUrl, seconds: VIDEO_SECONDS,
    });
    taskId = result.taskId;
  } catch (e) {
    await abandon(`The opening picture was made, but the video KIE refused: ${(e as Error).message}. `
      + 'The picture is on the row, so approving again starts the video without paying for '
      + 'another one.');
    return;
  }

  const { data: videoAsset, error } = await db.from('generated_assets').insert({
    ad_idea_id: asset.ad_idea_id,
    clip_index: null,
    kie_task_id: taskId,
    kie_model: VIDEO_MODEL,
    state: 'submitted',
    attempt: asset.attempt,
    role: 'ad',
    prompt_used: idea.kie_prompt,
  }).select('id').single();

  if (error || !videoAsset) {
    // Past the point of no return, same as at submit: the video is running and
    // charged, so the only useful thing left is getting the task id in front of
    // a person.
    await db.from('ad_ideas').update({
      status: 'failed',
      rejected_reason: `The video was submitted to KIE as task ${taskId} and BILLED, but the `
        + `record could not be saved (${error?.message ?? 'no row returned'}). It is being made `
        + 'and can be fetched with that task id.',
    }).eq('id', asset.ad_idea_id);
    notes.push(`Video task ${taskId} is running and charged, but could not be recorded.`);
    return;
  }

  if (asset.pending_spend_id) {
    await db.from('spend_log').update({ asset_id: videoAsset.id }).eq('id', asset.pending_spend_id);
  }
  notes.push('The picture is made; the video it opens on is now being generated.');
}

/** Copy a finished KIE file into our own bucket. Returns the public URL. */
async function storeResult(input: {
  campaignId: string; assetId: string; url: string;
}): Promise<string> {
  const res = await fetch(input.url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`KIE's file returned ${res.status}`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new Error('the file was empty');

  const ext = type.includes('mp4') ? 'mp4'
    : type.includes('png') ? 'png'
      : type.includes('webp') ? 'webp'
        : type.includes('jpeg') ? 'jpg'
          : (new URL(input.url).pathname.split('.').pop() ?? 'bin').slice(0, 4);

  const path = `${ASSET_PREFIX}/${input.campaignId}/${input.assetId}.${ext}`;
  const { error } = await serviceClient().storage.from(BUCKET)
    .upload(path, bytes, { contentType: type || undefined, upsert: true });
  if (error) throw new Error(error.message);
  return publicUrlFor(path);
}

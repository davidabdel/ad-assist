import { serviceClient } from '@/lib/supabase';
import { asDataUrl } from './image-bytes';
import { BUCKET, publicUrlFor } from '@/lib/uploads';
import {
  submitImage, submitVideo, taskStatus, usd, VIDEO_SECONDS,
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

  if (!idea.kie_prompt?.trim()) {
    throw new Error('This idea has no prompt, so there is nothing to generate.');
  }
  if (!idea.source_image_url) {
    throw new Error(
      'This idea has no source photograph. Every ad is built out of one of your own '
      + 'photos rather than invented, so one has to be chosen before it can be made.',
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
  let spendId: string;
  try {
    const { data, error } = await db.rpc('reserve_spend', {
      cid: idea.campaign_id,
      cr: idea.est_credits,
      amount: idea.est_usd,
      note: `estimate · ${idea.media_type} · ${idea.headline.slice(0, 60)}`,
    });
    if (error) throw new Error(error.message);
    spendId = data as string;
  } catch (e) {
    const message = (e as Error).message;
    await unclaim(message);
    throw new Error(
      /ceiling/i.test(message)
        ? `This campaign has reached its spend ceiling, so nothing was submitted. ${message}`
        : `Could not check this campaign's spend before submitting: ${message}`,
    );
  }

  const releaseReservation = async () => {
    await db.from('spend_log').delete().eq('id', spendId);
  };

  // Staging the photograph can fail, and it costs nothing, so it happens while
  // both the claim and the reservation are still reversible.
  let sourceUrl: string;
  try {
    sourceUrl = await mirrorForKie({ campaignId: idea.campaign_id, url: idea.source_image_url });
  } catch (e) {
    await releaseReservation();
    await unclaim((e as Error).message);
    throw e;
  }

  // ── 3. submit. ONE createTask, EVER. Never retried. ─────────────────
  let taskId: string;
  try {
    const result = idea.media_type === 'image'
      ? await submitImage({ prompt: idea.kie_prompt, imageUrl: sourceUrl })
      : await submitVideo({
        prompt: idea.kie_prompt, firstFrameUrl: sourceUrl, seconds: VIDEO_SECONDS,
      });
    taskId = result.taskId;
  } catch (e) {
    // KIE refused it, so nothing was billed and both the claim and the
    // reservation come back.
    await releaseReservation();
    await unclaim((e as Error).message);
    throw e;
  }

  // ── 4. write the task id down before anything else ──────────────────
  const { data: asset, error: assetError } = await db.from('generated_assets').insert({
    ad_idea_id: idea.id,
    clip_index: null,
    kie_task_id: taskId,
    kie_model: idea.kie_model,
    state: 'submitted',
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
    did: `Submitted. About ${idea.media_type === 'image' ? 'a minute' : 'three minutes'}, `
      + `$${idea.est_usd.toFixed(2)} estimated.`,
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
    .select('id, ad_idea_id, kie_task_id, kie_model, state')
    .in('ad_idea_id', ideaIds)
    .in('state', ['submitted', 'generating']);

  const live = (pending ?? []) as unknown as {
    id: string; ad_idea_id: string; kie_task_id: string; kie_model: string; state: string;
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
        rejected_reason: status.failMessage ?? 'The generation failed at KIE.',
      }).eq('id', asset.ad_idea_id);
      // A failed task is not billed, so the reservation comes back rather than
      // sitting against the ceiling forever.
      await db.from('spend_log').delete().eq('asset_id', asset.id);
      notes.push(`One ad failed at KIE: ${status.failMessage ?? 'no reason given'}. It was not charged.`);
      continue;
    }

    // Success.
    const url = status.urls[0];
    if (!url) {
      notes.push(`Task ${asset.kie_task_id} reported success but returned no file.`);
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
        note: 'charged by KIE',
      });
    }
  }

  return { checked: live.length, finished, failed, notes };
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

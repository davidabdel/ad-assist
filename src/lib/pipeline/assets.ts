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
 * ideas themselves — costs model tokens and nothing else. Two acts in here are
 * irreversible — approving an ad, and drawing the picture for a row that has no
 * photograph — and both follow the same order of operations, which is the
 * design:
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

/**
 * Money, to the cent, and never below zero.
 *
 * `1.26 - 0.02` is `1.2400000000000002` in floating point, and that figure goes
 * into a ledger a person reads and into a ceiling a charge is refused against.
 * A cent is the smallest thing this app charges, so a cent is the resolution.
 */
function cents(usdAmount: number): number {
  return Math.max(0, Math.round(usdAmount * 100) / 100);
}

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
   * True when the picture on this row was drawn rather than photographed.
   *
   * IT DECIDES WHICH MODEL RUNS, so it is not cosmetic. A row holding one of
   * the seller's photographs goes to the editing model; a row holding a picture
   * this app made has already been paid for, and handing it back to a retoucher
   * would buy a second-generation copy of a finished ad.
   */
  source_image_generated?: boolean | null;
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
   * Which of the five shapes this approval is, decided from the row rather
   * than from what was written when the idea was drafted — a photograph can be
   * attached or replaced by hand at any point up to the click.
   *
   *   'edit'   a photograph exists. The editing model changes what is around it.
   *   'draw'   a static with no photograph. One call makes the ad outright.
   *   'frame'  a video with no photograph. It cannot move through a frame that
   *            does not exist, so this buys the frame first and the video when
   *            the frame lands. Two charges from one click, which is why the
   *            estimate on the row already includes both.
   *   'keep'   a static whose picture was already made and looked at. THE AD
   *            EXISTS. Approving it spends nothing, because the money went when
   *            the picture was made; a second call here would buy a different
   *            picture from the one the operator just said yes to.
   *   'video'  a video whose opening frame was already made and looked at. Only
   *            the shot is left to buy, so only the shot is charged.
   */
  const alreadyDrawn = Boolean(idea.source_image_url) && Boolean(idea.source_image_generated);
  const shape: 'edit' | 'draw' | 'frame' | 'keep' | 'video' = idea.source_image_url
    ? (alreadyDrawn ? (idea.media_type === 'image' ? 'keep' : 'video') : 'edit')
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

  // ── 1a. the ad that already exists ──────────────────────────────────
  //
  // Nothing is submitted and nothing is charged. The picture on this row was
  // drawn from this row's own instruction and the operator has looked at it, so
  // approving it means keeping it — the file stops being a preview and becomes
  // the ad. Buying another roll of the same sentence here would hand back a
  // DIFFERENT picture from the one that was approved, which is the one thing
  // an approval must never do.
  if (shape === 'keep') {
    const { error: promoteError } = await db.from('generated_assets')
      .update({ role: 'ad' })
      .eq('ad_idea_id', idea.id).eq('role', 'preview').eq('state', 'success')
      .eq('attempt', attempt).is('rejected_at', null);
    if (promoteError) {
      await unclaim(`Could not keep the picture: ${promoteError.message}`);
      throw new Error(`Could not keep the picture: ${promoteError.message}`);
    }
    await db.from('ad_ideas')
      .update({ status: 'generated', rejected_reason: null }).eq('id', idea.id);
    return {
      ideaId: idea.id,
      taskId: '',
      credits: 0,
      usd: 0,
      did: 'Kept. The picture you looked at is the ad — it was paid for when it was made, '
        + 'so this costs nothing.',
    };
  }

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
    } else if (shape === 'video') {
      // The frame on this row was bought and charged already. Reserving the
      // row's whole estimate here would charge for it twice — quietly, because
      // both lines are correct-looking and only their sum is wrong.
      spendId = await reserve(
        idea.est_credits - IMAGE_CREDITS,
        cents(idea.est_usd - usd(IMAGE_CREDITS)),
        'video',
      );
      reservations.push(spendId);
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
  if (shape === 'edit' || shape === 'video') {
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
    : shape === 'video' ? VIDEO_MODEL
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

  const chargedCredits = shape === 'video' ? idea.est_credits - IMAGE_CREDITS : idea.est_credits;
  const chargedUsd = shape === 'video'
    ? cents(idea.est_usd - usd(IMAGE_CREDITS)) : idea.est_usd;

  return {
    ideaId: idea.id,
    taskId,
    credits: chargedCredits,
    usd: chargedUsd,
    did: shape === 'video'
      ? `Submitted. The picture it opens on was already made and paid for, so this is the shot `
        + `only — about three minutes, $${chargedUsd.toFixed(2)} estimated.`
      : shape === 'frame'
      ? 'Submitted. The picture it opens on is being made first, then the video starts on '
        + `its own — about four minutes altogether, $${idea.est_usd.toFixed(2)} estimated.`
      : `Submitted. About ${idea.media_type === 'image' ? 'a minute' : 'three minutes'}, `
        + `$${idea.est_usd.toFixed(2)} estimated.`
        + (shape === 'draw' ? ' No photograph of yours fitted this one, so the picture is '
          + 'being made from the description above.' : ''),
  };
}

/**
 * Draw the picture for a row that has no photograph, and show it to the
 * operator BEFORE they decide.
 *
 * WHY THIS EXISTS. A row with no photograph used to carry its picture as a
 * paragraph of prose and nothing else — the card said what would be made, the
 * file only came into existence after Approve, and Approve was disabled on
 * exactly those rows. So sixty ideas sat in front of a person with nothing to
 * look at and no button that worked. The description was never the deliverable;
 * it was the receipt for a decision nobody could make.
 *
 * IT DOES NOT COST MORE. It is the same single call the approval would have
 * made, at the same four credits, moved to the front of the decision instead of
 * behind it. For a static the file it produces IS the ad, and Approve keeps it
 * for nothing. For a video it is the opening frame, which that approval was
 * always going to buy first — so what changes there is that $1.24 of camera
 * move is now spent by somebody who has seen the frame.
 *
 * IT IS STILL A CLICK. Nothing in this app draws anything on its own; this is a
 * second button that spends rather than a step that spends by itself, and the
 * ceiling is enforced here exactly as it is on Approve.
 */
export async function makePicture(idea: IdeaRowForSubmit): Promise<ApproveResult> {
  const db = serviceClient();
  const attempt = Math.max(1, Math.round(Number(idea.attempt ?? 1)));

  if (idea.source_image_url) {
    throw new Error(
      idea.source_image_generated
        ? 'This one already has a picture. Send it back if you want a different one.'
        : 'This one already has one of your photographs on it, so there is nothing to draw. '
          + 'Approve it, or point it at a different photo.',
    );
  }

  /**
   * Which sentence to draw from, and it differs by media type for the same
   * reason the two fields exist. A static's whole instruction IS the scene. A
   * video's `kie_prompt` is the camera move, which describes nothing to
   * photograph, so its frame has its own field.
   */
  const scene = (idea.media_type === 'image'
    ? idea.kie_prompt
    : idea.generated_image_prompt)?.trim() ?? '';
  if (!scene) {
    throw new Error(
      'No picture has been described for this one yet, so there is nothing to draw. '
      + 'Attach one of your photographs instead, or send it back so the picture can be written.',
    );
  }

  // ── 1. claim, the same conditional update Approve uses ──────────────
  // 'generating' is the truth while this is in flight, and it is also the
  // double-click guard: a second click re-checks its WHERE against the
  // committed row and matches nothing. The poller puts the row back to 'draft'
  // when the picture lands, because a picture is not an approval.
  const { data: claimed, error: claimError } = await db.from('ad_ideas')
    .update({ status: 'generating', rejected_reason: null })
    .eq('id', idea.id).eq('status', 'draft')
    .select('id').maybeSingle();
  if (claimError) throw new Error(`Could not take this idea: ${claimError.message}`);
  if (!claimed) {
    throw new Error('This idea is not waiting — it is already being made, or has moved on.');
  }

  const unclaim = async (reason: string) => {
    await db.from('ad_ideas')
      .update({ status: 'draft', rejected_reason: reason }).eq('id', idea.id);
  };

  // ── 2. reserve, which is where the ceiling is enforced ──────────────
  let spendId: string;
  try {
    const { data, error } = await db.rpc('reserve_spend', {
      cid: idea.campaign_id,
      cr: IMAGE_CREDITS,
      amount: usd(IMAGE_CREDITS),
      note: `estimate · picture${attempt > 1 ? ` · attempt ${attempt}` : ''} · `
        + `${idea.headline.slice(0, 60)}`,
    });
    if (error) throw new Error(error.message);
    spendId = data as string;
  } catch (e) {
    const message = (e as Error).message;
    await unclaim(message);
    throw new Error(
      /ceiling/i.test(message)
        ? `This campaign has reached its spend ceiling, so nothing was made. ${message}`
        : `Could not check this campaign's spend before drawing: ${message}`,
    );
  }

  // ── 3. submit. ONE createTask, EVER. Never retried. ─────────────────
  // The shape it is drawn at is the shape it will be used at: 4:5 for a static
  // in a feed, 9:16 for a frame a video is about to move through. A frame drawn
  // at 4:5 and handed to the video model is a crop nobody asked for.
  let taskId: string;
  try {
    const result = await submitImageFromText({
      prompt: scene,
      aspect: idea.media_type === 'image' ? IMAGE_ASPECT : VIDEO_ASPECT,
    });
    taskId = result.taskId;
  } catch (e) {
    await db.from('spend_log').delete().eq('id', spendId);
    await unclaim((e as Error).message);
    throw e;
  }

  // ── 4. write the task id down before anything else ──────────────────
  const { data: asset, error: assetError } = await db.from('generated_assets').insert({
    ad_idea_id: idea.id,
    clip_index: null,
    kie_task_id: taskId,
    kie_model: TEXT_IMAGE_MODEL,
    state: 'submitted',
    attempt,
    // 'preview' is what stops the poller calling this the finished ad. For a
    // static it becomes the ad on Approve; for a video it becomes the frame the
    // shot opens on. Either way it is not an ad until a person says so.
    role: 'preview',
    prompt_used: scene,
  }).select('id').single();

  if (assetError || !asset) {
    await db.from('ad_ideas').update({
      status: 'failed',
      rejected_reason: `The picture was submitted to KIE as task ${taskId} and BILLED, but the `
        + `record could not be saved (${assetError?.message ?? 'no row returned'}). It is being `
        + 'made and can be fetched with that task id.',
    }).eq('id', idea.id);
    throw new Error(
      `Submitted as task ${taskId} — it is running and has been charged — but recording it `
      + `failed: ${assetError?.message ?? 'no row returned'}`,
    );
  }

  await db.from('spend_log').update({ asset_id: asset.id }).eq('id', spendId);

  return {
    ideaId: idea.id,
    taskId,
    credits: IMAGE_CREDITS,
    usd: usd(IMAGE_CREDITS),
    did: `Drawing it — about half a minute, $${usd(IMAGE_CREDITS).toFixed(2)}. `
      + (idea.media_type === 'image'
        ? 'What comes back is the ad itself, so Approve after it lands keeps it and costs '
          + 'nothing more.'
        : 'What comes back is the frame the shot opens on. The camera move is only bought '
          + 'when you approve it.'),
  };
}

/**
 * Draw every picture a campaign is missing, in one go.
 *
 * Sequential on purpose. Sixty submits fired at once is a burst against a
 * rate-limited API whose failures cost money to diagnose, and each one is a
 * fast POST — the picture itself is made asynchronously and collected by the
 * poller. The ceiling is enforced per row inside `makePicture`, so a campaign
 * that runs out mid-way stops there rather than half-charging anything.
 */
export async function makeAllPictures(campaignId: string): Promise<{
  started: number; skipped: number; credits: number; usd: number; notes: string[];
}> {
  const db = serviceClient();
  const { data, error } = await db.from('ad_ideas')
    .select('*')
    .eq('campaign_id', campaignId).eq('status', 'draft')
    .is('source_image_url', null)
    .not('generated_image_prompt', 'is', null)
    .order('persona_id').order('idea_index');
  if (error) throw new Error(`Could not read this campaign's ideas: ${error.message}`);

  const rows = (data ?? []) as unknown as IdeaRowForSubmit[];
  const notes: string[] = [];
  let started = 0;

  for (const row of rows) {
    try {
      await makePicture(row);
      started++;
    } catch (e) {
      const message = (e as Error).message;
      notes.push(`${row.headline.slice(0, 50)}: ${message}`);
      // A ceiling stops the whole run. Carrying on would mean every remaining
      // row failing for the same reason, sixty lines of identical noise, and a
      // wait for it.
      if (/ceiling/i.test(message)) {
        notes.push('Stopped at the spend ceiling. Nothing after this one was submitted.');
        break;
      }
    }
  }

  return {
    started,
    skipped: rows.length - started,
    credits: started * IMAGE_CREDITS,
    usd: usd(started * IMAGE_CREDITS),
    notes,
  };
}

/**
 * Put a picture that exists on the landing page the ad points at.
 *
 * THE AD AND ITS PAGE SHOULD SHOW THE SAME THING. Somebody clicks a picture and
 * arrives somewhere; if the top of that page is a different picture, or no
 * picture, the click has to be re-earned. The persona page already has a slot
 * of its own that beats the campaign-wide one, so this is a write, not a build.
 *
 * `onlyIfEmpty` is how it runs by itself when a picture lands: the FIRST
 * picture made for a buyer becomes their page's hero, and after that the page
 * is left alone unless somebody chooses otherwise on a card. Three ads point at
 * one page and the page can only wear one of them, so the alternative is the
 * third picture silently replacing a hero the operator chose.
 */
export async function putOnLandingPage(input: {
  ideaId: string;
  onlyIfEmpty: boolean;
}): Promise<{ did: string; changed: boolean }> {
  const db = serviceClient();
  const { data: ideaRow, error } = await db.from('ad_ideas')
    .select('id, persona_id, source_image_url, source_image_generated, visual_concept')
    .eq('id', input.ideaId).maybeSingle();
  if (error) throw new Error(error.message);
  const idea = ideaRow as unknown as {
    persona_id: string | null; source_image_url: string | null;
    source_image_generated: boolean | null; visual_concept: string | null;
  } | null;

  if (!idea?.source_image_url) {
    throw new Error('This idea has no picture on it yet, so there is nothing to put on the page.');
  }
  if (!idea.persona_id) {
    throw new Error('This idea is not attached to a buyer, so it has no page of its own.');
  }

  const { data: personaRow } = await db.from('personas')
    .select('id, custom_hero_image_url').eq('id', idea.persona_id).maybeSingle();
  const persona = personaRow as unknown as { custom_hero_image_url: string | null } | null;
  if (!persona) throw new Error('That buyer no longer exists.');

  if (input.onlyIfEmpty && persona.custom_hero_image_url) {
    return { did: 'The page already has a picture at the top of it.', changed: false };
  }

  const { error: writeError } = await db.from('personas').update({
    custom_hero_image_url: idea.source_image_url,
    // Describes the photograph, not the ad — it is read out to somebody who
    // cannot see it. `visual_concept` is the nearest true sentence we hold.
    custom_hero_image_alt: idea.visual_concept ?? '',
  }).eq('id', idea.persona_id);
  if (writeError) throw new Error(writeError.message);

  return {
    did: 'Put at the top of this buyer\'s landing page, so the ad and the page they land on '
      + 'show the same picture.',
    changed: true,
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
    const isPreview = asset.role === 'preview';

    if (status.state === 'fail') {
      failed++;
      await db.from('generated_assets').update({
        state: 'fail',
        fail_reason: status.failMessage ?? 'KIE reported the task failed and gave no reason.',
        credits_charged: 0,
        completed_at: new Date().toISOString(),
      }).eq('id', asset.id);
      await db.from('ad_ideas').update({
        // A picture that could not be drawn has not failed the AD — the words
        // are untouched and nothing was approved. The row goes back to waiting
        // with the reason on it, and the button is there to try again.
        status: isPreview ? 'draft' : 'failed',
        rejected_reason: isPreview
          ? `The picture could not be drawn (${status.failMessage ?? 'KIE gave no reason'}). `
            + 'Nothing was charged. Try it again, or rewrite the instruction first.'
          : isFrame
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

    if (isPreview) {
      await settlePreview({ campaignId, asset, url, credits: status.creditsConsumed, notes });
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
 * A drawn picture has landed. Put it on the row and stop.
 *
 * NOTHING IS SUBMITTED HERE, and that is the whole difference between this and
 * the frame below. A frame is the first half of an approval already given, so
 * it spends again the moment it lands. A picture is the thing the operator
 * asked to LOOK at, so it goes back in front of them as a draft and waits.
 *
 * It also lands on the buyer's page. An ad and the page it points at showing
 * two different pictures — or the ad showing one and the page showing none — is
 * a click that has to be won twice. First picture for that buyer wins; after
 * that the page keeps what it has unless somebody chooses otherwise on a card.
 */
async function settlePreview(input: {
  campaignId: string;
  asset: { id: string; ad_idea_id: string; kie_task_id: string; attempt: number };
  url: string;
  credits: number | null;
  notes: string[];
}): Promise<void> {
  const db = serviceClient();
  const { asset, notes } = input;

  let stored: string | null = null;
  try {
    stored = await storeResult({ campaignId: input.campaignId, assetId: asset.id, url: input.url });
  } catch (e) {
    notes.push('A picture was drawn but could not be copied into your own storage '
      + `(${(e as Error).message}). KIE's temporary copy is on the row and expires in a few days.`);
  }

  await db.from('generated_assets').update({
    state: 'success',
    result_url: input.url,
    stored_url: stored,
    credits_charged: input.credits ?? null,
    completed_at: new Date().toISOString(),
  }).eq('id', asset.id);

  await db.from('ad_ideas').update({
    source_image_url: stored ?? input.url,
    // Never inferred from the URL. Once this is written the picture is
    // indistinguishable from one of the seller's own, and it decides which
    // model Approve runs — so getting it wrong buys a retouched copy of a
    // finished ad.
    source_image_generated: true,
    // Back to waiting on a person. A picture is not an approval.
    status: 'draft',
    rejected_reason: null,
  }).eq('id', asset.ad_idea_id);

  if (input.credits != null) {
    await db.from('spend_log').delete().eq('asset_id', asset.id);
    await db.from('spend_log').insert({
      campaign_id: input.campaignId,
      asset_id: asset.id,
      credits: Math.round(input.credits),
      usd: usd(input.credits),
      note: `charged by KIE · picture${asset.attempt > 1 ? ` · attempt ${asset.attempt}` : ''}`,
    });
  }

  try {
    await putOnLandingPage({ ideaId: asset.ad_idea_id, onlyIfEmpty: true });
  } catch (e) {
    // The picture is made, paid for and on the row. The page not getting it is
    // worth saying and is not worth failing the poll over.
    notes.push(`The picture was made, but could not be put on the buyer's page `
      + `(${(e as Error).message}).`);
  }
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

  // Same rule as a drawn still: the buyer's page wears the first picture made
  // for them. A video's opening frame is a real photograph of that buyer's
  // situation, and a page with nothing at the top of it is worse than a page
  // whose hero is the frame the ad opened on.
  try {
    await putOnLandingPage({ ideaId: asset.ad_idea_id, onlyIfEmpty: true });
  } catch {
    // Non-fatal, and the video submit below is the important half of this
    // function. The page simply keeps whatever it had.
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

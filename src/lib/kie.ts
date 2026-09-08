/**
 * KIE.ai — the only place in this app that spends money.
 *
 * Two rules govern everything here and both are written from having got them
 * wrong elsewhere:
 *
 * 1. ONE createTask PER ASSET, EVER. A rejected submit (422) is free. An
 *    accepted one (200) BILLS IMMEDIATELY and generates whether or not anybody
 *    is still listening for the answer. So nothing in this module retries a
 *    submit, and the caller writes the task id to the database before it does
 *    anything else with it — a crash between the submit and the write is a
 *    charge with no record, which is the one failure that cannot be cleaned up
 *    afterwards.
 *
 * 2. THE PRICE IS ESTIMATED BEFORE AND MEASURED AFTER. The estimate exists to
 *    enforce the campaign ceiling, which has to happen before the spend. KIE
 *    reports what it actually charged on the finished task, and that number —
 *    not ours — is what the ledger ends up holding.
 */

const BASE = 'https://api.kie.ai';

/** KIE bills in credits. This is the conversion its own dashboard uses. */
export const USD_PER_CREDIT = 0.005;

export const IMAGE_MODEL = 'google/nano-banana-edit';
export const VIDEO_MODEL = 'bytedance/seedance-2-fast';

/**
 * Credit prices, and where they came from.
 *
 * KIE publishes these on the model's market page rather than in its OpenAPI
 * spec, so they are not fetchable from the docs endpoint and are written down
 * here instead. Both were read off the model pages and both are pinned with a
 * comment, because a hard-coded price that drifts is how an app quietly
 * overspends a ceiling it believes it is enforcing.
 *
 * THE VIDEO ROW MATTERS. KIE prices every video model on two rows — "with
 * video input" and "no video input" — and image-to-video is the NO-VIDEO-INPUT
 * row, which is the more expensive one. Reading the cheap row is a mistake
 * already made twice on this machine.
 */
export const IMAGE_CREDITS = 4;             // nano-banana-edit, per image
export const VIDEO_CREDITS_PER_SECOND = 24.8; // seedance-2-fast, 720p, no video input

export function usd(credits: number): number {
  return Math.round(credits * USD_PER_CREDIT * 100) / 100;
}

export function imageCost() {
  return { credits: IMAGE_CREDITS, usd: usd(IMAGE_CREDITS) };
}

export function videoCost(seconds: number) {
  const credits = Math.ceil(seconds * VIDEO_CREDITS_PER_SECOND);
  return { credits, usd: usd(credits) };
}

function key(): string {
  const value = process.env.KIE_API_KEY;
  if (!value) throw new Error('KIE_API_KEY is not set — nothing can be generated');
  return value;
}

/**
 * Meta's own recommended shapes, and the reason each idea carries one.
 *
 * A feed static at 4:5 takes more vertical space in the feed than a square and
 * is the shape Meta itself recommends for single-image ads. Video goes 9:16
 * because a video ad that is not full-screen on a phone is competing with
 * Reels while wearing letterboxing.
 */
export const IMAGE_ASPECT = '4:5';
export const VIDEO_ASPECT = '9:16';

/**
 * How long a generated video ad runs.
 *
 * ONE CLIP, not three. The original plan was a three-clip storyboard cut
 * together, and cutting requires ffmpeg, which a serverless function does not
 * have — that is a second piece of infrastructure (a container that joins
 * files) and it is not what was asked for. A single continuous ten-second shot
 * built from the seller's own photograph is a real, postable Meta video ad,
 * and it needs no joining. The storyboard beats are still written and still
 * shown; they shape the one prompt instead of becoming three files.
 */
export const VIDEO_SECONDS = 10;

export type SubmitResult = { taskId: string };

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`KIE returned ${res.status} and something that was not JSON: ${text.slice(0, 300)}`);
  }
  // KIE answers 200 at the HTTP layer and puts the real outcome in `code`, so
  // checking res.ok alone would treat a rejected task as a submitted one — and
  // a submitted one is the expensive case to be wrong about.
  const code = Number(json.code ?? res.status);
  if (code !== 200) {
    throw new Error(`KIE refused the task (${code}): ${String(json.msg ?? 'no reason given')}`);
  }
  return json;
}

/**
 * Submit one image edit. Returns the task id, which the caller must persist
 * before doing anything else — this call has already been billed by the time
 * it returns.
 */
export async function submitImage(input: {
  prompt: string;
  /** The seller's own photograph. Must be reachable by KIE, not by us. */
  imageUrl: string;
}): Promise<SubmitResult> {
  const json = await post('/api/v1/jobs/createTask', {
    model: IMAGE_MODEL,
    input: {
      prompt: input.prompt.slice(0, 5000),
      image_urls: [input.imageUrl],
      output_format: 'png',
      aspect_ratio: IMAGE_ASPECT,
    },
  });
  const taskId = (json.data as { taskId?: string } | undefined)?.taskId;
  if (!taskId) throw new Error('KIE accepted the image task but returned no task id');
  return { taskId };
}

/** Submit one video. Same warning as submitImage: this bills on return. */
export async function submitVideo(input: {
  prompt: string;
  firstFrameUrl: string;
  seconds?: number;
}): Promise<SubmitResult> {
  const json = await post('/api/v1/jobs/createTask', {
    model: VIDEO_MODEL,
    input: {
      prompt: input.prompt.slice(0, 20000),
      first_frame_url: input.firstFrameUrl,
      // Silent on purpose. A Meta feed video autoplays muted, so generated
      // audio is paid for and never heard — and generated speech in an ad for
      // somebody else's product is a claim nobody wrote.
      generate_audio: false,
      resolution: '720p',
      aspect_ratio: VIDEO_ASPECT,
      duration: input.seconds ?? VIDEO_SECONDS,
    },
  });
  const taskId = (json.data as { taskId?: string } | undefined)?.taskId;
  if (!taskId) throw new Error('KIE accepted the video task but returned no task id');
  return { taskId };
}

export type TaskState = 'waiting' | 'generating' | 'success' | 'fail';

export type TaskStatus = {
  state: TaskState;
  /** Present only on success. */
  urls: string[];
  /** Present only on failure. */
  failMessage: string | null;
  /** What KIE actually billed. Null until the task finishes. */
  creditsConsumed: number | null;
};

/** Poll one task. Free, and safe to call as often as makes sense. */
export async function taskStatus(taskId: string): Promise<TaskStatus> {
  const res = await fetch(
    `${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
    { headers: { Authorization: `Bearer ${key()}` }, signal: AbortSignal.timeout(30_000) },
  );
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`KIE returned ${res.status} and something that was not JSON: ${text.slice(0, 300)}`);
  }
  const code = Number(json.code ?? res.status);
  if (code !== 200) {
    throw new Error(`Could not read the task (${code}): ${String(json.msg ?? 'no reason given')}`);
  }

  const data = (json.data ?? {}) as {
    state?: string;
    resultJson?: unknown;
    failMsg?: string | null;
    creditsConsumed?: number | null;
  };

  // `resultJson` is a JSON STRING, not an object — a nested encoding that is
  // easy to miss and produces `undefined` rather than an error when missed.
  let urls: string[] = [];
  if (typeof data.resultJson === 'string' && data.resultJson.trim()) {
    try {
      const parsed = JSON.parse(data.resultJson) as { resultUrls?: unknown };
      if (Array.isArray(parsed.resultUrls)) {
        urls = parsed.resultUrls.filter((u): u is string => typeof u === 'string');
      }
    } catch {
      urls = [];
    }
  } else if (data.resultJson && typeof data.resultJson === 'object') {
    const parsed = data.resultJson as { resultUrls?: unknown };
    if (Array.isArray(parsed.resultUrls)) {
      urls = parsed.resultUrls.filter((u): u is string => typeof u === 'string');
    }
  }

  const state = (['waiting', 'generating', 'success', 'fail'] as const)
    .find((s) => s === data.state) ?? 'generating';

  return {
    state,
    urls,
    failMessage: data.failMsg ?? null,
    creditsConsumed: typeof data.creditsConsumed === 'number' ? data.creditsConsumed : null,
  };
}

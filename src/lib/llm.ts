import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';

/**
 * One place for every model call in the pipeline.
 *
 * Four decisions worth stating, because they are not obvious from the code:
 *
 * 1. STRUCTURED OUTPUTS, NOT "reply with JSON". Every call goes through
 *    `responses.parse()` with a Zod schema, so the model is constrained to the
 *    shape and the SDK validates before we ever see it. A prompt that asks for
 *    JSON produces a fence, an apology or a trailing comma often enough to
 *    matter across 20 personas.
 *
 * 2. NON-STREAMING, DELIBERATELY. Streaming exists to dodge HTTP timeouts on
 *    long outputs. Every call here is capped well under that, because the
 *    pipeline is split into small units (one base page, five personas) rather
 *    than one enormous generation. That split is what lets a stage run inside a
 *    serverless function's time limit and be retried on its own.
 *
 * 3. THE PRODUCT BRIEF IS CACHED, BUT NOTHING HERE ASKS FOR IT. OpenAI caches
 *    on exact prompt prefix automatically once a prompt passes ~1024 tokens —
 *    there is no cache_control marker to set and no cache write to pay for.
 *    All this module has to do is keep the stable text at the FRONT: role and
 *    rules, then the brief, then the part that varies. That ordering is the
 *    entire caching strategy, which is why `cachedContext` is still its own
 *    parameter rather than being concatenated by callers.
 *
 * 4. `maxTokens` IS A CONTENT BUDGET, NOT THE API'S CAP. On a reasoning model
 *    `max_output_tokens` covers reasoning AND the answer, so passing a caller's
 *    content budget straight through would truncate mid-object on any call
 *    that thought hard first. We add a reasoning allowance on top instead, so
 *    `maxTokens: 16000` still means "sixteen thousand tokens of JSON".
 */

/**
 * NOT called OPENAI_MODEL. That name is already used by Codex and other agent
 * harnesses, which set it to internal aliases the public API rejects. Running
 * this app from a shell that had one exported would silently retarget every
 * call. Own the name instead.
 */
const MODEL = process.env.AD_ASSIST_MODEL ?? 'gpt-5.5';

/**
 * Headroom for reasoning tokens, which share `max_output_tokens` with the
 * answer. Generous on purpose: unused budget costs nothing, an exhausted one
 * throws away a whole stage.
 */
const REASONING_HEADROOM = 24000;

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set — the pipeline cannot generate anything');
    }
    // A project-scoped key (`sk-proj-…`) already carries its project, so no
    // extra header is needed. An org key that belongs to several projects does
    // need one, and naming it here means either kind of key works.
    const project = process.env.OPENAI_PROJECT_ID;
    _client = new OpenAI(project ? { project } : {});
  }
  return _client;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * The pipeline's vocabulary has five levels; the API has four. The two top
 * levels collapse rather than being rejected, so a caller asking for more
 * thinking than the model sells gets the most it sells.
 */
const EFFORT: Record<Effort, 'low' | 'medium' | 'high'> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

export type GenerateOptions<S extends z.ZodType> = {
  /** Role and rules. Stable across calls of the same kind, so it caches. */
  system: string;
  /** The product brief. Identical across every call in a campaign — cached. */
  cachedContext?: string;
  /** The part that changes per call. */
  prompt: string;
  /**
   * Pictures to put in front of the model, in order. Sent at `detail: 'low'`,
   * which is a fixed ~85 tokens each rather than a tiling cost that scales with
   * resolution: every use here is "say what this photograph shows and whether it
   * illustrates a claim", and that judgement does not need the full-size tiles.
   */
  images?: string[];
  schema: S;
  maxTokens?: number;
  effort?: Effort;
};

export type GenerateResult<S extends z.ZodType> = {
  data: z.infer<S>;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

export async function generate<S extends z.ZodType>(
  opts: GenerateOptions<S>,
): Promise<GenerateResult<S>> {
  const maxContent = opts.maxTokens ?? 16000;

  // Instructions are sent ahead of the input, so everything stable lives here
  // and the cacheable prefix forms itself.
  const instructions = opts.cachedContext
    ? `${opts.system}\n\n${opts.cachedContext}`
    : opts.system;

  // Text first, pictures after, in the order the caller listed them. Prompts
  // that refer to "IMAGE 0, IMAGE 1, …" depend on that ordering being the same
  // ordering the model receives, so it is fixed here rather than left to a
  // caller to get right.
  const content: OpenAI.Responses.ResponseInputContent[] = [
    { type: 'input_text', text: opts.prompt },
    ...(opts.images ?? []).map((url) => ({
      type: 'input_image' as const, image_url: url, detail: 'low' as const,
    })),
  ];

  const response = await client().responses.parse({
    model: MODEL,
    instructions,
    input: [{ role: 'user', content }],
    reasoning: { effort: EFFORT[opts.effort ?? 'high'] },
    max_output_tokens: maxContent + REASONING_HEADROOM,
    text: { format: zodTextFormat(opts.schema, 'result') },
  });

  // A refusal is a successful HTTP call with no usable content. Checking for it
  // first means we fail with the reason rather than a null deref.
  const refusal = response.output
    .flatMap((item) => (item.type === 'message' ? item.content : []))
    .find((part) => part.type === 'refusal');
  if (refusal) {
    throw new Error(
      `The model declined this request (${refusal.refusal}). Nothing was generated.`,
    );
  }
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason ?? 'unknown';
    throw new Error(
      `Generation stopped early (${reason}; content budget ${maxContent} tokens `
      + `plus ${REASONING_HEADROOM} for reasoning). The response was cut off, `
      + 'so it was discarded rather than half-saved.',
    );
  }
  if (!response.output_parsed) {
    throw new Error('The model returned nothing that matched the schema');
  }

  const usage = response.usage;
  return {
    // The SDK infers the parsed type through its own alias, which TypeScript
    // cannot prove equals `z.infer<S>` while S is still generic. Same type,
    // narrowed by the same schema — the assertion is the proof.
    data: response.output_parsed as z.infer<S>,
    usage: {
      input: usage?.input_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
      // Reads are reported; writes are not, because OpenAI does not charge for
      // them. Reporting 0 keeps the shape callers already log.
      cacheRead: usage?.input_tokens_details?.cached_tokens ?? 0,
      cacheWrite: 0,
    },
  };
}

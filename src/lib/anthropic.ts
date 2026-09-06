import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

/**
 * One place for every Claude call in the pipeline.
 *
 * Three decisions worth stating, because they are not obvious from the code:
 *
 * 1. STRUCTURED OUTPUTS, NOT "reply with JSON". Every call goes through
 *    `messages.parse()` with a Zod schema, so the model is constrained to the
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
 * 3. THE PRODUCT BRIEF IS CACHED. It is identical across the base page and all
 *    four persona batches, and it sits at the front of the prompt, so it is
 *    marked cacheable. Below roughly 512 tokens nothing caches and the marker
 *    is simply ignored — no error, no cost.
 */

/**
 * NOT called ANTHROPIC_MODEL. That name is already used by Claude Code and other
 * agent harnesses, which set it to internal aliases like "opus[1m]" that the
 * public API rejects. Running this app from a shell that had one exported would
 * silently retarget every call. Own the name instead.
 */
const MODEL = process.env.AD_ASSIST_MODEL ?? 'claude-opus-5';

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set — the pipeline cannot generate anything');
    }
    // An org-scoped key (the default when you create one outside a workspace)
    // is rejected on every endpoint unless the workspace is named in a header.
    // Supporting it here means either kind of key works.
    const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
    _client = new Anthropic(
      workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {},
    );
  }
  return _client;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type GenerateOptions<S extends z.ZodType> = {
  /** Role and rules. Stable across calls of the same kind, so it caches. */
  system: string;
  /** The product brief. Identical across every call in a campaign — cached. */
  cachedContext?: string;
  /** The part that changes per call. */
  prompt: string;
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
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: opts.system }];
  if (opts.cachedContext) {
    // The breakpoint goes on the LAST system block, which caches everything
    // before it — role, rules and brief together.
    system.push({
      type: 'text',
      text: opts.cachedContext,
      cache_control: { type: 'ephemeral' },
    });
  } else {
    system[0].cache_control = { type: 'ephemeral' };
  }

  const message = await client().messages.parse({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 16000,
    system,
    output_config: {
      format: zodOutputFormat(opts.schema),
      effort: opts.effort ?? 'high',
    },
    messages: [{ role: 'user', content: opts.prompt }],
  });

  // A refusal is a successful HTTP call with no usable content. Checking
  // stop_reason first means we fail with the reason rather than a null deref.
  if (message.stop_reason === 'refusal') {
    throw new Error(
      `Claude declined this request (${message.stop_details?.category ?? 'no category'}). `
      + 'Nothing was generated.',
    );
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error(
      `Ran out of output tokens (max_tokens ${opts.maxTokens ?? 16000}). `
      + 'The response was cut off, so it was discarded rather than half-saved.',
    );
  }
  if (!message.parsed_output) {
    throw new Error('Claude returned nothing that matched the schema');
  }

  return {
    data: message.parsed_output,
    usage: {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

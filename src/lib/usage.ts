import { AsyncLocalStorage } from 'node:async_hooks';
import { serviceClient } from '@/lib/supabase';

export const usageContext = new AsyncLocalStorage<{ campaignId: string; stage: string }>();

export async function recordModelUsage(input: {
  responseId: string; model: string; input: number; cached: number; output: number; status: string;
}) {
  const context = usageContext.getStore();
  // Standard API prices checked against OpenAI's GPT-5.5 model page.
  // An override without a verified rate stays unknown rather than showing $0.
  const knownRate = /^gpt-5\.5(?:-\d{4}-\d{2}-\d{2})?$/.test(input.model);
  const longContext = input.input > 272000;
  const estimate = knownRate
    ? ((input.input - input.cached) * 5 * (longContext ? 2 : 1)
      + input.cached * 0.5 * (longContext ? 2 : 1)
      + input.output * 30 * (longContext ? 1.5 : 1)) / 1_000_000 : null;
  const row = {
    response_id: input.responseId, campaign_id: context?.campaignId ?? null,
    stage: context?.stage ?? 'unassigned', model: input.model,
    input_tokens: input.input, cached_tokens: input.cached, output_tokens: input.output,
    estimated_usd: estimate, response_status: input.status,
  };
  // No prompts, credentials or product text in operational logs. Keep the usage
  // event even if the database migration has not been deployed or is unavailable.
  console.info('model_usage', JSON.stringify(row));
  try {
    const { error } = await serviceClient().from('model_usage').upsert(row, { onConflict: 'response_id' });
    if (error) console.error('model_usage_persistence_failed', input.responseId);
  } catch { console.error('model_usage_persistence_failed', input.responseId); }
}

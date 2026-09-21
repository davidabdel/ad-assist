import { dispatchBackground } from '../background-jobs';

export function canContinue(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const state = result as Record<string, unknown>;
  // `done` means pages built, not necessarily that ad research has finished.
  return state.terminal === false && state.waiting === false && !state.awaitingApproval;
}

export async function continueCampaign(campaignId: string, userId: string, authorization: string) {
  if (process.env.ADTOCART_AUTORUN_MODE !== 'netlify') return;
  const origin = process.env.ADTOCART_NETLIFY_ORIGIN;
  if (!origin) throw new Error('Campaign continuation is not configured');
  // Match the UI's bodyless advance request, so its next call reuses this job.
  return dispatchBackground(new Request(new URL(`/api/campaigns/${campaignId}/advance`, origin), {
    method: 'POST', headers: { authorization, 'Content-Type': 'application/json' },
  }), userId);
}

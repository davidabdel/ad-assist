import { serviceClient } from '../supabase';

/** Only work belonging to the campaign whose owner initiated advance is sent. */
export async function dispatchScannerJobs(campaignId: string, authorization: string | null) {
  if (process.env.ADTOCART_SCANNER_MODE !== 'netlify') return;
  const secret = process.env.CRON_SECRET;
  const configured = process.env.ADTOCART_NETLIFY_ORIGIN;
  if (!secret || !configured || !authorization) throw new Error('Scanner is not configured');
  const origin = new URL(configured).origin;
  if (!origin.startsWith('https://')) throw new Error('Invalid scanner destination');
  const db = serviceClient();
  // A killed function no longer heartbeats. Only recover this customer's jobs.
  const stale = await db.from('scanner_jobs').select('id,attempts').eq('campaign_id', campaignId)
    .eq('status', 'running').lt('heartbeat_at', new Date(Date.now() - 5 * 60_000).toISOString());
  if (stale.error) throw stale.error;
  for (const job of stale.data ?? []) {
    const recovered = await db.from('scanner_jobs').update({
      status: job.attempts >= 3 ? 'failed' : 'queued', claimed_by: null, claimed_at: null,
      heartbeat_at: null, error_message: 'Scanner stopped responding. Please retry the scan.',
    }).eq('id', job.id).eq('status', 'running')
      .lt('heartbeat_at', new Date(Date.now() - 5 * 60_000).toISOString());
    if (recovered.error) throw recovered.error;
  }
  const running = await db.from('scanner_jobs').select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId).eq('status', 'running');
  if (running.error) throw running.error;
  const capacity = Math.max(0, 2 - (running.count ?? 0));
  if (!capacity) return;
  const { data, error } = await db.from('scanner_jobs').select('id').eq('campaign_id', campaignId)
    .eq('status', 'queued').lt('attempts', 3).order('created_at').limit(capacity);
  if (error) throw error;
  for (const job of data ?? []) {
    const response = await fetch(new URL('/.netlify/functions/scanner-background', origin), {
      method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id, authorization }), signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 202) throw new Error('Scanner could not start. Please retry.');
  }
}

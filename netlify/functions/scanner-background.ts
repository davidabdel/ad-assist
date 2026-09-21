import { randomUUID, timingSafeEqual } from 'node:crypto';
import { requireCampaignOwner, requireOwner } from '../../src/lib/auth';
import { serviceClient } from '../../src/lib/supabase';
import { launchServerlessBrowser } from '../../src/lib/scanner/serverless-browser';
import { publicUrl } from '../../src/lib/ingest/public-fetch';
import { continueCampaign } from '../../src/lib/scanner/continuation';
import { withHostedBrowser } from '../../scanner/src/browser.js';
import { runIngest, runAdScan } from '../../scanner/src/jobs.js';

export default async function handler(req: Request) {
  const expected = process.env.CRON_SECRET;
  const offered = req.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!expected || !offered || Buffer.byteLength(offered) !== Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(offered), Buffer.from(expected))) return;
  const { jobId, authorization } = await req.json();
  if (typeof jobId !== 'string' || typeof authorization !== 'string') return;
  const owner = await requireOwner(new Request('https://internal.invalid', { headers: { authorization } }));
  const db = serviceClient();
  const lookup = await db.from('scanner_jobs').select('*').eq('id', jobId).maybeSingle();
  if (lookup.error) throw lookup.error;
  const job = lookup.data;
  if (!job || job.status !== 'queued' || job.attempts >= 3) return;
  const campaign = await requireCampaignOwner(owner, job.campaign_id);
  if (campaign.archived_at) return;
  const worker = `netlify-${randomUUID()}`;
  const claimed = await db.from('scanner_jobs').update({
    status: 'running', claimed_by: worker, attempts: job.attempts + 1,
    claimed_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
  }).eq('id', job.id).eq('status', 'queued').eq('attempts', job.attempts).select('id').maybeSingle();
  if (claimed.error) throw claimed.error;
  if (!claimed.data) return;
  const heartbeat = setInterval(() => {
    void (async () => {
      const updated = await db.from('scanner_jobs').update({ heartbeat_at: new Date().toISOString() })
        .eq('id', job.id).eq('claimed_by', worker).eq('status', 'running');
      if (updated.error) console.error('Scanner heartbeat could not be saved');
    })().catch(() => console.error('Scanner heartbeat unavailable'));
  }, 30_000);
  let runtime: Awaited<ReturnType<typeof launchServerlessBrowser>> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    let result;
    if (campaign.is_drill) {
      result = { items_found: 0, items_qualified: 0, notes: 'Drill completed without a browser scan' };
    } else {
      if (job.kind === 'ingest') publicUrl(job.target_url);
      runtime = await launchServerlessBrowser();
      const active = runtime;
      deadline = setTimeout(() => { void active.close().catch(() => {}); }, 12 * 60_000);
      result = await withHostedBrowser(runtime.browser, () => job.kind === 'ingest'
        ? runIngest(db, job) : runAdScan(db, job));
    }
    const saved = await db.from('scanner_jobs').update({
      status: 'completed', items_found: result.items_found, items_qualified: result.items_qualified,
      notes: result.notes, error_message: null, completed_at: new Date().toISOString(),
    }).eq('id', job.id).eq('claimed_by', worker).eq('status', 'running');
    if (saved.error) throw saved.error;
  } catch (error) {
    const failed = await db.from('scanner_jobs').update({
      status: job.attempts + 1 >= 3 ? 'failed' : 'queued', claimed_by: null, claimed_at: null,
      heartbeat_at: null, error_message: 'The browser scan could not finish. Please retry the scan.',
    }).eq('id', job.id).eq('claimed_by', worker).eq('status', 'running');
    if (failed.error) throw failed.error;
    console.error('Browser scan failed', { jobId: job.id, error: error instanceof Error ? error.message : 'Unknown failure' });
  } finally {
    clearInterval(heartbeat);
    if (deadline) clearTimeout(deadline);
    await runtime?.close().catch(() => {});
  }
  // This resumes only the campaign that authorized this scan; it never drains
  // other accounts or existing owner drafts like a global polling cron would.
  await continueCampaign(job.campaign_id, owner.id, authorization);
}
export const config = { background: true };

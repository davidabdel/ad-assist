import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { serviceClient } from '@/lib/supabase';

export const backgroundExecution = new AsyncLocalStorage<boolean>();

/** Only server-side calls in the background context bypass dispatch. */
export async function dispatchBackground(req: Request, userId: string): Promise<Response | null> {
  if (process.env.ADTOCART_BACKGROUND_MODE !== 'netlify' || backgroundExecution.getStore()) return null;
  const secret = process.env.CRON_SECRET;
  const site = process.env.ADTOCART_NETLIFY_ORIGIN;
  if (!secret || !site) throw new Error('Background processing is not configured');
  // Never derive a secret-bearing destination from an incoming Host header.
  const origin = new URL(site).origin;
  if (!origin.startsWith('https://')) throw new Error('Invalid background destination');
  const path = new URL(req.url).pathname;
  if (!/^\/api\/campaigns\/[a-f0-9-]{36}\/(advance|assets|ideas\/[a-f0-9-]{36})$/i.test(path)) throw new Error('Unsupported background operation');
  const body = await req.clone().text();
  if (body.length > 30000) return Response.json({error:'Request too large'}, {status:413});
  const fingerprint = createHash('sha256').update(path+'\n'+body).digest('hex');
  const db = serviceClient();
  // A stale attempt may have reached its provider; do not automatically repeat it.
  const {error: staleError} = await db.from('background_jobs').update({state:'failed',http_status:504,result:{error:'Background work timed out. Review campaign status before retrying.'},finished_at:new Date().toISOString()})
    .eq('user_id',userId).eq('fingerprint',fingerprint).in('state',['queued','running']).lt('created_at',new Date(Date.now()-16*60_000).toISOString());
  if(staleError) throw staleError;
  const inserted = await db.from('background_jobs').insert({user_id:userId,fingerprint,path,body}).select('id').single();
  let id = inserted.data?.id;
  if (inserted.error) {
    if (inserted.error.code !== '23505') throw inserted.error;
    const existing = await db.from('background_jobs').select('id').eq('user_id',userId).eq('fingerprint',fingerprint).in('state',['queued','running']).single();
    if(existing.error) throw existing.error;
    id=existing.data.id;
  } else {
    // Netlify returns 202 after accepting the payload. Keep the JWT in transit only.
    try {
      const sent=await fetch(new URL('/.netlify/functions/campaign-background',origin),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify({id,authorization:req.headers.get('authorization')}),signal:AbortSignal.timeout(10000)});
      if(sent.status!==202) throw new Error('Could not start background work');
    } catch {
      // Delivery may have succeeded despite a lost acknowledgement. Keep the
      // unique job queued so retries cannot submit a second paid operation.
      return Response.json({jobId:id}, {status:202});
    }
  }
  return Response.json({jobId:id}, {status:202});
}

import { requireOwner, AuthError } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}) {
 try {
  const owner=await requireOwner(req);const {id}=await params;
  const {data,error}=await serviceClient().from('background_jobs').select('state,result,http_status,created_at').eq('id',id).eq('user_id',owner.id).maybeSingle();
  if(error)throw error;
  if(!data)return Response.json({error:'No such operation'}, {status:404});
  if(['queued','running'].includes(data.state)&&Date.now()-new Date(data.created_at).getTime()>16*60_000)return Response.json({state:'failed',http_status:504,result:{error:'Background work timed out. Review campaign status before retrying.'}});
  return Response.json(data,{headers:{'Cache-Control':'no-store'}});
 }catch(e){return Response.json({error:e instanceof Error?e.message:'Unable to read operation'},{status:e instanceof AuthError?e.status:500});}
}

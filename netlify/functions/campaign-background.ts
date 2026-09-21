import { timingSafeEqual } from 'node:crypto';
import { backgroundExecution } from '../../src/lib/background-jobs';
import { requireOwner } from '../../src/lib/auth';
import { serviceClient } from '../../src/lib/supabase';
import { POST as advance } from '../../src/app/api/campaigns/[id]/advance/route';
import { POST as assets } from '../../src/app/api/campaigns/[id]/assets/route';
import { POST as idea } from '../../src/app/api/campaigns/[id]/ideas/[ideaId]/route';
import { canContinue, continueCampaign } from '../../src/lib/scanner/continuation';

export default async function handler(req:Request) {
 const expected=process.env.CRON_SECRET;const offered=req.headers.get('authorization')?.replace(/^Bearer /,'');
 if(!expected||!offered||Buffer.byteLength(offered)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(offered),Buffer.from(expected)))return new Response(null,{status:401});
 const {id,authorization}=await req.json();
 if(typeof id!=='string'||typeof authorization!=='string')return new Response(null,{status:400});
 const db=serviceClient();
 const lookup=await db.from('background_jobs').select('*').eq('id',id).single();
 if(lookup.error)throw lookup.error;
 const job=lookup.data;
 if(job.state!=='queued')return;
 const owner=await requireOwner(new Request('https://internal.invalid',{headers:{authorization}}));
 if(owner.id!==job.user_id)return new Response(null,{status:403});
 const matched=job.path.match(/^\/api\/campaigns\/([a-f0-9-]{36})\/(advance|assets|ideas\/([a-f0-9-]{36}))$/i);
 if(!matched)throw new Error('Invalid operation path');
 const claimed=await db.from('background_jobs').update({state:'running'}).eq('id',id).eq('state','queued').select('id').maybeSingle();
 if(claimed.error)throw claimed.error;
 if(!claimed.data)return;
 let result;let status=500;
 try {
  const request=new Request(new URL(job.path,process.env.ADTOCART_NETLIFY_ORIGIN),{method:'POST',headers:{authorization,'Content-Type':'application/json'},body:job.body||undefined});
  const response=await backgroundExecution.run(true,()=>matched[2]==='advance'?advance(request,{params:Promise.resolve({id:matched[1]})}):matched[2]==='assets'?assets(request,{params:Promise.resolve({id:matched[1]})}):idea(request,{params:Promise.resolve({id:matched[1],ideaId:matched[3]})}));
  status=response.status;result=await response.json();
 }catch{result={error:'Background work failed. Review the campaign before retrying.'};}
 const saved=await db.from('background_jobs').update({state:status<400?'completed':'failed',http_status:status,result,finished_at:new Date().toISOString()}).eq('id',id);
 if(saved.error)throw saved.error;
 if(matched[2]==='advance' && status===200 && canContinue(result)) {
  await continueCampaign(matched[1],owner.id,authorization);
 }
}
// The suffix also declares background mode for CLI versions predating config.background.
export const config={background:true};

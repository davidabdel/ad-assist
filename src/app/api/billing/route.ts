import { requireOwner, AuthError } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';
export async function GET(req: Request) {
 try {
  const owner=await requireOwner(req),db=serviceClient();
  const {data:account,error}=await db.from('admin_account_rollup').select('plan,status,mrr_usd,period_end,builds_limit,builds_used,images_limit,images_used,video_balance,active_products,products_limit,cancel_at_period_end').eq('id',owner.id).single();
  if(error)throw error;
  const {data:campaigns,error:campaignError}=await db.from('campaigns').select('id,title,archived_at,status').eq('user_id',owner.id).order('created_at',{ascending:false}).limit(100);
  if(campaignError)throw campaignError;
  return Response.json({account,campaigns},{headers:{'Cache-Control':'no-store'}});
 }catch(e){return Response.json({error:e instanceof AuthError?e.message:'Billing information is unavailable'},{status:e instanceof AuthError?e.status:503});}
}

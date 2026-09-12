import { requireOwner, requireCampaignOwner, AuthError } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';
import { revalidatePath } from 'next/cache';
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const {id}=await params,owner=await requireOwner(req),c=await requireCampaignOwner(owner,id),db=serviceClient();
  const {data:lock,error:lockError}=await db.rpc('claim_persona_batch',{p_campaign:id});
  if(lockError||!lock)throw new Error('Campaign is busy. Try again after generation finishes.');
  try{
   const {data:fresh,error}=await db.from('campaigns').select('status').eq('id',id).single();
   if(error||!['base_review','ideas_ready','completed','failed'].includes(fresh.status))throw new Error('Wait until this campaign stops working before archiving.');
   const {error:saveError}=await db.from('campaigns').update({archived_at:new Date().toISOString()}).eq('id',id);
   if(saveError)throw saveError;
   revalidatePath(`/p/${c.slug}`);revalidatePath('/p/[campaignSlug]/[personaSlug]','page');
   return Response.json({ok:true});
  }finally{await db.rpc('release_persona_batch',{p_campaign:id});}
 }catch(e){return Response.json({error:e instanceof Error?e.message:'Could not archive'},{status:e instanceof AuthError?e.status:409});}
}

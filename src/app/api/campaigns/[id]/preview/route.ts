import { requireOwner, requireCampaignOwner, AuthError } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){
 try{const {id}=await params,owner=await requireOwner(req),c=await requireCampaignOwner(owner,id);
 const {data,error}=await serviceClient().rpc('get_public_page_internal',{campaign_slug:c.slug,persona_slug:null});
 if(error)throw error;return Response.json({page:data},{headers:{'Cache-Control':'no-store'}});
 }catch(e){return Response.json({error:e instanceof AuthError?e.message:'Preview unavailable'},{status:e instanceof AuthError?e.status:503});}
}

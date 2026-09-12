import { serviceClient } from '@/lib/supabase';
import { usageContext } from '@/lib/usage';
export async function reserveResource(resource: 'text'|'image'|'video', units: number) {
  const campaignId = usageContext.getStore()?.campaignId;
  if (!campaignId) throw new Error('Generation needs an account-owned campaign context');
  const { data, error } = await serviceClient().rpc('reserve_saas_resource', { p_campaign: campaignId, p_resource: resource, p_units: units });
  if (error) throw new Error(error.message);
  return data as string;
}
export async function settleResource(id: string, release: boolean, actual?: number) {
  const { error } = await serviceClient().rpc('settle_saas_resource', { p_id: id, p_release: release, p_actual: actual ?? null });
  if (error) throw new Error('Could not reconcile the usage reservation');
}
export async function requirePaidCampaign(campaignId: string) {
  const db = serviceClient();
  const { data: campaign, error } = await db.from('campaigns').select('user_id,archived_at').eq('id',campaignId).single();
  if (error || campaign.archived_at) throw new Error('Campaign unavailable');
  const { data: account, error: accountError } = await db.from('billing_accounts').select('status,period_end').eq('user_id',campaign.user_id).single();
  if (accountError || account.status !== 'active' || new Date(account.period_end) <= new Date()) throw new Error('Choose an active plan in Plans and billing to continue');
}

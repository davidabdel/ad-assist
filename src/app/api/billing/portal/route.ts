import { requireOwner, AuthError } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';
import { stripe, sameOrigin, siteOrigin } from '@/lib/billing/stripe';
export async function POST(req: Request) {
  try {
    sameOrigin(req); const owner = await requireOwner(req);
    const { data, error } = await serviceClient().from('billing_accounts').select('customer_id').eq('user_id', owner.id).single();
    if (error || !data.customer_id) throw new Error('There is no billing account to manage yet');
    const configuration = process.env.STRIPE_PORTAL_CONFIGURATION;
    if (!configuration) throw new Error('The AdtoCart billing portal is not configured yet');
    return Response.json(await stripe('billing_portal/sessions', { customer: data.customer_id, configuration, return_url: `${siteOrigin()}/billing` }));
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Billing unavailable' }, { status: e instanceof AuthError ? e.status : 400 }); }
}

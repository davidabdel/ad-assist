import { randomUUID } from 'node:crypto';
import { requireOwner, AuthError } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';
import { isPlan } from '@/lib/billing/plans';
import { stripe, sameOrigin, siteOrigin, priceId } from '@/lib/billing/stripe';
export async function POST(req: Request) {
  try {
    sameOrigin(req);
    const owner = await requireOwner(req);
    const { plan, requestId } = await req.json();
    if(typeof requestId!=='string' || !/^[a-f0-9-]{36}$/i.test(requestId)) return Response.json({error:'Invalid checkout request'}, {status:400});
    if (!isPlan(plan) && plan !== 'video') return Response.json({ error: 'Choose a plan' }, { status: 400 });
    const price = priceId(plan);
    const db = serviceClient();
    const { data: lock, error } = await db.rpc('claim_checkout', { p_user: owner.id });
    if (error) throw error;
    if (!lock) return Response.json({ error: 'A checkout is already opening. Please wait a moment.' }, { status: 409 });
    try {
      const { data: a, error: readError } = await db.from('billing_accounts').select('*').eq('user_id', owner.id).single();
      if (readError) throw readError;
      if (plan === 'video' && (a.status !== 'active' || new Date(a.period_end) <= new Date())) throw new Error('Choose an active subscription before buying video credits');
      if (plan !== 'video' && ['active', 'past_due', 'trialing', 'incomplete'].includes(a.status)) throw new Error('Manage your existing subscription through the billing portal');
      if (plan !== 'video' && a.checkout_url && new Date(a.checkout_expires_at) > new Date()) return Response.json({ url: a.checkout_url });
      let customer = a.customer_id;
      if (!customer) {
        const result = await stripe<{ id: string }>('customers', { email: owner.email, 'metadata[user_id]': owner.id }, `customer:${owner.id}`);
        customer = result.id;
        const { error: saveError } = await db.from('billing_accounts').update({ customer_id: customer }).eq('user_id', owner.id);
        if (saveError) throw saveError;
      }
      let attempt = a.checkout_attempt;
      if (plan !== 'video') {
        if (a.checkout_plan && a.checkout_plan !== plan && !a.checkout_expires_at) throw new Error('A previous checkout is awaiting confirmation. Retry the same plan.');
        if (a.checkout_expires_at && new Date(a.checkout_expires_at) <= new Date()) attempt = randomUUID();
        const { error: attemptError } = await db.from('billing_accounts').update({ checkout_attempt: attempt, checkout_plan: plan }).eq('user_id',owner.id);
        if(attemptError)throw attemptError;
      }
      const origin = siteOrigin();
      const session = await stripe<{ url: string; expires_at: number }>('checkout/sessions', {
        mode: plan === 'video' ? 'payment' : 'subscription', customer,
        'line_items[0][price]': price, 'line_items[0][quantity]': '1', client_reference_id: owner.id,
        'metadata[user_id]': owner.id, 'metadata[kind]': plan === 'video' ? 'video_pack' : 'subscription',
        ...(plan !== 'video' ? { 'subscription_data[metadata][user_id]': owner.id } : {}),
        success_url: `${origin}/billing?checkout=success`, cancel_url: `${origin}/billing`,
      }, plan === 'video' ? `video-checkout:${owner.id}:${requestId}` : `subscription-checkout:${attempt}`);
      if (plan !== 'video') {
        const { error: saveError } = await db.from('billing_accounts').update({ checkout_url: session.url, checkout_expires_at: new Date(session.expires_at * 1000).toISOString() }).eq('user_id', owner.id);
        if (saveError) throw saveError;
      }
      return Response.json({ url: session.url });
    } finally { await db.from('billing_accounts').update({ checkout_lock_until: null }).eq('user_id', owner.id); }
  } catch (e) { return Response.json({ error: e instanceof AuthError ? e.message : e instanceof Error ? e.message : 'Billing unavailable' }, { status: e instanceof AuthError ? e.status : 400 }); }
}

import { randomUUID } from 'node:crypto';
import { serviceClient } from '@/lib/supabase';
import { stripe, verifyStripeSignature, subscriptionSnapshot, type Subscription, priceId } from '@/lib/billing/stripe';
export const runtime = 'nodejs';
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: 'Not configured' }, { status: 503 });
  const body = await req.text();
  if (body.length > 1000000 || !verifyStripeSignature(body, req.headers.get('stripe-signature'), secret)) return Response.json({ error: 'Invalid signature' }, { status: 400 });
  try {
    const event = JSON.parse(body);
    const obj = event.data.object;
    const db = serviceClient();
    const { data: already, error: lookupError } = await db.from('billing_events').select('id').eq('id', event.id).maybeSingle();
    if (lookupError) throw lookupError;
    if (already) return Response.json({ received: true });
    if (event.type.startsWith('customer.subscription.')) {
      const { data: account, error } = await db.from('billing_accounts').select('user_id').eq('customer_id', obj.customer).single();
      if (error) throw error;
      const { data: lock, error: lockError } = await db.rpc('claim_billing_sync',{p_user:account.user_id});
      if(lockError||!lock)throw new Error('Subscription sync is busy; retry');
      try {
        // Serialize provider retrieval too: concurrent old responses cannot
        // overwrite the latest subscription snapshot within the same second.
        const sub = await stripe<Subscription>(`subscriptions/${encodeURIComponent(obj.id)}`);
        const { error: applyError } = await db.rpc('apply_subscription', { p_event: event.id, p_created: event.created, p_user: account.user_id, p_data: subscriptionSnapshot(sub) });
        if (applyError) throw applyError;
        if(['active','canceled','unpaid'].includes(sub.status)) await db.from('billing_accounts').update({checkout_plan:null,checkout_attempt:randomUUID()}).eq('user_id',account.user_id);
      } finally { await db.from('billing_accounts').update({sync_lock_until:null}).eq('user_id',account.user_id); }
    } else if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type) && obj.mode === 'payment' && obj.metadata?.kind === 'video_pack') {
      const session = await stripe<{ payment_status: string; currency: string; amount_total: number; customer: string; line_items: { data: { price: { id: string }; quantity: number }[] } }>(`checkout/sessions/${encodeURIComponent(obj.id)}?expand[]=line_items`);
      if (session.payment_status !== 'paid') return Response.json({ received: true });
      if (session.currency !== 'usd' || session.amount_total !== 5900 || session.line_items.data.length !== 1 || session.line_items.data[0].price.id !== priceId('video') || session.line_items.data[0].quantity !== 1) throw new Error('Unexpected credit purchase');
      const { data: account, error } = await db.from('billing_accounts').select('user_id').eq('customer_id', session.customer).single();
      if (error) throw error;
      const { error: applyError } = await db.rpc('apply_video_purchase', { p_event: event.id, p_created: event.created, p_session: obj.id, p_user: account.user_id, p_amount: 59 });
      if (applyError) throw applyError;
    } else if (['refund.created','refund.updated','refund.failed'].includes(event.type)) {
      const refund = await stripe<{id:string;charge:string;payment_intent:string;amount:number;currency:string;status:string;created:number}>(`refunds/${encodeURIComponent(obj.id)}`);
      if(refund.currency!=='usd' || !refund.charge) throw new Error('Unsupported refund');
      const charge = await stripe<{customer:string}>(`charges/${encodeURIComponent(refund.charge)}`);
      const {data:account,error}=await db.from('billing_accounts').select('user_id').eq('customer_id',charge.customer).single();
      if(error)throw error;
      // Locate the original purchase even when a refund event arrives first.
      const sessions=await stripe<{data:{id:string;metadata:Record<string,string>}[]}>(`checkout/sessions?payment_intent=${encodeURIComponent(refund.payment_intent)}&limit=100`);
      const pack=sessions.data.find(s=>s.metadata?.kind==='video_pack');
      let paymentId:string|undefined=pack?.id;
      if(!paymentId){
        const payments=await stripe<{data:{invoice:string}[]}>(`invoice_payments?payment[type]=payment_intent&payment[payment_intent]=${encodeURIComponent(refund.payment_intent)}&limit=100`);
        paymentId=payments.data[0]?.invoice;
      }
      if(!paymentId)throw new Error('Original payment needs reconciliation');
      const {data:payment,error:paymentError}=await db.from('billing_payments').select('provider_id').eq('provider_id',paymentId).eq('user_id',account.user_id).maybeSingle();
      if(paymentError||!payment)throw new Error('Original payment has not arrived yet; retry refund');
      const {error:applyError}=await db.rpc('apply_refund',{p_id:refund.id,p_user:account.user_id,p_payment:paymentId,p_amount:refund.amount/100,p_status:refund.status,p_time:new Date(refund.created*1000).toISOString()});
      if(applyError)throw applyError;
    } else if (event.type === 'invoice.paid') {
      const invoice = await stripe<{ id: string; customer: string; currency: string; amount_paid: number; status: string; status_transitions: { paid_at: number } }>(`invoices/${encodeURIComponent(obj.id)}`);
      if (invoice.status !== 'paid' || invoice.currency !== 'usd') throw new Error('Unsupported invoice');
      const { data: account, error } = await db.from('billing_accounts').select('user_id').eq('customer_id', invoice.customer).single();
      if (error) throw error;
      const { error: writeError } = await db.from('billing_payments').upsert({ provider_id: invoice.id, user_id: account.user_id, kind: 'subscription', amount_usd: invoice.amount_paid / 100, paid_at: new Date(invoice.status_transitions.paid_at * 1000).toISOString() }, { onConflict: 'provider_id', ignoreDuplicates: true });
      if (writeError) throw writeError;
      const { error: eventError } = await db.from('billing_events').insert({ id: event.id, user_id: account.user_id, kind: event.type, provider_created: event.created });
      if (eventError && eventError.code !== '23505') throw eventError;
    }
    return Response.json({ received: true });
  } catch { console.error('billing_webhook_processing_failed'); return Response.json({ error: 'Webhook could not be processed; retry required' }, { status: 500 }); }
}

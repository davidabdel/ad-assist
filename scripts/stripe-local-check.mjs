// Actual Stripe test objects with signed local webhook replay; not hosted delivery.
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
export async function checkStripe({config,secret,origin,token,user,svc,request}) {
 assert.ok(config.STRIPE_SECRET_KEY.startsWith('sk_test_'));
 async function stripe(path,fields,method=fields?'POST':'GET'){
  const r=await fetch('https://api.stripe.com/v1/'+path,{method,headers:{Authorization:`Bearer ${config.STRIPE_SECRET_KEY}`,'Stripe-Version':'2025-04-30.basil',...(fields?{'Content-Type':'application/x-www-form-urlencoded'}:{})},body:fields?new URLSearchParams(fields):undefined,signal:AbortSignal.timeout(20000)});
  const data=await r.json();assert.ok(r.ok,`${r.status}: ${data.error?.message}`);if('livemode' in data)assert.equal(data.livemode,false);return data;
 }
 async function replay(type,object,id='evt_local_'+randomUUID()){
  const body=JSON.stringify({id,type,created:Math.floor(Date.now()/1000),livemode:false,data:{object}}),t=Math.floor(Date.now()/1000);
  const signature=createHmac('sha256',secret).update(`${t}.${body}`).digest('hex');
  const r=await fetch(origin+'/api/billing/webhook',{method:'POST',headers:{'stripe-signature':`t=${t},v1=${signature}`},body});
  assert.equal(r.status,200,await r.text());return id;
 }
 let customer,subscription;
 try {
  const checkoutBody={plan:'starter',requestId:randomUUID()};
  const checkout=await request('/api/billing/checkout',token,checkoutBody);assert.equal(checkout.status,200,await checkout.clone().text());
  const first=await checkout.json();assert.ok(first.url.startsWith('https://checkout.stripe.com/'));
  const again=await request('/api/billing/checkout',token,checkoutBody);assert.equal((await again.json()).url,first.url);
  const account=await svc.from('billing_accounts').select('*').eq('user_id',user).single();assert.ifError(account.error);customer=account.data.customer_id;
  const sessions=await stripe(`checkout/sessions?customer=${customer}&limit=10`);assert.equal(sessions.data.length,1);
  assert.equal(sessions.data[0].success_url,origin+'/billing?checkout=success');
  assert.notEqual(account.data.status,'active','Checkout creation must not grant access');
  await stripe(`checkout/sessions/${sessions.data[0].id}/expire`,{});
  console.log('PASS actual Stripe checkout creation, retry idempotency and no premature entitlement');
  const card=await stripe(`payment_methods/pm_card_visa/attach`,{customer});
  await stripe(`customers/${customer}`,{'invoice_settings[default_payment_method]':card.id});
  subscription=await stripe('subscriptions',{customer,'items[0][price]':config.STRIPE_PRICE_STARTER,'metadata[user_id]':user});
  assert.equal(subscription.status,'active');
  const event=await replay('customer.subscription.created',subscription);await replay('customer.subscription.created',subscription,event);
  const paid=await svc.from('billing_accounts').select('*').eq('user_id',user).single();assert.ifError(paid.error);assert.equal(paid.data.plan,'starter');assert.equal(Number(paid.data.mrr_usd),149);
  const invoice=await stripe(`invoices/${subscription.latest_invoice}`);await replay('invoice.paid',invoice);await replay('invoice.paid',invoice);
  const payments=await svc.from('billing_payments').select('*').eq('user_id',user);assert.ifError(payments.error);assert.equal(payments.data.length,1);assert.equal(Number(payments.data[0].amount_usd),149);
  const portal=await request('/api/billing/portal',token,{});assert.equal(portal.status,200,await portal.clone().text());assert.equal((await portal.json()).configuration,config.STRIPE_PORTAL_CONFIGURATION);
  console.log('PASS paid subscription, duplicate webhook reconciliation, invoice amount and dedicated portal');
  const invoicePayments=await stripe(`invoice_payments?invoice=${invoice.id}&limit=10`);
  const intent=invoicePayments.data.find(p=>p.payment?.type==='payment_intent')?.payment.payment_intent;
  assert.ok(intent,'Paid invoice exposes its payment intent');
  const refund=await stripe('refunds',{payment_intent:intent,amount:'14900'});
  await replay('refund.created',refund);await replay('refund.updated',refund);
  const refunded=await svc.from('billing_payments').select('*').eq('provider_id',invoice.id).single();assert.ifError(refunded.error);
  assert.equal(Number(refunded.data.refunded_usd),149);
  console.log('PASS actual test refund and duplicate refund reconciliation');

  const updated=await stripe(`subscriptions/${subscription.id}`,{'items[0][id]':subscription.items.data[0].id,'items[0][price]':config.STRIPE_PRICE_GROWTH,proration_behavior:'none'});
  await replay('customer.subscription.updated',updated);
  const growth=await svc.from('billing_accounts').select('plan,mrr_usd').eq('user_id',user).single();assert.equal(growth.data.plan,'growth');assert.equal(Number(growth.data.mrr_usd),499);
  const pending=await stripe(`subscriptions/${subscription.id}`,{cancel_at_period_end:'true'});await replay('customer.subscription.updated',pending);
  const grace=await svc.from('billing_accounts').select('status,cancel_at_period_end').eq('user_id',user).single();assert.equal(grace.data.status,'active');assert.equal(grace.data.cancel_at_period_end,true);
  const canceled=await stripe(`subscriptions/${subscription.id}`,null,'DELETE');await replay('customer.subscription.deleted',canceled);
  const ended=await svc.from('billing_accounts').select('status,mrr_usd').eq('user_id',user).single();assert.equal(ended.data.status,'canceled');assert.equal(Number(ended.data.mrr_usd),0);
  console.log('PASS plan changes, scheduled cancellation and final cancellation synchronization');
 } finally {if(customer)await stripe(`customers/${customer}`,null,'DELETE');}
}

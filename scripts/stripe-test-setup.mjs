// Configure only test-mode AdtoCart objects; never modifies live billing.
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const key=readFileSync('.scratch/stripe-test-key','utf8').trim();
assert.ok(key.startsWith('sk_test_'),'Only a test secret is accepted');
async function stripe(path,fields,idem){
 const r=await fetch(`https://api.stripe.com/v1/${path}`,{method:fields?'POST':'GET',headers:{Authorization:`Bearer ${key}`,'Stripe-Version':'2025-04-30.basil',...(fields?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(idem?{'Idempotency-Key':idem}:{})},body:fields?new URLSearchParams(fields):undefined,signal:AbortSignal.timeout(20000)});
 const data=await r.json();if(!r.ok)throw new Error(`${r.status}: ${data.error?.message??'Stripe request failed'}`);return data;
}
const account=await stripe('account');assert.equal(account.id,'acct_1SE1MRGkDjIcIDlQ','Unexpected Stripe account');
const prices={};
for(const [plan,amount] of [['starter',14900],['growth',49900],['agency',149900],['video',5900]]){
 const lookup=`adtocart_${plan}_usd_v1`;
 const found=await stripe(`prices?lookup_keys[]=${lookup}&limit=10`);
 let price=found.data[0];
 if(!price){
 const product=await stripe('products',{name:`AdtoCart ${plan==='video'?'10 Video Credits':plan[0].toUpperCase()+plan.slice(1)}`,'metadata[app]':'adtocart','metadata[plan]':plan},`adtocart-test-product-${plan}-v1`);
 price=await stripe('prices',{product:product.id,currency:'usd',unit_amount:String(amount),lookup_key:lookup,'metadata[app]':'adtocart',...(plan!=='video'?{'recurring[interval]':'month'}:{})},`adtocart-test-price-${plan}-v1`);
 }
 assert.equal(price.livemode,false);assert.equal(price.currency,'usd');assert.equal(price.unit_amount,amount);assert.equal(price.active,true);
 assert.equal(price.recurring?.interval??null,plan==='video'?null:'month');
 prices[plan]=price;
 console.log(`Verified test price: ${plan} $${amount/100} USD ${plan==='video'?'one-time':'monthly'}`);
}
// Keep this product's portal separate from other apps sharing the Stripe account.
const configs=await stripe('billing_portal/configurations?limit=100');
let portal=configs.data.find(x=>x.metadata?.app==='adtocart');
if(!portal){
const fields={'business_profile[headline]':'Manage your AdtoCart subscription','metadata[app]':'adtocart','features[payment_method_update][enabled]':'true','features[invoice_history][enabled]':'true','features[subscription_cancel][enabled]':'true','features[subscription_cancel][mode]':'at_period_end','features[subscription_update][enabled]':'true','features[subscription_update][default_allowed_updates][0]':'price','features[subscription_update][proration_behavior]':'always_invoice'};
for(const [i,plan] of ['starter','growth','agency'].entries()) {fields[`features[subscription_update][products][${i}][product]`]=prices[plan].product;fields[`features[subscription_update][products][${i}][prices][0]`]=prices[plan].id;}
portal=await stripe('billing_portal/configurations',fields,'adtocart-test-portal-v1');
}
assert.equal(portal.livemode,false);
const config={STRIPE_SECRET_KEY:key,STRIPE_PORTAL_CONFIGURATION:portal.id,...Object.fromEntries(Object.entries(prices).map(([p,v])=>[`STRIPE_PRICE_${p.toUpperCase()}`,v.id]))};
writeFileSync('.scratch/stripe-test-config.json',JSON.stringify(config,null,2),{mode:0o600});
console.log('Test catalog and dedicated customer portal configured; credentials saved only in ignored local storage.');

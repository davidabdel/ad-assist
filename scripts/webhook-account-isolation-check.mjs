import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=ts.transpileModule(readFileSync('src/app/api/billing/webhook/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
async function check(type,dbFailure=false,linked=false){
 const writes=[];const providerCalls=[];
 const db={from(table){return {select(){return this},eq(){return this},async maybeSingle(){return {data:table==='billing_accounts'&&linked?{user_id:'owner'}:null,error:dbFailure&&table==='billing_accounts'?new Error('db unavailable'):null}},upsert(){writes.push(table);throw Error('Unexpected write')},insert(){writes.push(table);throw Error('Unexpected write')}}},rpc(){writes.push('rpc');throw Error('Unexpected write')}};
 const exports={};const context={exports,Response,console:{error(){}},process:{env:{STRIPE_WEBHOOK_SECRET:'test'}},require(name){if(name==='node:crypto')return {randomUUID:()=> 'unused'};if(name==='@/lib/supabase')return {serviceClient:()=>db};if(name==='@/lib/billing/stripe')return {verifyStripeSignature:()=>true,stripe:async path=>{providerCalls.push(path);if(path.startsWith('refunds/'))return {id:'re_other',charge:'ch_other',currency:'aud'};if(path.startsWith('charges/'))return {customer:'cus_other'};if(path.startsWith('invoices/'))return {id:'in_other',customer:'cus_other',currency:'aud',status:'paid'};throw Error('Unexpected provider call')}};throw Error(name)}};
 vm.runInNewContext(source,context);
 const response=await exports.POST(new Request('https://example.test/api/billing/webhook',{method:'POST',body:JSON.stringify({id:'evt_other',type,created:1,data:{object:{id:type.startsWith('refund')?'re_other':'in_other',customer:'cus_other'}}})}));
 assert.equal(response.status,dbFailure||linked?500:200,type);
 assert.deepEqual(writes,[],'Unrelated events must never write entitlements or revenue');
}
for(const type of ['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','refund.created','refund.updated','refund.failed']){await check(type);await check(type,true);}
await check('invoice.paid',false,true);await check('refund.created',false,true);
console.log('PASS unrelated shared-account events ignored; database failures retry; linked-account currency validation preserved.');

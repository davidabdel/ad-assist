import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=(await readFile('src/lib/scanner/continuation.ts','utf8')).replace("import { dispatchBackground } from '../background-jobs';",'const dispatchBackground = async (request, userId) => ({ path: new URL(request.url).pathname, body: await request.text(), userId });');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {canContinue,continueCampaign}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
assert.equal(canContinue({status:'pages_built',done:true,terminal:false,waiting:false}),true);
for(const result of [null,{}, {terminal:true,waiting:false},{terminal:false,waiting:true},{terminal:false,waiting:false,awaitingApproval:true}])assert.equal(canContinue(result),false);
const oldMode=process.env.ADTOCART_AUTORUN_MODE,oldOrigin=process.env.ADTOCART_NETLIFY_ORIGIN;
try{
 delete process.env.ADTOCART_AUTORUN_MODE;assert.equal(await continueCampaign('campaign','owner','token'),undefined);
 process.env.ADTOCART_AUTORUN_MODE='netlify';process.env.ADTOCART_NETLIFY_ORIGIN='https://example.test';
 const queued=await continueCampaign('campaign','owner','token');assert.deepEqual(queued,{path:'/api/campaigns/campaign/advance',body:'',userId:'owner'});
}finally{for(const [key,value] of [['ADTOCART_AUTORUN_MODE',oldMode],['ADTOCART_NETLIFY_ORIGIN',oldOrigin]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
console.log('PASS continuation stops at approvals, waiting, and terminal states; body matches UI deduplication');

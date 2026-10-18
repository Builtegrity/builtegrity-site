import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {refundPdfLines,buildRefundPdf} from '../worker/src/pdf.js';
import {handleMerchantRefundPdf,loadMerchantRefundEvidence} from '../worker/src/merchant-refund-pdf.js';
import {merchantDashboardSlug,ensureMerchantDashboardUrl,merchantAdoptionMetrics}
  from '../worker/src/merchant-dashboard-adoption.js';
import {accountlessTransactionProjection} from '../worker/src/merchant-record-links.js';
import {handleMerchantEmailAccess} from '../worker/src/merchant-record-access.js';

const filename=join(mkdtempSync(join(tmpdir(),'bg-refund-auth-')),'testing.db');
const literal=v=>v===null||v===undefined?'NULL':typeof v==='number'?String(v):
  "'"+String(v).replaceAll("'","''")+"'";
function sqlRun(sql,rows=false){
 const out=execFileSync('sqlite3',[...(rows?['-json']:[]),filename],{
  encoding:'utf8',input:'PRAGMA foreign_keys=ON;\n'+sql+'\n'});
 return rows?JSON.parse(out.trim()||'[]'):out.trim();
}
for(const name of readdirSync('migrations').filter(p=>p.endsWith('.sql')).sort()){
 sqlRun(readFileSync('migrations/'+name,'utf8'));
 if(name.startsWith('0009_'))
  sqlRun(readFileSync('transaction-engine/seed-tx-0001.sql','utf8'));
}
const db={prepare:sql=>({bind(...args){
 let index=0;
 const rendered=sql.replace(/\?/g,()=>literal(args[index++]));
 assert.equal(index,args.length,'Query binds must match SQL placeholders');
 return {first:async()=>sqlRun(rendered,true)[0]||null,
  all:async()=>({results:sqlRun(rendered,true)}),
  run:async()=>{sqlRun(rendered);return {success:true}}};
}})};
const env={DB:db,APP_BASE_URL:'https://builtegrity.com'};
sqlRun("INSERT INTO transaction_financial_adjustments"+
 "(id,transaction_id,merchant_id,processor,adjustment_type,direction,amount_cents,currency,"+
 "processor_event_id,processor_object_id,adjustment_at) VALUES"+
 "('ADJ-REFUND-0001','TX-0001','MER-0001','STRIPE','REFUND','MERCHANT_OUTFLOW',"+
 "20000,'USD','evt_refund_test','re_test_0001','2026-10-18T11:00:00Z')");
const stripe=await loadMerchantRefundEvidence(env,'ADJ-REFUND-0001');
assert(stripe);
assert.equal(stripe.status,'COMPLETED');
assert.equal(stripe.amount_cents,20000);
assert.equal(stripe.processor_ref,'re_test_0001');
const fakeOriginal={id:'TX-0001',merchant_name:'RR',customer_name:'West Bay HOA',
 amount_cents:130000,merchant_payment_reference:'RR-OCT-2026',
 currency:'USD',refunded_cents:20000};
const lines=refundPdfLines(stripe,fakeOriginal);
assert(lines.some(x=>x.includes('20'+'.00 USD')));
assert(lines.some(x=>x.includes('COMPLETED')));
assert(lines.some(x=>x.includes('re_test_0001')));
const pdf=buildRefundPdf(stripe,fakeOriginal);
assert.equal(new TextDecoder().decode(pdf.slice(0,8)),'%PDF-1.4');
assert(new TextDecoder().decode(pdf).includes('REFUND'));
assert.throws(()=>refundPdfLines(stripe,{id:'TX-UNRELATED'}),/must match/);
const square={refund_id:'refund_1000',transaction_id:'TX-0001',merchant_id:'MER-0001',
 processor:'SQUARE',status:'PENDING',amount_cents:6500,currency:'USD',
 merchant_name:'Receptacle Rollers',processor_ref:'refund_1000',
 processor_payment_id:'payment_555',app_fee_refunded_cents:1,
 occurred_at:'2026-10-18T12:00:00Z'};
const squareLines=refundPdfLines(square,fakeOriginal).join('\n');
assert(squareLines.includes('NOT A COMPLETED REFUND'));
assert(squareLines.includes('Square payment ID: payment_555'));
assert(squareLines.includes('65.00 USD')===false,'Amount is 65.00, not 6500 dollars');
assert(squareLines.includes('Refund amount: 65.00 USD'));
const stranger=await handleMerchantRefundPdf(new Request('https://builtegrity.com/api/merchant/refunds/ADJ-REFUND-0001/pdf'),env);
assert.equal(stranger.status,401,'Accountless viewers cannot fetch a refund PDF');
const tokenOnly=await handleMerchantEmailAccess(new Request('https://builtegrity.com/api/merchant/record-link/pdf',{
 method:'POST',headers:{'content-type':'application/json'},
 body:JSON.stringify({token:'0'.repeat(64)})}),env);
assert.notEqual(tokenOnly.status,200,'A link token alone must not retrieve a PDF');
const record=accountlessTransactionProjection({id:'TX-0001',merchant_name:'RR',processor:'STRIPE',
 amount_cents:130000,customer_name:'Private Customer',merchant_payment_reference:'RR-REF',
 integrity_status:'ACCOUNTED',payment_status:'PAID',bank_evidence:{secret:true}});
for(const sensitive of ['amount_cents','customer_name','merchant_payment_reference','bank_evidence'])
 assert(!Object.hasOwn(record,sensitive),'Accountless view exposes '+sensitive);

assert.equal(merchantDashboardSlug('Receptacle Rollers','MER-0001'),
 'receptacle-rollers-mer0001');
const path=await ensureMerchantDashboardUrl(env,'MER-0001','Receptacle Rollers');
assert.equal(path,'/dashboard/receptacle-rollers-mer0001/');
assert.equal(await ensureMerchantDashboardUrl(env,'MER-0001','Changed Trade Name'),path,
  'Existing merchant dashboard path must stay stable even when the business renames');
let result=await merchantAdoptionMetrics(env);
assert.equal(Number(result.eligible_merchants),1);
assert.equal(Number(result.merchants_without_profiles),1);
assert.equal(Number(result.merchants_with_profiles),0);
assert.equal(result.accountless_percent,100);
sqlRun("INSERT INTO merchant_access(id,merchant_id,external_user_id,role,status) VALUES"+
 "('MAC-OWNER-TEST','MER-0001','clerk_test_user','OWNER','ACTIVE')");
result=await merchantAdoptionMetrics(env);
assert.equal(Number(result.merchants_with_profiles),1);
assert.equal(Number(result.merchants_without_profiles),0);
assert.equal(result.profile_adoption_percent,100);
sqlRun("INSERT INTO merchant_transaction_email_links(transaction_id,merchant_id,recipient_email,"+
 "token_sha256,expires_at,email_state,opened_at,open_count) VALUES"+
 "('TX-0001','MER-0001','owner@example.com','"+'b'.repeat(64)+"',"+
 "datetime('now','+5 days'),'SENT',CURRENT_TIMESTAMP,3)");
result=await merchantAdoptionMetrics(env);
assert.equal(Number(result.opened_transaction_links),1);
assert.equal(Number(result.total_link_views),3);

const endpoints=readFileSync('worker/src/records.js','utf8');
assert(endpoints.includes('handleMerchantRefundPdf'));
const html=readFileSync('public/merchant/record/index.html','utf8');
assert(!html.includes('id="download"'),'Email link must not have a PDF button');
const recordApp=readFileSync('public/merchant/record/app.js','utf8');
assert(!recordApp.includes("api('pdf')"),'Email link client must not call PDF API');
const refundsUi=readFileSync('public/merchant/transactions/app.js','utf8');
assert(refundsUi.includes('refundPdfPath(refund.refund_id'));
assert(refundsUi.includes('navigator.share'));
const runtime=readFileSync('worker/src/runtime.js','utf8');
assert(runtime.includes('await requireOperator(request,env)'));
assert(runtime.includes('merchantAdoptionMetrics'));
console.log('Refund-specific PDF, auth-only access, sanitized status link, stable dashboard paths and adoption metrics: PASS');

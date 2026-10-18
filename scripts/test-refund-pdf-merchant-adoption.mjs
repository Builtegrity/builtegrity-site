import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildRefundPdf,refundPdfLines} from '../worker/src/pdf.js';
import {loadMerchantRefundEvidence,handleMerchantRefundPdf} from '../worker/src/merchant-refund-pdf.js';
import {merchantDashboardSlug,ensureMerchantDashboardUrl,merchantAdoptionMetrics,handleVanityMerchantDashboard} from '../worker/src/merchant-dashboard-adoption.js';
import {accountlessTransactionProjection,sha256} from '../worker/src/merchant-record-links.js';
import {handleMerchantEmailAccess} from '../worker/src/merchant-record-access.js';

const file=join(mkdtempSync(join(tmpdir(),'bg-refund-auth-')),'db.sqlite');
function q(v){return v===undefined||v===null?'NULL':typeof v==='number'?String(v):
 "'"+String(v).replaceAll("'","''")+"'";
}
function sql(stmt,rows=false){
 const x=execFileSync('sqlite3',[...(rows?['-json']:[]),file],{
  input:'PRAGMA foreign_keys=ON;\n'+stmt+'\n',encoding:'utf8'});
 return rows?JSON.parse(x.trim()||'[]'):x.trim();
}
for(const name of readdirSync('migrations').filter(x=>x.endsWith('.sql')).sort()){
 sql(readFileSync('migrations/'+name,'utf8'));
 if(name.startsWith('0009_'))sql(readFileSync('transaction-engine/seed-tx-0001.sql','utf8'));
}
const env={DB:{prepare:s=>{
 const bind=(...args)=>{let idx=0;
  const value=s.replace(/\?/g,()=>q(args[idx++]));
  assert.equal(idx,args.length);
  return {first:async()=>sql(value,true)[0]||null,
   all:async()=>({results:sql(value,true)}),
   run:async()=>{sql(value);return {success:true}}};
 };
 return {bind,first:async()=>bind().first(),all:async()=>bind().all(),
  run:async()=>bind().run()};
}}};
sql("INSERT INTO transaction_financial_adjustments"+
 "(id,transaction_id,merchant_id,processor,adjustment_type,direction,"+
 "amount_cents,currency,processor_event_id,processor_object_id,adjustment_at)"+
 "VALUES('REF-DEMO-ST-01','TX-0001','MER-0001','STRIPE','REFUND',"+
 "'MERCHANT_OUTFLOW',6500,'USD','evt_refund_test','re_test_refund',"+
 "'2026-10-18T14:00:00Z')");
const stripe=await loadMerchantRefundEvidence(env,'REF-DEMO-ST-01');
assert.equal(stripe.transaction_id,'TX-0001');
assert.equal(stripe.amount_cents,6500);
assert.equal(stripe.processor,'STRIPE');
const transaction={
 id:'TX-0001',processor:'STRIPE',merchant_name:'Receptacle Rollers',
 customer_name:'West Bay HOA',merchant_payment_reference:'RR-HOA-2026-10',
 amount_cents:130000,currency:'USD',refunded_cents:6500
};
const lines=refundPdfLines(stripe,transaction).join('\n');
assert.match(lines,/REFUND COMPLETED/);
assert.match(lines,/65\.00 USD/);
assert.match(lines,/re_test_refund/);
assert.match(lines,/West Bay HOA/);
assert.match(lines,/TX-0001/);
assert(!lines.includes('Irreversibly settled'));
assert.throws(()=>refundPdfLines(stripe,{id:'TX-another'}),/must match/);
const pdf=buildRefundPdf(stripe,transaction);
assert.equal(new TextDecoder().decode(pdf.slice(0,8)),'%PDF-1.4');
assert(pdf.length>500);
const pending={...stripe,refund_id:'REF-SQUARE-PENDING',processor:'SQUARE',
 processor_ref:'sq-refund',status:'PENDING',app_fee_refunded_cents:0,
 processor_payment_id:'sq-payment',observed_at:'2026-10-18T12:00:00Z'};
const sqLines=refundPdfLines(pending,transaction).join('\n');
assert.match(sqLines,/PENDING - NOT A COMPLETED REFUND/);
assert.match(sqLines,/Square payment ID: sq-payment/);
const unauth=await handleMerchantRefundPdf(new Request('https://builtegrity.com/api/merchant/refunds/REF-DEMO-ST-01/pdf'),env);
assert.equal(unauth.status,401);
assert(!new TextDecoder().decode(new Uint8Array(await unauth.arrayBuffer())).includes('re_test_refund'));
const missing=await handleMerchantRefundPdf(new Request('https://builtegrity.com/api/merchant/refunds/BAD/pdf'),env);
assert.equal(missing.status,401,'No record existence disclosure to unauthenticated requests');

const anon=accountlessTransactionProjection({id:'TX-0001',
 merchant_name:'RR',processor:'STRIPE',amount_cents:130000,customer_name:'Secret',
 merchant_payment_reference:'secret_ref',bank_evidence:{a:1},
 integrity_status:'ACCOUNTED'});
for(const hidden of ['amount_cents','customer_name','merchant_payment_reference','bank_evidence'])
 assert.equal(anon[hidden],undefined,'No sensitive '+hidden+' in private link');
assert.equal(anon.transaction_id,'TX-0001');
const source=readFileSync('worker/src/merchant-record-access.js','utf8');
assert.match(source,/record-link\/pdf/);
assert.match(source,/require.*merchant account|verified merchant account/i);
assert(!source.includes("serveTransactionPdf("),'Email bearer link must not generate PDF');
const html=readFileSync('public/merchant/record/index.html','utf8');
assert(!html.includes('id="download"'),'No accountless PDF control');
const client=readFileSync('public/merchant/record/app.js','utf8');
assert(!client.includes("api('pdf')"));

const slug=merchantDashboardSlug('Receptacle Rollers','MER-0001');
assert.match(slug,/^receptacle-rollers-mer0001$/);
assert.equal(await ensureMerchantDashboardUrl(env,'MER-0001','Receptacle Rollers'),'/dashboard/'+slug+'/');
assert.equal(await ensureMerchantDashboardUrl(env,'MER-0001','Receptacle Rollers'),'/dashboard/'+slug+'/');
const other=await handleVanityMerchantDashboard(new Request('https://builtegrity.com/dashboard/random-merchant/'),env);
assert.equal(other.status,404);
const signedOut=await handleVanityMerchantDashboard(new Request('https://builtegrity.com/dashboard/'+slug+'/'),env);
assert.equal(signedOut.status,302,'Vanity path is never the authentication factor');
assert.match(signedOut.headers.get('location'),/\/login\//);
const metrics=await merchantAdoptionMetrics(env);
assert(Number(metrics.eligible_merchants)>=1);
assert.equal(Number(metrics.merchants_without_profiles),Number(metrics.eligible_merchants),
 'Seed merchant has no linked merchant account');
assert.equal(metrics.profile_adoption_percent,0);
assert.equal(metrics.accountless_percent,100);
assert.equal(Number(metrics.refund_pdf_downloads),0);

const ui=readFileSync('public/merchant/transactions/app.js','utf8');
assert.match(ui,/\/api\/merchant\/refunds\//);
assert.match(ui,/Download refund PDF/);
assert.match(ui,/Share PDF/);
const home=readFileSync('public/merchant/index.html','utf8');
assert.match(home,/dashboardLink/);
console.log('Authenticated refund PDF, Square pending status, accountless secrecy, per-merchant URLs and profile conversion metrics: PASS');

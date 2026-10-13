import { generateQuarterlyPaymentSummary, getQuarterlyPaymentSummary } from './quarterly-tax-documents.js';
import { generateYearEndPaymentSummary, getYearEndPaymentSummary } from './year-end.js';
import { buildTaxDocumentPdf } from './tax-document-pdf.js';
import { previousCompletedQuarter } from './tax-periods.js';

export async function generateDueMerchantTaxDocuments(env, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid tax document clock');
  const completed = previousCompletedQuarter(now);
  const merchants = await eligibleMerchants(env);
  let quarterlyCreated = 0;
  let annualCreated = 0;
  let exported = 0;

  for (const merchant of merchants) {
    let quarterly = await latestQuarterly(env, merchant.id, completed.year, completed.quarter);
    if (!quarterly) {
      quarterly = await generateQuarterlyPaymentSummary(env, merchant.id, completed.year, completed.quarter, 'USD');
      quarterlyCreated += 1;
    } else {
      quarterly = await getQuarterlyPaymentSummary(env, quarterly.id);
    }
    exported += await ensureExport(env, 'QUARTERLY_PAYMENT_ACTIVITY', quarterly, merchant, `${completed.year}-Q${completed.quarter}`);

    if (now.getUTCMonth() === 0) {
      const year = now.getUTCFullYear() - 1;
      let annual = await latestAnnual(env, merchant.id, year);
      if (!annual) {
        annual = await generateYearEndPaymentSummary(env, merchant.id, year, 'USD');
        annualCreated += 1;
      } else {
        annual = await getYearEndPaymentSummary(env, annual.id);
      }
      exported += await ensureExport(env, 'YEAR_END_PAYMENT_ACTIVITY', annual, merchant, String(year));
    }
  }
  return { merchants: merchants.length, quarterly_created: quarterlyCreated, annual_created: annualCreated, exports_created: exported };
}

export async function ensureMissingExports(env, limit = 100) {
  const quarterlies = await env.DB.prepare(`
    SELECT q.id,q.merchant_id,q.tax_year,q.quarter,m.name,m.email,m.statement_email
      FROM quarterly_payment_summaries q JOIN merchants m ON m.id=q.merchant_id
     WHERE q.generated_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM tax_document_exports e WHERE e.document_kind='QUARTERLY_PAYMENT_ACTIVITY' AND e.source_id=q.id)
     ORDER BY q.tax_year,q.quarter,q.merchant_id LIMIT ?
  `).bind(limit).all();
  const annuals = await env.DB.prepare(`
    SELECT y.id,y.merchant_id,y.tax_year,m.name,m.email,m.statement_email
      FROM year_end_payment_summaries y JOIN merchants m ON m.id=y.merchant_id
     WHERE y.generated_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM tax_document_exports e WHERE e.document_kind='YEAR_END_PAYMENT_ACTIVITY' AND e.source_id=y.id)
     ORDER BY y.tax_year,y.merchant_id LIMIT ?
  `).bind(limit).all();
  let created=0;
  for(const row of quarterlies.results||[]){const doc=await getQuarterlyPaymentSummary(env,row.id);created+=await ensureExport(env,'QUARTERLY_PAYMENT_ACTIVITY',doc,row,`${row.tax_year}-Q${row.quarter}`);}
  for(const row of annuals.results||[]){const doc=await getYearEndPaymentSummary(env,row.id);created+=await ensureExport(env,'YEAR_END_PAYMENT_ACTIVITY',doc,row,String(row.tax_year));}
  return { created };
}

async function ensureExport(env, kind, document, merchant, periodLabel) {
  if (!document) return 0;
  const existing=await env.DB.prepare(`SELECT id FROM tax_document_exports WHERE document_kind=? AND source_id=?`).bind(kind,document.id).first();
  if(existing) return 0;
  if(!env.TRANSACTION_RECORDS) throw new Error('TRANSACTION_RECORDS binding required for tax document exports');
  const bytes=buildTaxDocumentPdf({ ...document, merchant_name:merchant.name });
  const hash=await sha256Hex(bytes);
  const folder=kind==='QUARTERLY_PAYMENT_ACTIVITY'?'quarterly':'annual';
  const objectKey=`tax-documents/${merchant.id}/${folder}/${periodLabel}/${document.id}.pdf`;
  await env.TRANSACTION_RECORDS.put(objectKey,bytes,{httpMetadata:{contentType:'application/pdf'},customMetadata:{documentKind:kind,sourceId:document.id,merchantId:merchant.id,period:periodLabel,sha256:hash}});
  await env.DB.prepare(`
    INSERT INTO tax_document_exports(id,document_kind,source_id,merchant_id,period_label,object_key,pdf_sha256,pdf_byte_length,generated_at)
    VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
  `).bind(`TDE-${document.id}`,kind,document.id,merchant.id,periodLabel,objectKey,hash,bytes.byteLength).run();
  return 1;
}

async function eligibleMerchants(env) {
  const result=await env.DB.prepare(`
    SELECT id,name,email,statement_email FROM merchants m
     WHERE tax_documentation_enabled=1
       AND (m.status IN ('ACTIVE','PAUSED','DISCONNECTED','TEST') OR EXISTS(SELECT 1 FROM transactions t WHERE t.merchant_id=m.id))
     ORDER BY id LIMIT 500
  `).all();
  return result.results||[];
}
async function latestQuarterly(env,merchantId,year,quarter){return env.DB.prepare(`SELECT id FROM quarterly_payment_summaries WHERE merchant_id=? AND tax_year=? AND quarter=? AND currency='USD' ORDER BY summary_version DESC LIMIT 1`).bind(merchantId,year,quarter).first();}
async function latestAnnual(env,merchantId,year){return env.DB.prepare(`SELECT id FROM year_end_payment_summaries WHERE merchant_id=? AND tax_year=? AND currency='USD' ORDER BY summary_version DESC LIMIT 1`).bind(merchantId,year).first();}
async function sha256Hex(bytes){const buffer=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);const digest=await crypto.subtle.digest('SHA-256',buffer);return [...new Uint8Array(digest)].map((b)=>b.toString(16).padStart(2,'0')).join('');}

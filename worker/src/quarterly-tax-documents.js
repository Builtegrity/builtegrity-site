import { ensureMerchantTaxProfile, documentationPurpose } from './merchant-tax.js';
import { periodBounds, normalizeYear, normalizeQuarter } from './tax-periods.js';

export async function generateQuarterlyPaymentSummary(env, merchantId, taxYear, quarter, currency = 'USD') {
  if (!env.DB) throw new Error('Quarterly payment summary requires D1 binding DB');
  const year = normalizeYear(taxYear);
  const q = normalizeQuarter(quarter);
  const normalizedCurrency = String(currency || 'USD').toUpperCase();
  const period = periodBounds(year, q);
  await ensureMerchantTaxProfile(env, merchantId);
  const merchant = await env.DB.prepare(`
    SELECT m.id,m.name,m.partner_id,m.processor,m.integration_mode,m.tax_documentation_enabled,
           p.federal_tax_classification,p.profile_status,p.tax_home_country,p.tax_home_state
      FROM merchants m JOIN merchant_tax_profiles p ON p.merchant_id=m.id
     WHERE m.id=?
  `).bind(merchantId).first();
  if (!merchant) throw Object.assign(new Error(`Merchant ${merchantId} not found`), { status: 404 });

  const latest = await env.DB.prepare(`
    SELECT COALESCE(MAX(summary_version),0) AS version FROM quarterly_payment_summaries
     WHERE merchant_id=? AND tax_year=? AND quarter=? AND currency=?
  `).bind(merchantId,year,q,normalizedCurrency).first();
  const version = Number(latest?.version || 0) + 1;
  const summaryId = `QPS-${merchantId}-${year}-Q${q}-${normalizedCurrency}-V${version}`;

  const txResult = await env.DB.prepare(`
    SELECT id,record_classification,stripe_available_on,
           COALESCE(customer_paid_cents,amount_cents) AS gross_payment_cents,
           COALESCE(processor_fee_cents,0) AS processor_fee_cents,
           COALESCE(bg_fee_earned_cents,0) AS builtegrity_gross_fee_cents,
           COALESCE(integrity_fee_collected_cents,0) AS current_builtegrity_fee_cash_cents,
           COALESCE(refunded_cents,0) AS refunded_cents,payout_accounted,
           payment_status,processor_payout_status,processor_fee_source,
           exception_status,stripe_charge_id,stripe_balance_transaction_id,stripe_application_fee_id
      FROM transactions
     WHERE merchant_id=? AND currency=? AND payment_at IS NOT NULL
       AND stripe_available_on IS NOT NULL
       AND datetime(stripe_available_on)>=datetime(?) AND datetime(stripe_available_on)<datetime(?)
     ORDER BY stripe_available_on,id
  `).bind(merchantId,normalizedCurrency,period.start,period.endExclusive).all();
  const items = txResult.results || [];

  const adjustments = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN adjustment_type='REFUND' AND direction='MERCHANT_OUTFLOW' THEN amount_cents ELSE 0 END),0) AS refunds,
      COALESCE(SUM(CASE WHEN adjustment_type='APPLICATION_FEE_REFUND' AND direction='BUILTEGRITY_OUTFLOW' THEN amount_cents ELSE 0 END),0) AS fee_refunds
      FROM transaction_financial_adjustments
     WHERE merchant_id=? AND currency=?
       AND datetime(adjustment_at)>=datetime(?) AND datetime(adjustment_at)<datetime(?)
  `).bind(merchantId,normalizedCurrency,period.start,period.endExclusive).first();

  const completeness = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN stripe_available_on IS NULL THEN 1 ELSE 0 END),0) AS missing_available_on,
      COALESCE(SUM(CASE WHEN record_classification='FEE_EXCEPTION' OR exception_status='NEEDS_ATTENTION' THEN 1 ELSE 0 END),0) AS exceptions
      FROM transactions
     WHERE merchant_id=? AND currency=? AND payment_at IS NOT NULL
       AND datetime(payment_at)>=datetime(?) AND datetime(payment_at)<datetime(?)
  `).bind(merchantId,normalizedCurrency,period.start,period.endExclusive).first();

  const counts = {
    successful_charge_count: items.length,
    protected_count: count(items,'PROTECTED'), observed_count: count(items,'OBSERVED'), imported_count: count(items,'IMPORTED'),
    exception_count: Number(completeness?.exceptions || 0),
    missing_available_on_count: Number(completeness?.missing_available_on || 0),
    unreconciled_payout_count: items.filter((x) => Number(x.payout_accounted || 0) !== 1).length,
  };
  const money = {
    gross_payment_volume_cents: sum(items,'gross_payment_cents'),
    customer_refunds_cents: Number(adjustments?.refunds || 0),
    processor_fee_cents: sum(items,'processor_fee_cents'),
    builtegrity_gross_fee_earned_cents: sum(items,'builtegrity_gross_fee_cents'),
    builtegrity_fee_refunds_cents: Number(adjustments?.fee_refunds || 0),
    merchant_net_observed_cents: items.reduce((total,row) => total + Math.max(0, Number(row.gross_payment_cents||0)-Number(row.processor_fee_cents||0)-Number(row.current_builtegrity_fee_cash_cents||0)),0),
  };
  const unverifiedFees = items.filter((x) => x.processor_fee_source === 'BALANCE_TOTAL_UNVERIFIED').length;
  const status = counts.exception_count || counts.missing_available_on_count || counts.unreconciled_payout_count || unverifiedFees ? 'NEEDS_REVIEW' : 'RECONCILED';
  const purpose = documentationPurpose(merchant.federal_tax_classification).quarterly;
  const snapshot = {
    kind:'QUARTERLY_PAYMENT_ACTIVITY_SUMMARY', summary_id:summaryId, summary_version:version,
    tax_year:year, quarter:q, period_start:period.start, period_end_exclusive:period.endExclusive,
    currency:normalizedCurrency,
    merchant:{ id:merchant.id,name:merchant.name,partner_id:merchant.partner_id,processor:merchant.processor,
      federal_tax_classification:merchant.federal_tax_classification,tax_profile_status:merchant.profile_status,
      tax_home_country:merchant.tax_home_country,tax_home_state:merchant.tax_home_state },
    purpose_code:purpose, counts:{...counts,unverified_fee_breakdown_count:unverifiedFees}, money,
    reconciliation_status:status,
    disclaimer:'This is an accounting and estimated-tax preparation aid. It is not a tax return, tax calculation, 1040-ES, 1120-W, payroll report, or determination of taxable income.',
  };

  await env.DB.prepare(`
    INSERT INTO quarterly_payment_summaries
      (id,merchant_id,tax_year,quarter,currency,summary_version,period_start,period_end_exclusive,status,
       federal_tax_classification_snapshot,tax_profile_status_snapshot,purpose_code,successful_charge_count,
       gross_payment_volume_cents,customer_refunds_cents,processor_fee_cents,builtegrity_gross_fee_earned_cents,
       builtegrity_fee_refunds_cents,merchant_net_observed_cents,protected_count,observed_count,imported_count,
       exception_count,missing_available_on_count,unreconciled_payout_count,snapshot_json,generated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
  `).bind(summaryId,merchantId,year,q,normalizedCurrency,version,period.start,period.endExclusive,status,
    merchant.federal_tax_classification,merchant.profile_status,purpose,counts.successful_charge_count,
    money.gross_payment_volume_cents,money.customer_refunds_cents,money.processor_fee_cents,
    money.builtegrity_gross_fee_earned_cents,money.builtegrity_fee_refunds_cents,money.merchant_net_observed_cents,
    counts.protected_count,counts.observed_count,counts.imported_count,counts.exception_count,
    counts.missing_available_on_count,counts.unreconciled_payout_count,JSON.stringify(snapshot)).run();

  for (const row of items) {
    const item = { transaction_id:row.id,record_classification:row.record_classification,stripe_available_on:row.stripe_available_on,
      gross_payment_cents:Number(row.gross_payment_cents||0),processor_fee_cents:Number(row.processor_fee_cents||0),
      builtegrity_gross_fee_cents:Number(row.builtegrity_gross_fee_cents||0),current_builtegrity_fee_cash_cents:Number(row.current_builtegrity_fee_cash_cents||0),
      refunded_cents:Number(row.refunded_cents||0),payout_accounted:Number(row.payout_accounted||0),payment_status:row.payment_status,
      processor_payout_status:row.processor_payout_status,stripe_charge_id:row.stripe_charge_id,stripe_balance_transaction_id:row.stripe_balance_transaction_id,
      stripe_application_fee_id:row.stripe_application_fee_id };
    await env.DB.prepare(`
      INSERT INTO quarterly_payment_summary_items
       (id,summary_id,transaction_id,record_classification,stripe_available_on,gross_payment_cents,processor_fee_cents,
        builtegrity_gross_fee_cents,current_builtegrity_fee_cash_cents,refunded_cents,payout_accounted,snapshot_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(`QPI-${summaryId}-${row.id}`,summaryId,row.id,row.record_classification,row.stripe_available_on,
      item.gross_payment_cents,item.processor_fee_cents,item.builtegrity_gross_fee_cents,item.current_builtegrity_fee_cash_cents,
      item.refunded_cents,item.payout_accounted,JSON.stringify(item)).run();
  }
  return getQuarterlyPaymentSummary(env,summaryId);
}

export async function getQuarterlyPaymentSummary(env, id) {
  const summary=await env.DB.prepare(`SELECT * FROM quarterly_payment_summaries WHERE id=?`).bind(id).first();
  if(!summary) return null;
  const items=await env.DB.prepare(`SELECT * FROM quarterly_payment_summary_items WHERE summary_id=? ORDER BY stripe_available_on,transaction_id`).bind(id).all();
  return {...summary,snapshot:parse(summary.snapshot_json),items:(items.results||[]).map((x)=>({...x,snapshot:parse(x.snapshot_json)}))};
}

export async function listQuarterlyPaymentSummaries(env, options={}) {
  const limit=Math.max(1,Math.min(Number(options.limit||100),500));
  const result=await env.DB.prepare(`SELECT * FROM quarterly_payment_summaries ORDER BY tax_year DESC,quarter DESC,merchant_id,summary_version DESC LIMIT ?`).bind(limit).all();
  return result.results||[];
}
function sum(items,key){return items.reduce((n,x)=>n+Number(x[key]||0),0);} function count(items,value){return items.filter((x)=>x.record_classification===value).length;}
function parse(v){if(!v)return null;try{return JSON.parse(v);}catch{return null;}}

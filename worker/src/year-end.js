const MIN_YEAR = 2020;
const MAX_YEAR = 2100;

export async function generateYearEndPaymentSummary(env, merchantId, taxYear, currency = 'USD') {
  if (!env.DB) throw new Error('Year-end summary generation requires D1 binding DB');
  const year = normalizeYear(taxYear);
  const normalizedCurrency = String(currency || 'USD').toUpperCase();

  const merchant = await env.DB.prepare(`
    SELECT id, name, partner_id, processor, integration_mode,
           stripe_account_type, tax_form_responsibility,
           tax_form_responsibility_checked_at
      FROM merchants
     WHERE id = ?
  `).bind(merchantId).first();
  if (!merchant) throw Object.assign(new Error(`Merchant ${merchantId} not found`), { status: 404 });

  const charge = await env.DB.prepare(`
    SELECT *
      FROM merchant_tax_year_charge_summary
     WHERE merchant_id = ? AND tax_year = ? AND currency = ?
  `).bind(merchantId, String(year), normalizedCurrency).first();

  const adjustments = await env.DB.prepare(`
    SELECT *
      FROM merchant_tax_year_adjustment_summary
     WHERE merchant_id = ? AND tax_year = ? AND currency = ?
  `).bind(merchantId, String(year), normalizedCurrency).first();

  const periodStart = `${year}-01-01T00:00:00.000Z`;
  const periodEnd = `${year + 1}-01-01T00:00:00.000Z`;

  // Missing Available-On values cannot be safely placed into Stripe's tax-year reconciliation view.
  // Count them by payment_at only as a completeness warning; never silently add them to gross tax-year volume.
  const completeness = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN stripe_available_on IS NULL THEN 1 ELSE 0 END) AS missing_available_on_count,
      SUM(CASE WHEN record_classification = 'FEE_EXCEPTION' OR exception_status = 'NEEDS_ATTENTION' THEN 1 ELSE 0 END) AS exception_count
      FROM transactions
     WHERE merchant_id = ?
       AND currency = ?
       AND payment_at IS NOT NULL
       AND datetime(payment_at) >= datetime(?)
       AND datetime(payment_at) < datetime(?)
  `).bind(merchantId, normalizedCurrency, periodStart, periodEnd).first();

  const latest = await env.DB.prepare(`
    SELECT COALESCE(MAX(summary_version), 0) AS latest_version
      FROM year_end_payment_summaries
     WHERE merchant_id = ? AND tax_year = ? AND currency = ?
  `).bind(merchantId, year, normalizedCurrency).first();
  const version = Number(latest?.latest_version || 0) + 1;
  const summaryId = `YEP-${merchantId}-${year}-${normalizedCurrency}-V${version}`;

  const counts = {
    successful_charge_count: Number(charge?.successful_charge_count || 0),
    protected_count: Number(charge?.protected_count || 0),
    observed_count: Number(charge?.observed_count || 0),
    imported_count: Number(charge?.imported_count || 0),
    exception_count: Number(completeness?.exception_count || 0),
    missing_available_on_count: Number(completeness?.missing_available_on_count || 0),
    unverified_fee_breakdown_count: Number(charge?.unverified_fee_breakdown_count || 0),
    unreconciled_payout_count: Number(charge?.unreconciled_payout_count || 0),
  };

  const money = {
    gross_payment_volume_cents: Number(charge?.gross_payment_volume_cents || 0),
    customer_refunds_cents: Number(adjustments?.customer_refunds_cents || 0),
    processor_fee_cents: Number(charge?.processor_fee_cents || 0),
    builtegrity_gross_fee_earned_cents: Number(charge?.builtegrity_gross_fee_earned_cents || 0),
    builtegrity_fee_refunds_cents: Number(adjustments?.builtegrity_fee_refunds_cents || 0),
    merchant_net_observed_cents: Number(charge?.merchant_net_observed_cents || 0),
    dispute_debits_cents: Number(adjustments?.dispute_debits_cents || 0),
    dispute_credits_cents: Number(adjustments?.dispute_credits_cents || 0),
  };

  const needsReview = merchant.tax_form_responsibility !== 'STRIPE_EXPECTED'
    || counts.missing_available_on_count > 0
    || counts.unverified_fee_breakdown_count > 0
    || counts.unreconciled_payout_count > 0
    || counts.exception_count > 0;
  const status = needsReview ? 'NEEDS_REVIEW' : 'RECONCILED';

  const snapshot = {
    kind: 'YEAR_END_PAYMENT_ACTIVITY_SUMMARY',
    summary_id: summaryId,
    summary_version: version,
    tax_year: year,
    currency: normalizedCurrency,
    merchant: {
      id: merchant.id,
      name: merchant.name,
      partner_id: merchant.partner_id,
      processor: merchant.processor,
      integration_mode: merchant.integration_mode,
      stripe_account_type: merchant.stripe_account_type,
      tax_form_responsibility: merchant.tax_form_responsibility,
      tax_form_responsibility_checked_at: merchant.tax_form_responsibility_checked_at,
    },
    counts,
    money,
    reconciliation_status: status,
    tax_year_basis: 'Stripe balance transaction Available On date',
    gross_volume_rule: 'Gross payment volume is presented before refunds, processor fees, Builtegrity fees, disputes, and other adjustments.',
    disclaimer: 'Builtegrity Year-End Payment Activity Summary is an informational reconciliation aid. It is not a tax return, 1099, determination of taxable income, or tax advice. Stripe and applicable tax authorities remain authoritative for tax forms and filing rules.',
  };

  await env.DB.prepare(`
    INSERT INTO year_end_payment_summaries
      (id, merchant_id, tax_year, currency, summary_version, status,
       stripe_account_type_snapshot, tax_form_responsibility_snapshot,
       successful_charge_count, gross_payment_volume_cents, customer_refunds_cents,
       processor_fee_cents, builtegrity_gross_fee_earned_cents, builtegrity_fee_refunds_cents,
       merchant_net_observed_cents, protected_count, observed_count, imported_count,
       exception_count, missing_available_on_count, unverified_fee_breakdown_count,
       unreconciled_payout_count, snapshot_json, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(
    summaryId,
    merchantId,
    year,
    normalizedCurrency,
    version,
    status,
    merchant.stripe_account_type || null,
    merchant.tax_form_responsibility,
    counts.successful_charge_count,
    money.gross_payment_volume_cents,
    money.customer_refunds_cents,
    money.processor_fee_cents,
    money.builtegrity_gross_fee_earned_cents,
    money.builtegrity_fee_refunds_cents,
    money.merchant_net_observed_cents,
    counts.protected_count,
    counts.observed_count,
    counts.imported_count,
    counts.exception_count,
    counts.missing_available_on_count,
    counts.unverified_fee_breakdown_count,
    counts.unreconciled_payout_count,
    JSON.stringify(snapshot),
  ).run();

  const transactions = await env.DB.prepare(`
    SELECT id, record_classification, stripe_available_on,
           COALESCE(customer_paid_cents, amount_cents) AS gross_payment_cents,
           COALESCE(processor_fee_cents, 0) AS processor_fee_cents,
           COALESCE(bg_fee_earned_cents, 0) AS builtegrity_gross_fee_cents,
           COALESCE(integrity_fee_collected_cents, 0) AS current_builtegrity_fee_cash_cents,
           COALESCE(refunded_cents, 0) AS refunded_cents,
           payout_accounted, payment_status, processor_payout_status,
           processor_fee_source, stripe_charge_id, stripe_balance_transaction_id,
           stripe_application_fee_id
      FROM transactions
     WHERE merchant_id = ?
       AND currency = ?
       AND stripe_available_on IS NOT NULL
       AND strftime('%Y', stripe_available_on) = ?
       AND payment_at IS NOT NULL
     ORDER BY stripe_available_on, id
  `).bind(merchantId, normalizedCurrency, String(year)).all();

  for (const tx of transactions.results || []) {
    const itemSnapshot = {
      transaction_id: tx.id,
      record_classification: tx.record_classification,
      stripe_available_on: tx.stripe_available_on,
      gross_payment_cents: Number(tx.gross_payment_cents || 0),
      processor_fee_cents: Number(tx.processor_fee_cents || 0),
      builtegrity_gross_fee_cents: Number(tx.builtegrity_gross_fee_cents || 0),
      current_builtegrity_fee_cash_cents: Number(tx.current_builtegrity_fee_cash_cents || 0),
      refunded_cents: Number(tx.refunded_cents || 0),
      payout_accounted: Number(tx.payout_accounted || 0),
      payment_status: tx.payment_status,
      processor_payout_status: tx.processor_payout_status,
      processor_fee_source: tx.processor_fee_source,
      stripe_charge_id: tx.stripe_charge_id,
      stripe_balance_transaction_id: tx.stripe_balance_transaction_id,
      stripe_application_fee_id: tx.stripe_application_fee_id,
    };
    await env.DB.prepare(`
      INSERT INTO year_end_payment_summary_items
        (id, summary_id, transaction_id, record_classification, stripe_available_on,
         gross_payment_cents, processor_fee_cents, builtegrity_gross_fee_cents,
         current_builtegrity_fee_cash_cents, refunded_cents, payout_accounted, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      `YEI-${summaryId}-${tx.id}`,
      summaryId,
      tx.id,
      tx.record_classification,
      tx.stripe_available_on,
      Number(tx.gross_payment_cents || 0),
      Number(tx.processor_fee_cents || 0),
      Number(tx.builtegrity_gross_fee_cents || 0),
      Number(tx.current_builtegrity_fee_cash_cents || 0),
      Number(tx.refunded_cents || 0),
      Number(tx.payout_accounted || 0),
      JSON.stringify(itemSnapshot),
    ).run();
  }

  return getYearEndPaymentSummary(env, summaryId);
}

export async function getYearEndPaymentSummary(env, summaryId) {
  const summary = await env.DB.prepare(`
    SELECT * FROM year_end_payment_summaries WHERE id = ?
  `).bind(summaryId).first();
  if (!summary) return null;
  const items = await env.DB.prepare(`
    SELECT * FROM year_end_payment_summary_items
     WHERE summary_id = ?
     ORDER BY stripe_available_on, transaction_id
  `).bind(summaryId).all();
  return {
    ...summary,
    snapshot: safeJson(summary.snapshot_json),
    items: (items.results || []).map((row) => ({ ...row, snapshot: safeJson(row.snapshot_json) })),
  };
}

export async function listYearEndPaymentSummaries(env, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 100), 500));
  const merchantId = options.merchantId || null;
  const taxYear = options.taxYear ? normalizeYear(options.taxYear) : null;

  const clauses = [];
  const binds = [];
  if (merchantId) {
    clauses.push('merchant_id = ?');
    binds.push(merchantId);
  }
  if (taxYear) {
    clauses.push('tax_year = ?');
    binds.push(taxYear);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await env.DB.prepare(`
    SELECT id, merchant_id, tax_year, currency, summary_version, status,
           stripe_account_type_snapshot, tax_form_responsibility_snapshot,
           successful_charge_count, gross_payment_volume_cents, customer_refunds_cents,
           processor_fee_cents, builtegrity_gross_fee_earned_cents, builtegrity_fee_refunds_cents,
           protected_count, observed_count, imported_count, exception_count,
           missing_available_on_count, unverified_fee_breakdown_count, unreconciled_payout_count,
           generated_at, created_at
      FROM year_end_payment_summaries
      ${where}
     ORDER BY tax_year DESC, merchant_id, summary_version DESC
     LIMIT ?
  `).bind(...binds, limit).all();
  return result.results || [];
}

function normalizeYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw Object.assign(new Error(`tax_year must be an integer between ${MIN_YEAR} and ${MAX_YEAR}`), { status: 400 });
  }
  return year;
}

function safeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

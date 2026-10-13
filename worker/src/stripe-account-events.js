import { claimWebhook, failWebhook, finishWebhook } from './db.js';

export async function processStripeAccountWebhook(env, event) {
  const claim = await claimWebhook(env, event);
  if (!claim.claimed) return { duplicate: true };

  try {
    if (event.type === 'account.updated') await handleAccountUpdated(env, event);
    if (event.type === 'account.application.deauthorized') await handleAccountDeauthorized(env, event);
    await finishWebhook(env, event.id);
    return { processed: true, account_event: true };
  } catch (error) {
    await failWebhook(env, event.id, error);
    throw error;
  }
}

async function handleAccountUpdated(env, event) {
  const account = event.data?.object || {};
  const accountId = account.id || event.account;
  if (!accountId) return;

  const merchant = await env.DB.prepare(`
    SELECT id, status, integration_mode, state_code
      FROM merchants
     WHERE processor = 'STRIPE' AND processor_account_id = ?
     LIMIT 1
  `).bind(accountId).first();
  if (!merchant) return;

  const payoutInterval = account.settings?.payouts?.schedule?.interval || null;
  const feePayer = normalizeResponsibility(account.controller?.fees?.payer);
  const lossLiability = normalizeResponsibility(account.controller?.losses?.payments);
  const accountType = normalizeAccountType(account.type);
  const requirementCollection = normalizeRequirementCollection(account.controller?.requirement_collection);
  const dashboardType = account.controller?.stripe_dashboard?.type || null;
  const taxFormResponsibility = accountType === 'standard'
    ? 'STRIPE_EXPECTED'
    : accountType ? 'PLATFORM_REVIEW_REQUIRED' : 'UNKNOWN';
  const requirements = uniqueStrings([
    ...(account.requirements?.past_due || []),
    ...(account.requirements?.currently_due || []),
    ...(account.requirements?.pending_verification || []),
  ]);

  const processorReady = Boolean(account.charges_enabled && account.payouts_enabled && payoutInterval !== 'manual');
  const financialResponsibilitySafe = feePayer === 'stripe' && lossLiability === 'stripe';
  const requiresV1TaxLane = merchant.integration_mode === 'STRIPE_CONNECT';
  const taxResponsibilitySafe = !requiresV1TaxLane || taxFormResponsibility === 'STRIPE_EXPECTED';
  const legal = await legalActivationState(env, merchant.id, merchant.state_code);
  const compatible = processorReady && financialResponsibilitySafe && taxResponsibilitySafe && legal.ready;
  const explicitlyUnsafe = feePayer === 'application' || lossLiability === 'application';

  // Never auto-unpause an operator/security pause. Processor financial responsibility can force PAUSED.
  // Tax or legal uncertainty keeps a Connect merchant in TEST rather than letting a Stripe webhook
  // bypass Builtegrity's independent launch/compliance perimeter.
  const nextStatus = merchant.status === 'PAUSED' || explicitlyUnsafe
    ? 'PAUSED'
    : compatible ? 'ACTIVE' : 'TEST';

  await env.DB.prepare(`
    UPDATE merchants
       SET status = ?,
           stripe_charges_enabled = ?,
           stripe_payouts_enabled = ?,
           stripe_details_submitted = ?,
           stripe_payout_interval = ?,
           stripe_requirements_due_json = ?,
           stripe_fee_payer = ?,
           stripe_loss_liability = ?,
           stripe_account_type = ?,
           stripe_requirement_collection = ?,
           stripe_dashboard_type = ?,
           tax_form_responsibility = ?,
           tax_form_responsibility_checked_at = CURRENT_TIMESTAMP,
           stripe_financial_responsibility_checked_at = CURRENT_TIMESTAMP,
           stripe_last_account_update_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(
    nextStatus,
    account.charges_enabled ? 1 : 0,
    account.payouts_enabled ? 1 : 0,
    account.details_submitted ? 1 : 0,
    payoutInterval,
    JSON.stringify(requirements),
    feePayer,
    lossLiability,
    accountType,
    requirementCollection,
    dashboardType,
    taxFormResponsibility,
    merchant.id,
  ).run();

  const remediationKey = `merchant:stripe-remediation:${merchant.id}`;
  if (!processorReady) {
    const reason = requirements.length
      ? `Stripe requires merchant action: ${requirements.join(', ')}`
      : `Stripe account is not transaction-ready (charges_enabled=${Boolean(account.charges_enabled)}, payouts_enabled=${Boolean(account.payouts_enabled)}, payout_interval=${payoutInterval || 'unknown'}).`;
    await upsertMerchantActionAlert(env, {
      key: remediationKey,
      merchantId: merchant.id,
      action: 'RESOLVE_WITH_STRIPE',
      message: reason,
    });
  } else {
    await resolveAlert(env, remediationKey);
  }

  const responsibilityKey = `merchant:financial-responsibility:${merchant.id}`;
  if (!financialResponsibilitySafe) {
    const message = explicitlyUnsafe
      ? `Stripe financial responsibility is unsafe for Builtegrity V1 (processing_fee_payer=${feePayer || 'unknown'}, payment_loss_liability=${lossLiability || 'unknown'}). This merchant is paused because Builtegrity must not pay merchant processing fees or absorb connected-account payment losses.`
      : `Stripe has not yet confirmed safe financial responsibility for this merchant (processing_fee_payer=${feePayer || 'unknown'}, payment_loss_liability=${lossLiability || 'unknown'}). Merchant remains non-active until both are confirmed as stripe.`;
    await upsertInternalFinancialAlert(env, responsibilityKey, merchant.id, explicitlyUnsafe ? 'CRITICAL' : 'ERROR', message);
  } else {
    await resolveAlert(env, responsibilityKey);
  }

  const taxKey = `merchant:tax-responsibility:${merchant.id}`;
  if (requiresV1TaxLane && !taxResponsibilitySafe) {
    const message = accountType
      ? `Builtegrity V1 protected payments require a Standard Stripe connected account so Stripe remains the expected 1099-K filer. Stripe reported account_type=${accountType}; this merchant remains non-active for protected payments.`
      : 'Builtegrity cannot yet confirm the Stripe account tax-reporting lane. Protected payments remain disabled until the account is confirmed as Standard.';
    await upsertMerchantActionAlert(env, {
      key: taxKey,
      merchantId: merchant.id,
      action: 'CONNECT_STANDARD_STRIPE_ACCOUNT',
      message,
    });
  } else {
    await resolveAlert(env, taxKey);
  }

  const legalKey = `merchant:legal-readiness:${merchant.id}`;
  if (!legal.ready) {
    await upsertMerchantActionAlert(env, {
      key: legalKey,
      merchantId: merchant.id,
      action: 'COMPLETE_BUILTEGRITY_COMPLIANCE',
      message: `Stripe is not sufficient to activate this merchant. Builtegrity legal/compliance clearance remains incomplete: ${legal.reasons.join(', ')}.`,
    });
  } else {
    await resolveAlert(env, legalKey);
  }
}

async function handleAccountDeauthorized(env, event) {
  const account = event.data?.object || {};
  const accountId = account.id || event.account;
  if (!accountId) return;
  const merchant = await env.DB.prepare(`
    SELECT id FROM merchants WHERE processor = 'STRIPE' AND processor_account_id = ? LIMIT 1
  `).bind(accountId).first();
  if (!merchant) return;

  await env.DB.prepare(`
    UPDATE merchants
       SET status = 'DISCONNECTED',
           stripe_charges_enabled = 0,
           stripe_payouts_enabled = 0,
           stripe_fee_payer = NULL,
           stripe_loss_liability = NULL,
           stripe_account_type = NULL,
           stripe_requirement_collection = NULL,
           stripe_dashboard_type = NULL,
           tax_form_responsibility = 'UNKNOWN',
           tax_form_responsibility_checked_at = CURRENT_TIMESTAMP,
           stripe_financial_responsibility_checked_at = CURRENT_TIMESTAMP,
           stripe_last_account_update_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(merchant.id).run();

  await upsertMerchantActionAlert(env, {
    key: `merchant:stripe-remediation:${merchant.id}`,
    merchantId: merchant.id,
    action: 'RECONNECT_STRIPE',
    message: 'Stripe connection was deauthorized. Merchant must reconnect Stripe before protected payments can resume.',
  });
  await resolveAlert(env, `merchant:financial-responsibility:${merchant.id}`);
  await resolveAlert(env, `merchant:tax-responsibility:${merchant.id}`);
}

async function legalActivationState(env, merchantId, stateCode) {
  const [platform, merchant, state] = await Promise.all([
    env.DB.prepare(`SELECT state,blockers FROM platform_legal_readiness LIMIT 1`).first().catch(() => null),
    env.DB.prepare(`SELECT legal_state FROM merchant_legal_readiness WHERE merchant_id=?`).bind(merchantId).first().catch(() => null),
    stateCode ? env.DB.prepare(`SELECT * FROM state_jurisdiction_support WHERE state_code=?`).bind(stateCode).first().catch(() => null) : Promise.resolve(null),
  ]);
  const reasons = [];
  if (platform?.state !== 'READY') reasons.push('PLATFORM_LEGAL_BLOCKED');
  if (merchant?.legal_state !== 'READY') reasons.push('MERCHANT_LEGAL_BLOCKED');
  if (!stateCode) reasons.push('MERCHANT_STATE_MISSING');
  if (!state) reasons.push('STATE_NOT_SUPPORTED');
  if (state) {
    if (state.merchant_onboarding_status !== 'READY') reasons.push('STATE_NOT_READY');
    if (!['CLEARED_NON_LICENSED','LICENSE_ACTIVE'].includes(state.money_transmission_review_status)) reasons.push('STATE_PAYMENTS_REVIEW_OPEN');
    if (!['CLEARED','REGISTERED','NOT_APPLICABLE'].includes(state.sales_tax_review_status)) reasons.push('STATE_SALES_TAX_REVIEW_OPEN');
    if (state.privacy_review_status !== 'CLEARED') reasons.push('STATE_PRIVACY_REVIEW_OPEN');
    if (state.breach_review_status !== 'CLEARED') reasons.push('STATE_BREACH_REVIEW_OPEN');
    if (!['CLEARED','REGISTERED'].includes(state.entity_nexus_review_status)) reasons.push('STATE_ENTITY_REVIEW_OPEN');
    if (!['CLEARED','REGISTERED','NOT_APPLICABLE'].includes(state.income_tax_review_status)) reasons.push('STATE_INCOME_TAX_REVIEW_OPEN');
    if (state.electronic_transactions_review_status !== 'CLEARED') reasons.push('STATE_ESIGN_REVIEW_OPEN');
    if (state.next_review_due_at && Date.parse(state.next_review_due_at) <= Date.now()) reasons.push('STATE_REVIEW_EXPIRED');
  }
  return { ready: reasons.length === 0, reasons };
}

async function upsertMerchantActionAlert(env, values) {
  await env.DB.prepare(`
    INSERT INTO system_alerts
      (alert_key, category, severity, status, subject_type, subject_id, message,
       resolution_owner, merchant_action_code)
    VALUES (?, 'MERCHANT', 'ERROR', 'OPEN', 'MERCHANT', ?, ?, 'MERCHANT', ?)
    ON CONFLICT(alert_key) DO UPDATE SET
      severity = 'ERROR', status = 'OPEN', subject_type = 'MERCHANT', subject_id = excluded.subject_id,
      message = excluded.message, resolution_owner = 'MERCHANT', merchant_action_code = excluded.merchant_action_code,
      case_type_code = NULL, internal_case_id = NULL,
      last_seen_at = CURRENT_TIMESTAMP, resolved_at = NULL,
      occurrences = system_alerts.occurrences + 1
  `).bind(values.key, values.merchantId, values.message, values.action).run();
}

async function upsertInternalFinancialAlert(env, key, merchantId, severity, message) {
  await env.DB.prepare(`
    INSERT INTO system_alerts
      (alert_key, category, severity, status, subject_type, subject_id, message,
       resolution_owner, case_type_code)
    VALUES (?, 'FINANCE', ?, 'OPEN', 'MERCHANT', ?, ?, 'INTERNAL', 'FINANCIAL_SOLVENCY_RISK')
    ON CONFLICT(alert_key) DO UPDATE SET
      category='FINANCE', severity=excluded.severity, status='OPEN',
      subject_type='MERCHANT', subject_id=excluded.subject_id, message=excluded.message,
      resolution_owner='INTERNAL', case_type_code='FINANCIAL_SOLVENCY_RISK', merchant_action_code=NULL,
      last_seen_at=CURRENT_TIMESTAMP, resolved_at=NULL,
      occurrences=system_alerts.occurrences+1
  `).bind(key, severity, merchantId, message).run();
}

async function resolveAlert(env, key) {
  await env.DB.prepare(`
    UPDATE system_alerts
       SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP
     WHERE alert_key = ? AND status = 'OPEN'
  `).bind(key).run();
}

function normalizeResponsibility(value) {
  const normalized = String(value || '').toLowerCase();
  return ['stripe', 'application'].includes(normalized) ? normalized : null;
}

function normalizeAccountType(value) {
  const normalized = String(value || '').toLowerCase();
  return ['standard', 'express', 'custom', 'none'].includes(normalized) ? normalized : null;
}

function normalizeRequirementCollection(value) {
  const normalized = String(value || '').toLowerCase();
  return ['stripe', 'application'].includes(normalized) ? normalized : null;
}

function uniqueStrings(items) {
  return [...new Set(items.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

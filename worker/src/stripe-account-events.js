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
    SELECT id, status FROM merchants WHERE processor = 'STRIPE' AND processor_account_id = ? LIMIT 1
  `).bind(accountId).first();
  if (!merchant) return;

  const payoutInterval = account.settings?.payouts?.schedule?.interval || null;
  const feePayer = normalizeResponsibility(account.controller?.fees?.payer);
  const lossLiability = normalizeResponsibility(account.controller?.losses?.payments);
  const requirements = uniqueStrings([
    ...(account.requirements?.past_due || []),
    ...(account.requirements?.currently_due || []),
    ...(account.requirements?.pending_verification || []),
  ]);

  const processorReady = Boolean(account.charges_enabled && account.payouts_enabled && payoutInterval !== 'manual');
  const financialResponsibilitySafe = feePayer === 'stripe' && lossLiability === 'stripe';
  const compatible = processorReady && financialResponsibilitySafe;
  const explicitlyUnsafe = feePayer === 'application' || lossLiability === 'application';

  // Never auto-unpause an operator/security pause. A processor-responsibility problem also forces PAUSED.
  // Unknown responsibility stays TEST until Stripe confirms both responsibility fields.
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

function uniqueStrings(items) {
  return [...new Set(items.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

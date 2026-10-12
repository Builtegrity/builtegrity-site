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
  const requirements = uniqueStrings([
    ...(account.requirements?.past_due || []),
    ...(account.requirements?.currently_due || []),
    ...(account.requirements?.pending_verification || []),
  ]);
  const compatible = Boolean(account.charges_enabled && account.payouts_enabled && payoutInterval !== 'manual');

  // Never auto-unpause an operator/security pause. TEST is the self-service remediation state.
  const nextStatus = merchant.status === 'PAUSED'
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
    merchant.id,
  ).run();

  const key = `merchant:stripe-remediation:${merchant.id}`;
  if (!compatible) {
    const reason = requirements.length
      ? `Stripe requires merchant action: ${requirements.join(', ')}`
      : `Stripe account is not transaction-ready (charges_enabled=${Boolean(account.charges_enabled)}, payouts_enabled=${Boolean(account.payouts_enabled)}, payout_interval=${payoutInterval || 'unknown'}).`;
    await upsertMerchantActionAlert(env, {
      key,
      merchantId: merchant.id,
      action: 'RESOLVE_WITH_STRIPE',
      message: reason,
    });
  } else {
    await resolveAlert(env, key);
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

async function resolveAlert(env, key) {
  await env.DB.prepare(`
    UPDATE system_alerts
       SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP
     WHERE alert_key = ? AND status = 'OPEN'
  `).bind(key).run();
}

function uniqueStrings(items) {
  return [...new Set(items.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

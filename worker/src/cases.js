import { allocateId, getTransaction, recomputeIntegrity, recordEvent } from './db.js';
import { retrieveCharge, retrieveConnectedAccount, retrievePaymentIntent } from './stripe.js';

const OPEN_CASE_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_PROVIDER', 'ESCALATED', 'QUARANTINED'];

export async function listInternalCases(env, options = {}) {
  const status = String(options.status || '').trim().toUpperCase();
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const params = [];
  let where = '';
  if (status) {
    where = 'WHERE q.status = ?';
    params.push(status);
  }
  params.push(limit);
  const result = await env.DB.prepare(`
    SELECT q.*
    FROM internal_case_queue q
    ${where}
    ORDER BY CASE q.severity WHEN 'CRITICAL' THEN 1 WHEN 'ERROR' THEN 2 ELSE 3 END,
             q.opened_at ASC
    LIMIT ?
  `).bind(...params).all();
  return result.results || [];
}

export async function getInternalCase(env, caseId) {
  const item = await env.DB.prepare(`
    SELECT c.*, t.title, t.category, t.operator_summary, t.sla_minutes, t.auto_verify_rule
    FROM internal_cases c
    JOIN internal_case_types t ON t.code = c.case_type_code
    WHERE c.id = ?
  `).bind(caseId).first();
  if (!item) return null;

  const [actions, runs, alert] = await Promise.all([
    env.DB.prepare(`
      SELECT action_code, label, action_kind, action_handler, sequence, requires_human
      FROM internal_case_actions
      WHERE case_type_code = ? AND enabled = 1
      ORDER BY sequence ASC, action_code ASC
    `).bind(item.case_type_code).all(),
    env.DB.prepare(`
      SELECT * FROM internal_case_action_runs
      WHERE case_id = ?
      ORDER BY started_at ASC
    `).bind(caseId).all(),
    item.source_type === 'WATCHDOG_ALERT'
      ? env.DB.prepare(`SELECT * FROM system_alerts WHERE alert_key = ?`).bind(item.source_ref).first()
      : Promise.resolve(null),
  ]);

  return {
    ...item,
    machine_context: parseJson(item.machine_context_json),
    automation_attempts: parseJson(item.automation_attempts_json),
    actions: actions.results || [],
    action_runs: (runs.results || []).map((run) => ({
      ...run,
      input: parseJson(run.input_json),
      output: parseJson(run.output_json),
    })),
    source_alert: alert || null,
  };
}

export async function getInternalOperationsMetrics(env) {
  return (await env.DB.prepare('SELECT * FROM internal_operations_metrics').first()) || {
    total_transactions: 0,
    human_touched_transactions: 0,
    unknown_exception_cases: 0,
    human_seconds_total: 0,
    human_touch_rate: 0,
    human_minutes_per_1000_transactions: 0,
  };
}

export async function syncInternalCaseForAlert(env, alert) {
  if (!alert || alert.resolution_owner !== 'INTERNAL' || !alert.case_type_code) return null;

  const existing = await env.DB.prepare(`
    SELECT id FROM internal_cases
    WHERE case_type_code = ? AND source_type = 'WATCHDOG_ALERT' AND source_ref = ?
      AND status <> 'RESOLVED'
    LIMIT 1
  `).bind(alert.case_type_code, alert.alert_key).first();

  if (existing) {
    await env.DB.prepare(`
      UPDATE internal_cases
         SET severity = ?, summary = ?, machine_context_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).bind(
      alert.severity,
      alert.message,
      JSON.stringify(alertContext(alert)),
      existing.id,
    ).run();
    await env.DB.prepare(`UPDATE system_alerts SET internal_case_id = ? WHERE alert_key = ?`).bind(existing.id, alert.alert_key).run();
    return existing.id;
  }

  const type = await env.DB.prepare(`SELECT * FROM internal_case_types WHERE code = ? AND active = 1`).bind(alert.case_type_code).first();
  if (!type) throw new Error(`Unknown active internal case type: ${alert.case_type_code}`);

  const related = await resolveRelatedEntities(env, alert.subject_type, alert.subject_id);
  const caseId = await allocateId(env, 'CASE', 6);
  const recommended = await firstActionLabel(env, alert.case_type_code);

  await env.DB.prepare(`
    INSERT INTO internal_cases (
      id, case_type_code, severity, subject_type, subject_id,
      transaction_id, merchant_id, source_type, source_ref, summary,
      machine_context_json, automation_attempts_json, recommended_action,
      runbook_version, escalation_target
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'WATCHDOG_ALERT', ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    caseId,
    alert.case_type_code,
    alert.severity || type.default_severity,
    alert.subject_type || 'SYSTEM',
    alert.subject_id || null,
    related.transaction_id,
    related.merchant_id,
    alert.alert_key,
    alert.message,
    JSON.stringify(alertContext(alert)),
    JSON.stringify({ watchdog_occurrences: Number(alert.occurrences || 1), auto_repairs_exhausted: true }),
    recommended,
    type.runbook_version,
    type.escalation_target,
  ).run();

  await env.DB.prepare(`UPDATE system_alerts SET internal_case_id = ? WHERE alert_key = ?`).bind(caseId, alert.alert_key).run();
  return caseId;
}

export async function resolveInternalCaseForAlert(env, alertKey, resolution = 'Source alert cleared automatically.') {
  await env.DB.prepare(`
    UPDATE internal_cases
       SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP,
           resolution = ?, updated_at = CURRENT_TIMESTAMP
     WHERE source_type = 'WATCHDOG_ALERT' AND source_ref = ? AND status <> 'RESOLVED'
  `).bind(resolution, alertKey).run();
}

export async function executeInternalCaseAction(env, caseId, actionCode, principal, input = {}) {
  const item = await getInternalCase(env, caseId);
  if (!item) throw statusError('Internal case not found', 404);
  if (item.status === 'RESOLVED') throw statusError('Internal case is already resolved', 409);

  const action = item.actions.find((entry) => entry.action_code === actionCode);
  if (!action) throw statusError('Action is not allowed for this case type', 400);

  const actorRef = principal?.sub || principal?.email || 'operator';
  const humanSeconds = action.requires_human ? clampHumanSeconds(input.human_seconds) : 0;
  const runId = await allocateId(env, 'CAR', 6);

  if (action.requires_human) {
    await env.DB.prepare(`
      UPDATE internal_cases
         SET first_human_at = COALESCE(first_human_at, CURRENT_TIMESTAMP),
             status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).bind(caseId).run();
  }

  await env.DB.prepare(`
    INSERT INTO internal_case_action_runs
      (id, case_id, action_code, actor_type, actor_ref, status, input_json, human_seconds)
    VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?)
  `).bind(
    runId,
    caseId,
    action.action_code,
    action.requires_human ? 'OPERATOR' : 'SYSTEM',
    actorRef,
    JSON.stringify(safeInput(input)),
    humanSeconds,
  ).run();

  try {
    const output = await runHandler(env, item, action, principal, input);
    await env.DB.prepare(`
      UPDATE internal_case_action_runs
         SET status = 'SUCCEEDED', output_json = ?, finished_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).bind(JSON.stringify(output || {}), runId).run();
    await env.DB.prepare(`UPDATE internal_cases SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(caseId).run();
    return { run_id: runId, output: output || {}, case: await getInternalCase(env, caseId) };
  } catch (error) {
    await env.DB.prepare(`
      UPDATE internal_case_action_runs
         SET status = 'FAILED', error_text = ?, finished_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).bind(String(error?.message || error || 'Unknown case action failure').slice(0, 2000), runId).run();
    throw error;
  }
}

export async function verifyInternalCase(env, caseId) {
  const item = await getInternalCase(env, caseId);
  if (!item || item.status === 'RESOLVED' || item.status === 'ESCALATED') return item;
  if (item.source_type === 'WATCHDOG_ALERT') {
    const alert = await env.DB.prepare(`SELECT status FROM system_alerts WHERE alert_key = ?`).bind(item.source_ref).first();
    if (!alert || alert.status === 'RESOLVED') {
      await env.DB.prepare(`
        UPDATE internal_cases
           SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP,
               resolution = COALESCE(resolution, 'Automatic verification confirmed the source alert cleared.'),
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).bind(caseId).run();
    }
  }
  return getInternalCase(env, caseId);
}

async function runHandler(env, item, action, principal, input) {
  switch (action.action_handler) {
    case 'REFRESH_STRIPE_TRANSACTION':
      return refreshStripeTransaction(env, item);
    case 'REBUILD_DERIVED_STATE':
      return rebuildDerivedState(env, item);
    case 'PAUSE_MERCHANT':
      return pauseMerchant(env, item, `Internal case ${item.id}: ${item.case_type_code}`);
    case 'RESTORE_MERCHANT':
      return restoreMerchant(env, item);
    case 'QUARANTINE_SUBJECT':
      return quarantineSubject(env, item);
    case 'PRESERVE_RECORDS':
      return preserveRecords(env, item, principal, input);
    case 'ACTIVATE_KILL_SWITCH':
      return setKillSwitch(env, item, principal, false, input.note || item.summary);
    case 'RESUME_AFTER_VERIFY':
      return setKillSwitch(env, item, principal, true, input.note || 'Operator verified safe resume.');
    case 'MARK_FALSE_POSITIVE':
      return resolveCase(env, item.id, input.note || 'Operator marked this case as a false positive.');
    case 'MARK_RESOLVED':
      return resolveCase(env, item.id, input.note || 'Operator recorded authorized resolution.');
    case 'ESCALATE_ENGINEERING':
      return escalateCase(env, item.id, 'ENGINEERING', input.note);
    case 'ESCALATE_SECURITY':
      return escalateCase(env, item.id, 'SECURITY', input.note);
    case 'ESCALATE_LEGAL':
      return escalateCase(env, item.id, 'LEGAL', input.note);
    case 'ESCALATE_FINANCE':
      return escalateCase(env, item.id, 'FINANCE', input.note);
    case 'EXTERNAL_CONFIRMATION':
      return { confirmation_recorded: true, note: String(input.note || '').slice(0, 2000) };
    default:
      throw statusError(`Unsupported internal action handler: ${action.action_handler}`, 501);
  }
}

async function refreshStripeTransaction(env, item) {
  if (!item.transaction_id) throw statusError('This case is not attached to a transaction', 409);
  const tx = await getTransaction(env, item.transaction_id);
  if (!tx) throw statusError('Transaction not found', 404);
  if (!tx.processor_account_id) throw statusError('Merchant has no connected Stripe account', 409);
  if (!tx.stripe_payment_intent_id) throw statusError('Transaction has no Stripe PaymentIntent ID to re-fetch', 409);

  const intent = await retrievePaymentIntent(env, tx.processor_account_id, tx.stripe_payment_intent_id);
  const latestCharge = intent.latest_charge;
  const chargeId = typeof latestCharge === 'string' ? latestCharge : latestCharge?.id;
  if (!chargeId) throw statusError('Stripe PaymentIntent has no charge to reconcile', 409);
  if (tx.stripe_charge_id && tx.stripe_charge_id !== chargeId) {
    throw statusError(`Processor conflict: stored charge ${tx.stripe_charge_id} differs from Stripe charge ${chargeId}`, 409);
  }

  const charge = await retrieveCharge(env, tx.processor_account_id, chargeId);
  const balance = charge.balance_transaction;
  const balanceId = typeof balance === 'string' ? balance : balance?.id || null;
  const fee = charge.application_fee;
  const feeId = typeof fee === 'string' ? fee : fee?.id || null;
  const feeAmount = typeof fee === 'object' && Number.isFinite(Number(fee.amount)) ? Number(fee.amount) : null;

  await env.DB.prepare(`
    UPDATE transactions
       SET stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
           stripe_charge_id = COALESCE(stripe_charge_id, ?),
           stripe_balance_transaction_id = COALESCE(stripe_balance_transaction_id, ?),
           stripe_application_fee_id = COALESCE(stripe_application_fee_id, ?),
           integrity_fee_collected_cents = CASE
             WHEN ? IS NOT NULL AND ? > integrity_fee_collected_cents THEN ?
             ELSE integrity_fee_collected_cents END,
           last_reconciled_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(intent.id, chargeId, balanceId, feeId, feeAmount, feeAmount, feeAmount, tx.id).run();

  await recordEvent(env, tx.id, 'INTERNAL_RECONCILIATION', 'SYSTEM', null, {
    case_id: item.id,
    payment_intent_id: intent.id,
    charge_id: chargeId,
    balance_transaction_id: balanceId,
    application_fee_id: feeId,
  });
  await recomputeIntegrity(env, tx.id);

  return {
    reconciled: true,
    transaction_id: tx.id,
    payment_intent_id: intent.id,
    charge_id: chargeId,
    balance_transaction_id: balanceId,
    application_fee_id: feeId,
    application_fee_amount: feeAmount,
  };
}

async function rebuildDerivedState(env, item) {
  if (!item.transaction_id) return { rebuilt: false, reason: 'Case is not transaction-scoped.' };
  const result = await recomputeIntegrity(env, item.transaction_id);
  await recordEvent(env, item.transaction_id, 'DERIVED_STATE_REBUILT', 'SYSTEM', null, { case_id: item.id, ...result });
  return { rebuilt: true, transaction_id: item.transaction_id, ...result };
}

async function pauseMerchant(env, item, reason) {
  const merchantId = await caseMerchantId(env, item);
  if (!merchantId) throw statusError('No merchant can be determined for this case', 409);
  await env.DB.prepare(`UPDATE merchants SET status = 'PAUSED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(merchantId).run();
  return { merchant_id: merchantId, status: 'PAUSED', reason };
}

async function restoreMerchant(env, item) {
  const merchantId = await caseMerchantId(env, item);
  if (!merchantId) throw statusError('No merchant can be determined for this case', 409);
  const merchant = await env.DB.prepare(`SELECT * FROM merchants WHERE id = ?`).bind(merchantId).first();
  if (!merchant?.processor_account_id) throw statusError('Merchant has no connected Stripe account', 409);
  const account = await retrieveConnectedAccount(env, merchant.processor_account_id);
  const payoutInterval = account.settings?.payouts?.schedule?.interval || null;
  if (!account.charges_enabled || !account.payouts_enabled || payoutInterval === 'manual') {
    throw statusError('Stripe still reports the merchant as incompatible; restore is blocked', 409);
  }
  await env.DB.prepare(`
    UPDATE merchants
       SET status = 'ACTIVE', stripe_charges_enabled = 1, stripe_payouts_enabled = 1,
           stripe_details_submitted = ?, stripe_payout_interval = ?,
           stripe_last_account_update_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(account.details_submitted ? 1 : 0, payoutInterval, merchantId).run();
  return { merchant_id: merchantId, status: 'ACTIVE', payout_interval: payoutInterval };
}

async function quarantineSubject(env, item) {
  const merchantId = await caseMerchantId(env, item);
  if (merchantId) await env.DB.prepare(`UPDATE merchants SET status = 'PAUSED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(merchantId).run();
  await env.DB.prepare(`UPDATE internal_cases SET status = 'QUARANTINED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(item.id).run();
  return { quarantined: true, subject_type: item.subject_type, subject_id: item.subject_id, merchant_id: merchantId };
}

async function preserveRecords(env, item, principal, input) {
  const holdId = await allocateId(env, 'HOLD', 6);
  await env.DB.prepare(`
    INSERT INTO record_holds (id, subject_type, subject_id, case_id, reason)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    holdId,
    item.subject_type,
    item.subject_id || item.transaction_id || item.merchant_id || item.id,
    item.id,
    String(input.note || item.summary || 'Internal preservation hold').slice(0, 2000),
  ).run();
  return { hold_id: holdId, active: true, actor: principal?.sub || principal?.email || 'operator' };
}

async function setKillSwitch(env, item, principal, enabled, reason) {
  const numeric = enabled ? 1 : 0;
  const actor = principal?.sub || principal?.email || 'operator';
  await env.DB.prepare(`
    UPDATE platform_controls
       SET transaction_creation_enabled = ?, payment_creation_enabled = ?, merchant_onboarding_enabled = ?,
           reason = ?, source_case_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = 'GLOBAL'
  `).bind(numeric, numeric, numeric, String(reason || '').slice(0, 2000), item.id, actor).run();
  await env.DB.prepare(`
    INSERT INTO platform_control_events
      (control_id, transaction_creation_enabled, payment_creation_enabled, merchant_onboarding_enabled,
       reason, source_case_id, actor_type, actor_ref)
    VALUES ('GLOBAL', ?, ?, ?, ?, ?, 'OPERATOR', ?)
  `).bind(numeric, numeric, numeric, String(reason || '').slice(0, 2000), item.id, actor).run();
  return { enabled, transaction_creation_enabled: Boolean(numeric), payment_creation_enabled: Boolean(numeric), merchant_onboarding_enabled: Boolean(numeric) };
}

async function resolveCase(env, caseId, resolution) {
  await env.DB.prepare(`
    UPDATE internal_cases
       SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP,
           resolution = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(String(resolution || 'Resolved').slice(0, 2000), caseId).run();
  return { resolved: true, resolution };
}

async function escalateCase(env, caseId, target, note) {
  await env.DB.prepare(`
    UPDATE internal_cases
       SET status = 'ESCALATED', escalation_target = ?,
           resolution = COALESCE(?, resolution), updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(target, note ? String(note).slice(0, 2000) : null, caseId).run();
  return { escalated: true, target };
}

async function caseMerchantId(env, item) {
  if (item.merchant_id) return item.merchant_id;
  if (item.transaction_id) {
    const row = await env.DB.prepare(`SELECT merchant_id FROM transactions WHERE id = ?`).bind(item.transaction_id).first();
    if (row?.merchant_id) return row.merchant_id;
  }
  if (item.subject_type === 'MERCHANT' && item.subject_id) return item.subject_id;
  return null;
}

async function resolveRelatedEntities(env, subjectType, subjectId) {
  if (subjectType === 'TRANSACTION' && subjectId) {
    const row = await env.DB.prepare(`SELECT id, merchant_id FROM transactions WHERE id = ?`).bind(subjectId).first();
    return { transaction_id: row?.id || null, merchant_id: row?.merchant_id || null };
  }
  if (subjectType === 'MERCHANT' && subjectId) return { transaction_id: null, merchant_id: subjectId };
  return { transaction_id: null, merchant_id: null };
}

async function firstActionLabel(env, caseTypeCode) {
  const row = await env.DB.prepare(`
    SELECT label FROM internal_case_actions
    WHERE case_type_code = ? AND enabled = 1
    ORDER BY sequence ASC LIMIT 1
  `).bind(caseTypeCode).first();
  return row?.label || 'Follow runbook';
}

function alertContext(alert) {
  return {
    alert_key: alert.alert_key,
    category: alert.category,
    severity: alert.severity,
    subject_type: alert.subject_type,
    subject_id: alert.subject_id,
    occurrences: Number(alert.occurrences || 1),
    first_seen_at: alert.first_seen_at,
    last_seen_at: alert.last_seen_at,
  };
}

function safeInput(input) {
  return {
    note: input?.note ? String(input.note).slice(0, 2000) : null,
    human_seconds: clampHumanSeconds(input?.human_seconds),
  };
}

function clampHumanSeconds(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Math.round(number), 8 * 60 * 60);
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function isOpenInternalCaseStatus(value) {
  return OPEN_CASE_STATUSES.includes(String(value || '').toUpperCase());
}

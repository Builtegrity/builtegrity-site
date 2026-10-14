import { releaseFeeCarryReservation } from './pricing.js';

const MAX_ALERTS_PER_RUN = 500;
const MICROS_PER_CENT = 10000;

export async function runResolutionAutopilot(env, options = {}) {
  const stats = {
    opened: 0,
    resolved: 0,
    notices_sent: 0,
    notices_failed: 0,
    work_dispatched: 0,
    work_timed_out: 0,
    carry_released: 0,
    blocked: 0,
  };

  stats.carry_released += await releaseAbandonedCarry(env);
  stats.resolved += await closeResolvedInstances(env);
  stats.work_timed_out += await timeoutExpiredWorkOrders(env);

  const alerts = await env.DB.prepare(`
    SELECT * FROM system_alerts
    WHERE status='OPEN'
    ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'ERROR' THEN 2 WHEN 'WARN' THEN 3 ELSE 4 END,
             first_seen_at ASC
    LIMIT ?
  `).bind(Number(options.limit || MAX_ALERTS_PER_RUN)).all();

  for (const alert of alerts.results || []) {
    const playbookCode = classifyResolutionPlaybook(alert);
    if (!playbookCode) continue;
    const context = await resolveAlertContext(env, alert);
    const instance = await ensureResolutionInstance(env, alert, playbookCode, context);
    if (instance.created) stats.opened += 1;

    const playbook = await env.DB.prepare(`SELECT * FROM resolution_playbooks WHERE code=? AND active=1`).bind(playbookCode).first();
    if (!playbook) continue;

    if (['MERCHANT', 'CUSTOMER'].includes(playbook.party_type)) {
      const notice = await maybeSendGuidance(env, instance.row, playbook, context);
      if (notice.sent) stats.notices_sent += 1;
      if (notice.failed) stats.notices_failed += 1;
      if (notice.blocked) stats.blocked += 1;
    }

    if (Number(playbook.outsourcing_allowed || 0) === 1 && playbook.outsource_category) {
      const dispatched = await maybeDispatchWork(env, instance.row, playbook, alert, context);
      if (dispatched) stats.work_dispatched += 1;
    }
  }

  return stats;
}

export function classifyResolutionPlaybook(alert) {
  const key = String(alert?.alert_key || '');
  const category = String(alert?.category || '').toUpperCase();

  if (key.startsWith('tx:payout-failed:')) return 'STRIPE_PAYOUT_FAILED';
  if (key.startsWith('tx:payout-overdue:')) return 'STRIPE_PAYOUT_DELAYED';
  if (key.startsWith('dependency:stripe-account:')) return 'STRIPE_ACCOUNT_REQUIREMENTS';
  if (key.startsWith('tx:stale-payment-pending:')) return 'CUSTOMER_PAYMENT_INCOMPLETE';
  if (key.startsWith('webhook:failed:')) return 'WEBHOOK_RECOVERY';
  if (key.startsWith('tx:missing-processor-records:')) return 'PROCESSOR_RECORD_RECONCILIATION';
  if (key.startsWith('tx:fee-shortfall:')) return 'FEE_RECONCILIATION';
  if (key === 'dependency:clerk-jwks') return 'CLERK_DEPENDENCY';
  if (key === 'dependency:public-health-route') return 'PUBLIC_RUNTIME_DEPENDENCY';
  if (key.startsWith('dependency:resend-')) return 'RESEND_DEPENDENCY';
  if (key.startsWith('config:')) return 'PLATFORM_CONFIGURATION';
  if (key.startsWith('tx:complete-not-accounted:') || key.startsWith('merchant:processor-account:')) return 'DATA_INTEGRITY';
  if (key.startsWith('merchant:financial-responsibility:') || key.startsWith('finance:')) return 'FINANCIAL_SAFETY';
  if (category === 'SECURITY') return 'SECURITY_HOLD';
  if (category === 'LEGAL') return 'LEGAL_HOLD';
  if (['ERROR', 'CRITICAL'].includes(String(alert?.severity || '').toUpperCase())) return 'UNKNOWN_TECHNICAL';
  return null;
}

async function resolveAlertContext(env, alert) {
  const context = {
    merchant_id: null,
    customer_id: null,
    transaction_id: null,
    merchant_email: null,
    customer_email: null,
    payment_access_token: null,
    merchant_name: null,
  };

  if (alert.subject_type === 'TRANSACTION' && alert.subject_id) {
    const row = await env.DB.prepare(`
      SELECT t.id AS transaction_id, t.merchant_id, t.customer_id, t.payment_access_token,
             m.email AS merchant_email, m.name AS merchant_name,
             c.email AS customer_email
      FROM transactions t
      JOIN merchants m ON m.id=t.merchant_id
      LEFT JOIN customers c ON c.id=t.customer_id AND c.merchant_id=t.merchant_id
      WHERE t.id=?
    `).bind(alert.subject_id).first();
    if (row) Object.assign(context, row);
  } else if (alert.subject_type === 'MERCHANT' && alert.subject_id) {
    const row = await env.DB.prepare(`SELECT id AS merchant_id, email AS merchant_email, name AS merchant_name FROM merchants WHERE id=?`).bind(alert.subject_id).first();
    if (row) Object.assign(context, row);
  }

  return context;
}

async function ensureResolutionInstance(env, alert, playbookCode, context) {
  let row = await env.DB.prepare(`
    SELECT * FROM resolution_instances
    WHERE source_alert_key=? AND status<>'RESOLVED'
    LIMIT 1
  `).bind(alert.alert_key).first();
  if (row) {
    await env.DB.prepare(`
      UPDATE system_alerts
         SET resolution_playbook_code=?, resolution_party_type=?, resolution_instance_id=?
       WHERE alert_key=?
    `).bind(playbookCode, row.party_type, row.id, alert.alert_key).run();
    return { row, created: false };
  }

  const playbook = await env.DB.prepare(`SELECT * FROM resolution_playbooks WHERE code=? AND active=1`).bind(playbookCode).first();
  if (!playbook) throw new Error(`Resolution playbook ${playbookCode} is unavailable`);
  const id = `RES-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO resolution_instances (
      id, source_alert_key, internal_case_id, playbook_code, party_type, provider_code,
      merchant_id, customer_id, transaction_id, verification_handler, next_check_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(
    id,
    alert.alert_key,
    alert.internal_case_id || null,
    playbook.code,
    playbook.party_type,
    playbook.provider_code || null,
    context.merchant_id || null,
    context.customer_id || null,
    context.transaction_id || null,
    playbook.verification_handler,
  ).run();

  await env.DB.prepare(`
    UPDATE system_alerts
       SET resolution_playbook_code=?, resolution_party_type=?, resolution_instance_id=?
     WHERE alert_key=?
  `).bind(playbook.code, playbook.party_type, id, alert.alert_key).run();
  if (alert.internal_case_id) {
    await env.DB.prepare(`UPDATE internal_cases SET resolution_instance_id=? WHERE id=?`).bind(id, alert.internal_case_id).run().catch(() => null);
  }
  row = await env.DB.prepare(`SELECT * FROM resolution_instances WHERE id=?`).bind(id).first();
  return { row, created: true };
}

async function maybeSendGuidance(env, instance, playbook, context) {
  const ageMinutes = minutesSince(instance.opened_at);
  if (ageMinutes < Number(playbook.notify_after_minutes || 0)) return { sent: false };

  const latest = await env.DB.prepare(`
    SELECT * FROM resolution_notifications
    WHERE resolution_instance_id=? AND audience_type=? AND status='SENT'
    ORDER BY created_at DESC LIMIT 1
  `).bind(instance.id, playbook.party_type).first();
  if (latest && minutesSince(latest.created_at) < Number(playbook.repeat_notice_minutes || 1440)) return { sent: false };

  const recipient = playbook.party_type === 'MERCHANT' ? context.merchant_email : context.customer_email;
  if (!recipient) {
    await markResolutionBlocked(env, instance.id, `${playbook.party_type} email is unavailable`);
    await openAutopilotAlert(env, `resolution:recipient-missing:${instance.id}`, 'RESOLUTION', 'ERROR', 'RESOLUTION', instance.id,
      `${playbook.party_type} guidance could not be delivered because no recipient email is stored.`);
    return { sent: false, blocked: true };
  }
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL_FROM) {
    await markResolutionBlocked(env, instance.id, 'Resend delivery configuration is unavailable');
    await openAutopilotAlert(env, `dependency:resend-config:${instance.id}`, 'DEPENDENCY', 'ERROR', 'RESOLUTION', instance.id,
      'Resolution guidance cannot be delivered because RESEND_API_KEY or ALERT_EMAIL_FROM is missing.');
    return { sent: false, blocked: true };
  }

  const steps = await loadResolutionSteps(env, playbook.code);
  const text = buildGuidanceText(env, instance, playbook, context, steps);
  const notificationId = `RNOT-${crypto.randomUUID()}`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: String(env.RESOLUTION_EMAIL_FROM || env.ALERT_EMAIL_FROM),
        to: [recipient],
        subject: `Action needed: ${playbook.title}`,
        text,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || `Resend HTTP ${response.status}`);

    await env.DB.prepare(`
      INSERT INTO resolution_notifications
        (id,resolution_instance_id,audience_type,recipient,status,provider_message_id)
      VALUES (?,?,?,?, 'SENT', ?)
    `).bind(notificationId, instance.id, playbook.party_type, recipient, payload.id || null).run();
    await env.DB.prepare(`
      UPDATE resolution_instances
         SET status='NOTIFIED', updated_at=CURRENT_TIMESTAMP,
             next_check_at=datetime('now','+15 minutes'), last_error=NULL
       WHERE id=?
    `).bind(instance.id).run();
    await resolveResendDependencyAlerts(env, instance.id);
    return { sent: true };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    await env.DB.prepare(`
      INSERT INTO resolution_notifications
        (id,resolution_instance_id,audience_type,recipient,status,error_text)
      VALUES (?,?,?,?, 'FAILED', ?)
    `).bind(notificationId, instance.id, playbook.party_type, recipient, message).run();
    await env.DB.prepare(`
      UPDATE resolution_instances SET last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).bind(message, instance.id).run();
    await openAutopilotAlert(env, `dependency:resend-api:${instance.id}`, 'DEPENDENCY', 'ERROR', 'RESOLUTION', instance.id,
      `Resend failed while delivering required resolution guidance: ${message}`);
    return { sent: false, failed: true };
  }
}

function buildGuidanceText(env, instance, playbook, context, steps) {
  const lines = [
    playbook.title,
    '',
    'Builtegrity detected a condition that needs action. Follow the steps below in order. You do not need to tell Builtegrity when you are done—the system verifies the underlying condition automatically.',
    '',
  ];
  for (const step of steps) {
    lines.push(`${step.sequence}. ${step.title}`);
    lines.push(step.instruction);
    const url = resolutionStepUrl(env, step, context);
    if (url) lines.push(url);
    if (step.automatic_verification_note) lines.push(`Verification: ${step.automatic_verification_note}`);
    lines.push('');
  }
  lines.push(`Resolution reference: ${instance.id}`);
  lines.push('For security, never send passwords, card numbers, bank credentials, SSNs, identity documents, API keys, or secret tokens by reply email.');
  return lines.join('\n');
}

function resolutionStepUrl(env, step, context) {
  if (step.link_kind === 'PAYMENT') {
    if (!context.payment_access_token) return null;
    return `${String(env.APP_BASE_URL || '').replace(/\/$/, '')}/pay/?token=${encodeURIComponent(context.payment_access_token)}`;
  }
  return step.explicit_url || null;
}

async function loadResolutionSteps(env, playbookCode) {
  const rows = await env.DB.prepare(`
    SELECT * FROM resolution_steps WHERE playbook_code=? ORDER BY sequence
  `).bind(playbookCode).all();
  return rows.results || [];
}

async function maybeDispatchWork(env, instance, playbook, alert, context) {
  if (minutesSince(instance.opened_at) < Number(playbook.outsource_after_minutes || 0)) return false;
  const existing = await env.DB.prepare(`
    SELECT * FROM workforce_work_orders
    WHERE resolution_instance_id=? AND status IN ('CREATED','DISPATCHED','WAITING_VERIFICATION')
    ORDER BY attempt_number DESC LIMIT 1
  `).bind(instance.id).first();
  if (existing) return false;

  const policy = await env.DB.prepare(`SELECT * FROM workforce_policy WHERE id='GLOBAL'`).first();
  if (!policy || Number(policy.auto_dispatch_enabled) !== 1) return false;
  const prior = await env.DB.prepare(`
    SELECT vendor_id, MAX(attempt_number) AS max_attempt
    FROM workforce_work_orders WHERE resolution_instance_id=? GROUP BY vendor_id
  `).bind(instance.id).all();
  const excluded = new Set((prior.results || []).map((row) => row.vendor_id));
  const maxAttempt = Math.max(0, ...(prior.results || []).map((row) => Number(row.max_attempt || 0)));
  if (maxAttempt >= Number(policy.max_vendor_attempts || 3)) {
    await markResolutionBlocked(env, instance.id, 'Approved workforce attempts exhausted');
    return false;
  }

  const candidate = await selectVendor(env, playbook, policy, excluded);
  if (!candidate) {
    await env.DB.prepare(`
      UPDATE resolution_instances SET status='WAITING_VENDOR', updated_at=CURRENT_TIMESTAMP,
        last_error='No approved in-budget workforce vendor is currently configured.' WHERE id=?
    `).bind(instance.id).run();
    return false;
  }

  const workOrderId = `WORK-${crypto.randomUUID()}`;
  const steps = await loadResolutionSteps(env, playbook.code);
  const scope = buildVendorScope(instance, playbook, alert, steps);
  const estimate = Number(candidate.unit_cost_cents || playbook.default_work_budget_cents || 0);
  const budget = Math.min(
    Number(policy.max_single_work_order_cents || 0),
    Number(candidate.per_work_order_cap_cents || 0),
    Math.max(estimate, Number(playbook.default_work_budget_cents || 0)),
  );
  const verifyBy = new Date(Date.now() + Number(candidate.default_sla_minutes || playbook.default_sla_minutes || 240) * 60000).toISOString();

  await env.DB.prepare(`
    INSERT INTO workforce_work_orders (
      id,resolution_instance_id,vendor_id,category,status,attempt_number,scope_text,
      verification_handler,estimated_cost_cents,approved_budget_cents,payment_status,verify_by
    ) VALUES (?,?,?,?, 'CREATED', ?, ?, ?, ?, ?, 'NOT_DUE', ?)
  `).bind(
    workOrderId, instance.id, candidate.id, playbook.outsource_category,
    maxAttempt + 1, scope, playbook.verification_handler, estimate, budget, verifyBy,
  ).run();
  await appendWorkEvent(env, workOrderId, 'CREATED', { alert_key: alert.alert_key, provider: playbook.provider_code || null });

  const dispatched = await dispatchWorkOrder(env, workOrderId, candidate, scope, budget, verifyBy);
  if (!dispatched) return false;
  await env.DB.prepare(`
    UPDATE resolution_instances SET status='WAITING_VENDOR', updated_at=CURRENT_TIMESTAMP,
      next_check_at=datetime('now','+15 minutes'), last_error=NULL WHERE id=?
  `).bind(instance.id).run();
  return true;
}

async function selectVendor(env, playbook, policy, excluded) {
  const result = await env.DB.prepare(`
    SELECT v.*, c.unit_type, c.unit_cost_cents, c.max_data_class
    FROM workforce_vendors v
    JOIN workforce_vendor_capabilities c ON c.vendor_id=v.id
    WHERE v.status='APPROVED'
      AND v.auto_dispatch_enabled=1
      AND v.contract_status='ACTIVE'
      AND v.tax_status='CLEARED'
      AND c.category=? AND c.approved=1
      AND c.unit_cost_cents > 0
      AND v.per_work_order_cap_cents > 0
      AND v.monthly_cap_cents > 0
    ORDER BY c.unit_cost_cents ASC, v.default_sla_minutes ASC, v.id
  `).bind(playbook.outsource_category).all();

  const globalSpend = await currentMonthCommittedCost(env);
  for (const vendor of result.results || []) {
    if (excluded.has(vendor.id)) continue;
    if (Number(playbook.privileged_access_required || 0) === 1 && Number(vendor.privileged_access_approved || 0) !== 1) continue;
    const estimated = Number(vendor.unit_cost_cents || playbook.default_work_budget_cents || 0);
    if (estimated <= 0) continue;
    if (estimated > Number(policy.max_single_work_order_cents || 0)) continue;
    if (estimated > Number(vendor.per_work_order_cap_cents || 0)) continue;
    if (globalSpend + estimated > Number(policy.monthly_budget_cents || 0)) continue;
    const vendorSpend = await currentMonthCommittedCost(env, vendor.id);
    if (vendorSpend + estimated > Number(vendor.monthly_cap_cents || 0)) continue;
    return vendor;
  }
  return null;
}

async function currentMonthCommittedCost(env, vendorId = null) {
  const sql = `
    SELECT COALESCE(SUM(estimated_cost_cents),0) AS cents
    FROM workforce_work_orders
    WHERE status<>'CANCELLED' AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now')
      ${vendorId ? 'AND vendor_id=?' : ''}
  `;
  const row = vendorId
    ? await env.DB.prepare(sql).bind(vendorId).first()
    : await env.DB.prepare(sql).first();
  return Number(row?.cents || 0);
}

function buildVendorScope(instance, playbook, alert, steps) {
  const lines = [
    `Builtegrity work order for ${playbook.title}`,
    `Resolution reference: ${instance.id}`,
    `Alert: ${alert.alert_key}`,
    `Severity: ${alert.severity}`,
    `Subject: ${alert.subject_type || 'SYSTEM'} ${alert.subject_id || ''}`.trim(),
    '',
    'Objective:',
    String(alert.message || playbook.title).slice(0, 1200),
    '',
    'Rules:',
    '- Do not request or transmit card data, passwords, API keys, bank credentials, SSNs, or identity documents in the work-order channel.',
    '- Do not manually rewrite transaction history or bypass financial/security/legal controls.',
    '- The work is not considered complete because a human says so. Builtegrity must independently observe the originating alert clear.',
    '',
    'Runbook:',
  ];
  for (const step of steps) {
    if (step.actor_type === 'CUSTOMER' || step.actor_type === 'MERCHANT') continue;
    lines.push(`${step.sequence}. ${step.title}: ${step.instruction}${step.explicit_url ? ` ${step.explicit_url}` : ''}`);
  }
  return lines.join('\n').slice(0, 12000);
}

async function dispatchWorkOrder(env, workOrderId, vendor, scope, budgetCents, verifyBy) {
  try {
    let externalReference = null;
    if (vendor.dispatch_mode === 'EMAIL') {
      if (!vendor.dispatch_email) throw new Error('Approved vendor has no dispatch email');
      if (!env.RESEND_API_KEY || !env.ALERT_EMAIL_FROM) throw new Error('Resend dispatch configuration is unavailable');
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: String(env.WORKFORCE_EMAIL_FROM || env.ALERT_EMAIL_FROM),
          to: [vendor.dispatch_email],
          subject: `[Builtegrity ${workOrderId}] automated work order`,
          text: `${scope}\n\nMaximum authorized project budget: $${(budgetCents / 100).toFixed(2)}\nVerification deadline: ${verifyBy}\nThis request is automatically generated under the standing Builtegrity vendor agreement.`,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || `Resend HTTP ${response.status}`);
      externalReference = payload.id || null;
    } else if (vendor.dispatch_mode === 'WEBHOOK') {
      if (!vendor.dispatch_endpoint) throw new Error('Approved vendor has no dispatch endpoint');
      const secret = vendor.dispatch_secret_env_key ? env[vendor.dispatch_secret_env_key] : null;
      if (!secret) throw new Error('Approved vendor dispatch secret is unavailable');
      const response = await fetch(vendor.dispatch_endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ work_order_id: workOrderId, scope, budget_cents: budgetCents, verify_by: verifyBy }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || `Vendor dispatch HTTP ${response.status}`);
      externalReference = payload.id || payload.reference || null;
    } else {
      throw new Error(`Unsupported dispatch mode ${vendor.dispatch_mode}`);
    }

    await env.DB.prepare(`
      UPDATE workforce_work_orders
         SET status='WAITING_VERIFICATION', external_reference=?, dispatched_at=CURRENT_TIMESTAMP,
             payment_status=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?
    `).bind(externalReference, vendor.payment_mode === 'EXTERNAL_AUTOPAY' ? 'EXTERNAL_AUTOPAY' : 'NOT_DUE', workOrderId).run();
    await appendWorkEvent(env, workOrderId, 'DISPATCHED', { external_reference: externalReference, vendor_id: vendor.id });
    return true;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    await env.DB.prepare(`
      UPDATE workforce_work_orders SET status='FAILED', failure_reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).bind(message, workOrderId).run();
    await appendWorkEvent(env, workOrderId, 'DISPATCH_FAILED', { error: message });
    await openAutopilotAlert(env, `workforce:dispatch-failed:${workOrderId}`, 'WORKFORCE', 'ERROR', 'WORK_ORDER', workOrderId, message);
    return false;
  }
}

async function closeResolvedInstances(env) {
  const rows = await env.DB.prepare(`
    SELECT r.* FROM resolution_instances r
    JOIN system_alerts a ON a.alert_key=r.source_alert_key
    WHERE r.status<>'RESOLVED' AND a.status='RESOLVED'
    LIMIT 500
  `).all();
  let count = 0;
  for (const instance of rows.results || []) {
    await env.DB.prepare(`
      UPDATE resolution_instances
         SET status='RESOLVED', resolved_at=CURRENT_TIMESTAMP, last_verified_at=CURRENT_TIMESTAMP,
             verification_attempts=verification_attempts+1, updated_at=CURRENT_TIMESTAMP, last_error=NULL
       WHERE id=?
    `).bind(instance.id).run();

    const work = await env.DB.prepare(`
      SELECT w.*, v.payment_mode, v.payment_endpoint, v.payment_secret_env_key
      FROM workforce_work_orders w JOIN workforce_vendors v ON v.id=w.vendor_id
      WHERE w.resolution_instance_id=? AND w.status='WAITING_VERIFICATION'
    `).bind(instance.id).all();
    for (const order of work.results || []) {
      await env.DB.prepare(`
        UPDATE workforce_work_orders SET status='VERIFIED', verified_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).bind(order.id).run();
      await appendWorkEvent(env, order.id, 'MACHINE_VERIFIED', { source_alert_key: instance.source_alert_key });
      await settleVerifiedWorkOrder(env, order);
    }
    count += 1;
  }
  return count;
}

async function settleVerifiedWorkOrder(env, order) {
  if (order.payment_mode === 'EXTERNAL_AUTOPAY') return;
  if (order.payment_mode !== 'WEBHOOK_AFTER_VERIFICATION') return;
  const secret = order.payment_secret_env_key ? env[order.payment_secret_env_key] : null;
  if (!order.payment_endpoint || !secret) {
    await env.DB.prepare(`UPDATE workforce_work_orders SET payment_status='HELD', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(order.id).run();
    await appendWorkEvent(env, order.id, 'PAYMENT_HELD', { reason: 'payment adapter is not fully configured' });
    return;
  }
  try {
    await env.DB.prepare(`UPDATE workforce_work_orders SET payment_status='PAYMENT_PENDING', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(order.id).run();
    const response = await fetch(order.payment_endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        work_order_id: order.id,
        amount_cents: Number(order.estimated_cost_cents || 0),
        verification: 'BUILTEGRITY_MACHINE_VERIFIED',
      }),
    });
    if (!response.ok) throw new Error(`payment adapter HTTP ${response.status}`);
    await env.DB.prepare(`UPDATE workforce_work_orders SET payment_status='PAID', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(order.id).run();
    await appendWorkEvent(env, order.id, 'PAYMENT_CONFIRMED', { amount_cents: Number(order.estimated_cost_cents || 0) });
  } catch (error) {
    await env.DB.prepare(`UPDATE workforce_work_orders SET payment_status='HELD', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(order.id).run();
    await appendWorkEvent(env, order.id, 'PAYMENT_HELD', { error: String(error?.message || error).slice(0, 1000) });
    await openAutopilotAlert(env, `workforce:payment-held:${order.id}`, 'WORKFORCE', 'ERROR', 'WORK_ORDER', order.id,
      `Verified outsourced work could not settle automatically: ${String(error?.message || error)}`);
  }
}

async function timeoutExpiredWorkOrders(env) {
  const result = await env.DB.prepare(`
    SELECT * FROM workforce_work_orders
    WHERE status='WAITING_VERIFICATION' AND verify_by IS NOT NULL AND verify_by < CURRENT_TIMESTAMP
    LIMIT 200
  `).all();
  for (const order of result.results || []) {
    await env.DB.prepare(`
      UPDATE workforce_work_orders SET status='TIMED_OUT', failure_reason='Originating condition did not clear before SLA', updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).bind(order.id).run();
    await appendWorkEvent(env, order.id, 'TIMED_OUT', { verify_by: order.verify_by });
  }
  return (result.results || []).length;
}

async function releaseAbandonedCarry(env) {
  const result = await env.DB.prepare(`
    SELECT id FROM transactions
    WHERE pricing_carry_reserved_cents > 0
      AND pricing_carry_settled_cents = 0
      AND payment_at IS NULL
      AND datetime(updated_at) < datetime('now','-24 hours')
    LIMIT 500
  `).all().catch(() => ({ results: [] }));
  let released = 0;
  for (const row of result.results || []) {
    const outcome = await releaseFeeCarryReservation(env, row.id, 'checkout abandoned for more than 24 hours');
    if (outcome.released) released += 1;
  }
  return released;
}

async function resolveResendDependencyAlerts(env, instanceId) {
  await env.DB.prepare(`
    UPDATE system_alerts
       SET status='RESOLVED', resolved_at=CURRENT_TIMESTAMP, last_seen_at=CURRENT_TIMESTAMP
     WHERE status='OPEN' AND alert_key IN (?, ?)
  `).bind(`dependency:resend-config:${instanceId}`, `dependency:resend-api:${instanceId}`).run();
}

async function markResolutionBlocked(env, instanceId, message) {
  await env.DB.prepare(`
    UPDATE resolution_instances SET status='BLOCKED', last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).bind(String(message).slice(0, 1000), instanceId).run();
}

async function appendWorkEvent(env, workOrderId, eventType, details = {}) {
  await env.DB.prepare(`
    INSERT INTO workforce_work_order_events (work_order_id,event_type,details_json) VALUES (?,?,?)
  `).bind(workOrderId, eventType, JSON.stringify(details)).run();
}

async function openAutopilotAlert(env, key, category, severity, subjectType, subjectId, message) {
  await env.DB.prepare(`
    INSERT INTO system_alerts
      (alert_key,category,severity,status,subject_type,subject_id,message)
    VALUES (?,?,?,'OPEN',?,?,?)
    ON CONFLICT(alert_key) DO UPDATE SET
      status='OPEN', severity=excluded.severity, message=excluded.message,
      last_seen_at=CURRENT_TIMESTAMP, occurrences=system_alerts.occurrences+1, resolved_at=NULL
  `).bind(key, category, severity, subjectType, subjectId, String(message || '').slice(0, 2000)).run();
}

function minutesSince(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, (Date.now() - time) / 60000);
}

export const AUTOPILOT_CONSTANTS = { MICROS_PER_CENT };

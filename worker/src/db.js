const LIFECYCLE_RANK = {
  CREATED: 0,
  CONSENTED: 1,
  PAYMENT_PENDING: 2,
  PAID: 3,
  PAYOUT_PENDING: 4,
  COMPLETE: 5,
};

export async function allocateId(env, prefix, width = 4) {
  const row = await env.DB.prepare(
    `UPDATE id_counters
       SET next_value = next_value + 1
     WHERE prefix = ?
     RETURNING next_value - 1 AS value`
  ).bind(prefix).first();

  if (!row) throw new Error(`Missing id counter for ${prefix}`);
  return `${prefix}-${String(row.value).padStart(width, '0')}`;
}

export async function getTransaction(env, txId) {
  const transaction = await env.DB.prepare(`
    SELECT
      t.*,
      p.merchant_reference,
      p.purchase_type,
      p.description AS purchase_description,
      p.total_value_cents,
      m.name AS merchant_name,
      m.email AS merchant_email,
      m.partner_id,
      m.processor_account_id,
      m.integration_mode,
      c.name AS customer_name,
      c.email AS customer_email,
      ptn.name AS partner_name,
      ptn.partner_type
    FROM transactions t
    JOIN purchases p ON p.id = t.purchase_id
    JOIN merchants m ON m.id = t.merchant_id
    JOIN customers c ON c.id = t.customer_id
    JOIN partners ptn ON ptn.id = m.partner_id
    WHERE t.id = ?
  `).bind(txId).first();

  if (!transaction) return null;

  const [eventsResult, exceptionsResult] = await Promise.all([
    env.DB.prepare(`
      SELECT * FROM transaction_events
      WHERE transaction_id = ?
      ORDER BY event_at ASC, created_at ASC
    `).bind(txId).all(),
    env.DB.prepare(`
      SELECT * FROM transaction_exceptions
      WHERE transaction_id = ?
      ORDER BY opened_at ASC
    `).bind(txId).all(),
  ]);

  const events = (eventsResult.results || []).map((event) => ({
    ...event,
    event_data: parseJson(event.event_data_json),
  }));

  return {
    ...transaction,
    events,
    exceptions: exceptionsResult.results || [],
  };
}

export async function listTransactions(env, limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const result = await env.DB.prepare(`
    SELECT * FROM transaction_console
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(safeLimit).all();
  return result.results || [];
}

export async function recordEvent(
  env,
  transactionId,
  eventType,
  source = 'SYSTEM',
  sourceEventId = null,
  data = {},
  eventAt = null,
) {
  const eventId = await allocateId(env, 'EVT', 6);
  const sql = eventAt
    ? `INSERT OR IGNORE INTO transaction_events
       (id, transaction_id, event_type, source, source_event_id, event_at, event_data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    : `INSERT OR IGNORE INTO transaction_events
       (id, transaction_id, event_type, source, source_event_id, event_data_json)
       VALUES (?, ?, ?, ?, ?, ?)`;

  const args = eventAt
    ? [eventId, transactionId, eventType, source, sourceEventId, eventAt, JSON.stringify(data || {})]
    : [eventId, transactionId, eventType, source, sourceEventId, JSON.stringify(data || {})];

  const result = await env.DB.prepare(sql).bind(...args).run();
  return { eventId, inserted: Number(result.meta?.changes || 0) > 0 };
}

export async function advanceLifecycle(env, transactionId, targetStatus) {
  if (!(targetStatus in LIFECYCLE_RANK)) throw new Error(`Unknown lifecycle status: ${targetStatus}`);
  const tx = await env.DB.prepare(
    `SELECT lifecycle_status FROM transactions WHERE id = ?`
  ).bind(transactionId).first();
  if (!tx) throw new Error(`Transaction not found: ${transactionId}`);

  if (LIFECYCLE_RANK[targetStatus] <= LIFECYCLE_RANK[tx.lifecycle_status]) {
    return tx.lifecycle_status;
  }

  await env.DB.prepare(`
    UPDATE transactions
       SET lifecycle_status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(targetStatus, transactionId).run();

  return targetStatus;
}

export async function openException(env, transactionId, exceptionType, summary = null) {
  const existing = await env.DB.prepare(`
    SELECT id FROM transaction_exceptions
    WHERE transaction_id = ? AND exception_type = ? AND status = 'OPEN'
    LIMIT 1
  `).bind(transactionId, exceptionType).first();

  if (existing) {
    await recomputeIntegrity(env, transactionId);
    return existing.id;
  }

  const exceptionId = await allocateId(env, 'EXC', 6);
  await env.DB.prepare(`
    INSERT INTO transaction_exceptions
      (id, transaction_id, exception_type, status, summary)
    VALUES (?, ?, ?, 'OPEN', ?)
  `).bind(exceptionId, transactionId, exceptionType, summary).run();

  await recomputeIntegrity(env, transactionId);
  return exceptionId;
}

export async function resolveException(env, transactionId, exceptionType, resolution = null) {
  await env.DB.prepare(`
    UPDATE transaction_exceptions
       SET status = 'RESOLVED',
           resolved_at = CURRENT_TIMESTAMP,
           resolution = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE transaction_id = ?
       AND exception_type = ?
       AND status = 'OPEN'
  `).bind(resolution, transactionId, exceptionType).run();

  await recomputeIntegrity(env, transactionId);
}

export async function recomputeIntegrity(env, transactionId) {
  const tx = await env.DB.prepare(`
    SELECT * FROM transactions WHERE id = ?
  `).bind(transactionId).first();
  if (!tx) throw new Error(`Transaction not found: ${transactionId}`);

  const open = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM transaction_exceptions
    WHERE transaction_id = ? AND status = 'OPEN'
  `).bind(transactionId).first();

  const hasOpenExceptions = Number(open?.count || 0) > 0;
  const expectedTermsHash = tx.terms_snapshot ? await sha256Hex(tx.terms_snapshot) : null;
  const termsIntegrity = Number(tx.consent_accepted) === 1 &&
    Boolean(expectedTermsHash) &&
    expectedTermsHash === tx.terms_snapshot_sha256;
  const paymentIntegrity = String(tx.payment_status || '').toLowerCase() === 'succeeded';
  const amountIntegrity = Number(tx.customer_paid_cents) === Number(tx.amount_cents);
  const feeIntegrity = tx.fee_collection_method !== 'STRIPE_APPLICATION_FEE' ||
    Number(tx.integrity_fee_collected_cents || 0) >= Number(tx.integrity_fee_earned_cents || 0);
  const payoutNetIntegrity = tx.expected_merchant_net_cents !== null &&
    tx.expected_merchant_net_cents !== undefined &&
    tx.actual_merchant_net_cents !== null &&
    tx.actual_merchant_net_cents !== undefined &&
    Number(tx.actual_merchant_net_cents) === Number(tx.expected_merchant_net_cents);

  const fullyAccounted =
    tx.lifecycle_status === 'COMPLETE' &&
    termsIntegrity &&
    paymentIntegrity &&
    amountIntegrity &&
    feeIntegrity &&
    payoutNetIntegrity &&
    Boolean(tx.stripe_payment_intent_id) &&
    Boolean(tx.stripe_charge_id) &&
    Boolean(tx.stripe_balance_transaction_id) &&
    Boolean(tx.stripe_payout_id) &&
    Number(tx.payout_accounted) === 1 &&
    String(tx.processor_payout_status || '').toLowerCase() === 'paid';

  const exceptionStatus = hasOpenExceptions ? 'NEEDS_ATTENTION' : 'NONE';
  const integrityStatus = hasOpenExceptions
    ? 'NEEDS_ATTENTION'
    : fullyAccounted
      ? 'ACCOUNTED'
      : 'INCOMPLETE';

  await env.DB.prepare(`
    UPDATE transactions
       SET integrity_status = ?,
           exception_status = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(integrityStatus, exceptionStatus, transactionId).run();

  return {
    integrityStatus,
    exceptionStatus,
    checks: {
      terms_integrity: termsIntegrity,
      payment_integrity: paymentIntegrity,
      amount_integrity: amountIntegrity,
      fee_integrity: feeIntegrity,
      payout_net_integrity: payoutNetIntegrity,
    },
  };
}

export async function claimWebhook(env, event) {
  const inserted = await env.DB.prepare(`
    INSERT OR IGNORE INTO stripe_webhook_receipts
      (event_id, event_type, account_id, status, attempts)
    VALUES (?, ?, ?, 'PROCESSING', 1)
  `).bind(event.id, event.type, event.account || null).run();

  if (Number(inserted.meta?.changes || 0) > 0) {
    return { claimed: true, alreadyProcessed: false };
  }

  const existing = await env.DB.prepare(`
    SELECT * FROM stripe_webhook_receipts WHERE event_id = ?
  `).bind(event.id).first();

  if (!existing) throw new Error(`Webhook receipt disappeared during claim: ${event.id}`);
  if (existing.status === 'PROCESSED') return { claimed: false, alreadyProcessed: true };

  if (existing.status === 'PROCESSING') {
    const updatedAt = Date.parse(existing.updated_at || existing.received_at || '');
    const stale = Number.isFinite(updatedAt) && (Date.now() - updatedAt) >= 15 * 60 * 1000;
    if (!stale) return { claimed: false, inProgress: true };
  }

  const reclaimed = await env.DB.prepare(`
    UPDATE stripe_webhook_receipts
       SET status = 'PROCESSING',
           attempts = attempts + 1,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE event_id = ? AND status != 'PROCESSED'
  `).bind(event.id).run();

  return {
    claimed: Number(reclaimed.meta?.changes || 0) > 0,
    alreadyProcessed: false,
  };
}

export async function finishWebhook(env, eventId) {
  await env.DB.prepare(`
    UPDATE stripe_webhook_receipts
       SET status = 'PROCESSED',
           processed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE event_id = ?
  `).bind(eventId).run();
}

export async function failWebhook(env, eventId, error) {
  await env.DB.prepare(`
    UPDATE stripe_webhook_receipts
       SET status = 'FAILED',
           last_error = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE event_id = ?
  `).bind(String(error?.message || error || 'Unknown webhook error').slice(0, 2000), eventId).run();
}

export function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

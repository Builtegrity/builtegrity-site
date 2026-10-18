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
      v.verified_at AS integrity_verified_at,
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
    LEFT JOIN transaction_integrity_verifications v ON v.transaction_id=t.id
    JOIN purchases p ON p.id = t.purchase_id
    JOIN merchants m ON m.id = t.merchant_id
    JOIN customers c ON c.id = t.customer_id
    JOIN partners ptn ON ptn.id = m.partner_id
    WHERE t.id = ?
  `).bind(txId).first();

  if (!transaction) return null;

  const [eventsResult, exceptionsResult, economics] = await Promise.all([
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
    getTransactionEconomics(env, txId),
  ]);

  const events = (eventsResult.results || []).map((event) => ({
    ...event,
    event_data: parseJson(event.event_data_json),
  }));

  return {
    ...transaction,
    events,
    exceptions: exceptionsResult.results || [],
    economics,
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
  const processorTrace = tx.processor === 'SQUARE'
    ? Boolean(tx.processor_checkout_id && tx.processor_order_id && tx.processor_payment_id && tx.processor_payout_id)
    : Boolean(tx.stripe_payment_intent_id && tx.stripe_charge_id && tx.stripe_balance_transaction_id && tx.stripe_payout_id);
  const fullyAccounted =
    tx.lifecycle_status === 'COMPLETE' &&
    Number(tx.consent_accepted) === 1 &&
    processorTrace &&
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
     WHERE id = ? AND (integrity_status <> ? OR exception_status <> ?)
  `).bind(integrityStatus, exceptionStatus, transactionId,integrityStatus,exceptionStatus).run();

  return { integrityStatus, exceptionStatus };
}

export async function recordEconomicEntry(env, transactionId, entry) {
  const id = await allocateId(env, 'ECO', 6);
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO transaction_economics_ledger (
      id, transaction_id, entry_kind, category, amount_micros, basis,
      quantity, unit_cost_micros, cost_model_id, source_ref, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    transactionId,
    entry.entry_kind,
    entry.category,
    Math.trunc(Number(entry.amount_micros || 0)),
    entry.basis,
    entry.quantity ?? null,
    entry.unit_cost_micros ?? null,
    entry.cost_model_id || null,
    entry.source_ref || null,
    JSON.stringify(entry.details || {}),
  ).run();

  return { id, inserted: Number(result.meta?.changes || 0) > 0 };
}

export async function initializeTransactionEconomics(env, transactionId, expectedFeeCents) {
  const model = await env.DB.prepare(`
    SELECT * FROM transaction_cost_models
    WHERE status = 'ACTIVE'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).first();

  const feeMicros = Math.max(0, Number(expectedFeeCents || 0)) * 10000;
  await recordEconomicEntry(env, transactionId, {
    entry_kind: 'REVENUE',
    category: 'INTEGRITY_FEE',
    amount_micros: feeMicros,
    basis: 'ESTIMATED',
    source_ref: 'initial:integrity-fee',
    details: { fee_payer: 'MERCHANT' },
  });

  if (!model) return;

  const entries = [
    {
      category: 'CORE_INFRASTRUCTURE',
      amount_micros: Number(model.core_infra_cost_micros || 0),
      quantity: 1,
      unit_cost_micros: Number(model.core_infra_cost_micros || 0),
    },
    {
      category: 'TRANSACTION_EMAIL_BUDGET',
      amount_micros: Number(model.email_cost_micros_per_message || 0) * Number(model.assumed_email_messages || 0),
      quantity: Number(model.assumed_email_messages || 0),
      unit_cost_micros: Number(model.email_cost_micros_per_message || 0),
    },
    {
      category: 'LIFETIME_STORAGE',
      amount_micros: Number(model.lifetime_storage_cost_micros || 0),
      quantity: 1,
      unit_cost_micros: Number(model.lifetime_storage_cost_micros || 0),
    },
  ];

  for (const entry of entries) {
    await recordEconomicEntry(env, transactionId, {
      entry_kind: 'COST',
      category: entry.category,
      amount_micros: entry.amount_micros,
      basis: 'ESTIMATED',
      quantity: entry.quantity,
      unit_cost_micros: entry.unit_cost_micros,
      cost_model_id: model.id,
      source_ref: `initial:${entry.category.toLowerCase()}`,
    });
  }
}

export async function getTransactionEconomics(env, transactionId) {
  const [summary, ledgerResult, pdfResult] = await Promise.all([
    env.DB.prepare(`SELECT * FROM transaction_economics_summary WHERE transaction_id = ?`).bind(transactionId).first(),
    env.DB.prepare(`
      SELECT * FROM transaction_economics_ledger
      WHERE transaction_id = ?
      ORDER BY created_at ASC, id ASC
    `).bind(transactionId).all(),
    env.DB.prepare(`
      SELECT * FROM transaction_pdf_requests
      WHERE transaction_id = ?
      ORDER BY requested_at DESC
      LIMIT 25
    `).bind(transactionId).all(),
  ]);

  return {
    summary: summary || null,
    ledger: (ledgerResult.results || []).map((entry) => ({
      ...entry,
      details: parseJson(entry.details_json),
    })),
    pdf_requests: pdfResult.results || [],
  };
}

export async function createPdfRequest(env, transactionId, requestedByType, requestedByRef = null) {
  const id = await allocateId(env, 'PDF', 6);
  await env.DB.prepare(`
    INSERT INTO transaction_pdf_requests
      (id, transaction_id, requested_by_type, requested_by_ref, status)
    VALUES (?, ?, ?, ?, 'REQUESTED')
  `).bind(id, transactionId, requestedByType, requestedByRef).run();
  return id;
}

export async function completePdfRequest(env, requestId, values = {}) {
  await env.DB.prepare(`
    UPDATE transaction_pdf_requests
       SET status = 'GENERATED',
           cache_hit = ?,
           object_key = ?,
           byte_length = ?,
           generated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(
    values.cache_hit ? 1 : 0,
    values.object_key || null,
    Number.isFinite(Number(values.byte_length)) ? Number(values.byte_length) : null,
    requestId,
  ).run();
}

export async function failPdfRequest(env, requestId, error) {
  await env.DB.prepare(`
    UPDATE transaction_pdf_requests
       SET status = 'FAILED',
           error_message = ?,
           generated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(String(error?.message || error || 'Unknown PDF generation error').slice(0, 2000), requestId).run();
}

export async function claimWebhook(env, event) {
  const existing = await env.DB.prepare(`
    SELECT * FROM stripe_webhook_receipts WHERE event_id = ?
  `).bind(event.id).first();

  if (existing?.status === 'PROCESSED') return { claimed: false, alreadyProcessed: true };

  if (!existing) {
    await env.DB.prepare(`
      INSERT INTO stripe_webhook_receipts
        (event_id, event_type, account_id, status, attempts)
      VALUES (?, ?, ?, 'PROCESSING', 1)
    `).bind(event.id, event.type, event.account || null).run();
    return { claimed: true, alreadyProcessed: false };
  }

  await env.DB.prepare(`
    UPDATE stripe_webhook_receipts
       SET status = 'PROCESSING',
           attempts = attempts + 1,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE event_id = ?
  `).bind(event.id).run();

  return { claimed: true, alreadyProcessed: false };
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

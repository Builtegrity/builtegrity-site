const GENERATION_BATCH_SIZE = 4;
const DELIVERY_BATCH_SIZE = 20;
const STALE_WORK_MINUTES = 30;
const MAX_RETRY_MINUTES = 1440;

export async function runMonthlyStatementPipeline(env, options = {}) {
  if (!env.DB) throw new Error('Monthly statement pipeline requires D1 binding DB');

  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid statement pipeline clock');
  const period = previousUtcMonth(now);

  await recoverStaleWork(env);
  const seeded = await seedMonthlyStatements(env, period);
  const generated = await generateDueStatements(env, options.generationBatchSize || GENERATION_BATCH_SIZE);
  const prepared = await prepareDeliveries(env);
  const delivered = await deliverDueStatements(env, options.deliveryBatchSize || DELIVERY_BATCH_SIZE);
  const health = await reconcileStatementHealth(env, period);

  return {
    period: period.label,
    seeded,
    generated,
    prepared,
    delivered,
    health,
  };
}

export async function getMonthlyStatementStatus(env, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 100), 500));
  const statements = await env.DB.prepare(`
    SELECT id, scope_type, scope_id, period_label, statement_version, status,
           transaction_count, merchant_count, protected_volume_cents,
           builtegrity_fee_cents, exception_count, accounted_count,
           object_key, pdf_sha256, pdf_byte_length, generated_at,
           generation_attempts, next_generation_attempt_at, last_error,
           created_at, updated_at
      FROM monthly_statements
     ORDER BY period_start DESC, scope_type, scope_id
     LIMIT ?
  `).bind(limit).all();

  const deliveries = await env.DB.prepare(`
    SELECT d.id, d.statement_id, d.recipient_email, d.status, d.attempts,
           d.next_attempt_at, d.provider_message_id, d.delivered_at,
           d.last_attempt_at, d.last_error
      FROM monthly_statement_deliveries d
      JOIN monthly_statements s ON s.id = d.statement_id
     ORDER BY s.period_start DESC, d.created_at DESC
     LIMIT ?
  `).bind(limit).all();

  return {
    statements: statements.results || [],
    deliveries: deliveries.results || [],
  };
}

export async function loadMonthlyStatementPdf(env, statementId) {
  const statement = await env.DB.prepare(`
    SELECT id, object_key, pdf_sha256, generated_at
      FROM monthly_statements
     WHERE id = ?
  `).bind(statementId).first();
  if (!statement?.generated_at || !statement.object_key) return null;
  if (!env.TRANSACTION_RECORDS) throw new Error('TRANSACTION_RECORDS binding is required to serve monthly statements');
  const object = await env.TRANSACTION_RECORDS.get(statement.object_key);
  if (!object) throw new Error(`Stored PDF is missing for ${statement.id}`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  const hash = await sha256Hex(bytes);
  if (hash !== statement.pdf_sha256) throw new Error(`Stored PDF hash mismatch for ${statement.id}`);
  return { statement, bytes };
}

async function seedMonthlyStatements(env, period) {
  const merchantResult = await env.DB.prepare(`
    INSERT OR IGNORE INTO monthly_statements
      (id, scope_type, scope_id, period_start, period_end_exclusive, period_label, statement_version)
    SELECT
      'STM-MER-' || m.id || '-' || ? || '-V1',
      'MERCHANT', m.id, ?, ?, ?, 1
    FROM merchants m
    WHERE m.status IN ('ACTIVE','PAUSED','DISCONNECTED')
       OR EXISTS (
         SELECT 1 FROM transactions t
         WHERE t.merchant_id = m.id
           AND datetime(t.created_at) >= datetime(?)
           AND datetime(t.created_at) < datetime(?)
       )
  `).bind(period.compact, period.start, period.endExclusive, period.label, period.start, period.endExclusive).run();

  const partnerResult = await env.DB.prepare(`
    INSERT OR IGNORE INTO monthly_statements
      (id, scope_type, scope_id, period_start, period_end_exclusive, period_label, statement_version)
    SELECT
      'STM-PAR-' || p.id || '-' || ? || '-V1',
      'PARTNER', p.id, ?, ?, ?, 1
    FROM partners p
    WHERE p.status = 'ACTIVE'
       OR EXISTS (
         SELECT 1
           FROM merchants m
           JOIN transactions t ON t.merchant_id = m.id
          WHERE m.partner_id = p.id
            AND datetime(t.created_at) >= datetime(?)
            AND datetime(t.created_at) < datetime(?)
       )
  `).bind(period.compact, period.start, period.endExclusive, period.label, period.start, period.endExclusive).run();

  return Number(merchantResult.meta?.changes || 0) + Number(partnerResult.meta?.changes || 0);
}

async function recoverStaleWork(env) {
  await env.DB.prepare(`
    UPDATE monthly_statements
       SET status = 'FAILED',
           last_error = 'Recovered stale GENERATING lease',
           next_generation_attempt_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE status = 'GENERATING'
       AND datetime(updated_at) < datetime('now', ?)
  `).bind(`-${STALE_WORK_MINUTES} minutes`).run();

  await env.DB.prepare(`
    UPDATE monthly_statement_deliveries
       SET status = 'RETRY',
           last_error = COALESCE(last_error, 'Recovered stale SENDING lease'),
           next_attempt_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE status = 'SENDING'
       AND datetime(updated_at) < datetime('now', ?)
  `).bind(`-${STALE_WORK_MINUTES} minutes`).run();
}

async function generateDueStatements(env, batchSize) {
  const due = await env.DB.prepare(`
    SELECT *
      FROM monthly_statements
     WHERE status IN ('PENDING','FAILED')
       AND (next_generation_attempt_at IS NULL OR datetime(next_generation_attempt_at) <= datetime('now'))
     ORDER BY period_start ASC, scope_type, scope_id
     LIMIT ?
  `).bind(Math.max(1, Math.min(Number(batchSize || GENERATION_BATCH_SIZE), 20))).all();

  let completed = 0;
  let failed = 0;
  for (const statement of due.results || []) {
    const claimed = await env.DB.prepare(`
      UPDATE monthly_statements
         SET status = 'GENERATING', generation_attempts = generation_attempts + 1,
             next_generation_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN ('PENDING','FAILED')
    `).bind(statement.id).run();
    if (!Number(claimed.meta?.changes || 0)) continue;

    try {
      await generateStatement(env, statement.id);
      completed += 1;
    } catch (error) {
      failed += 1;
      const refreshed = await env.DB.prepare(`SELECT generation_attempts FROM monthly_statements WHERE id = ?`).bind(statement.id).first();
      const delay = retryMinutes(Number(refreshed?.generation_attempts || 1));
      await env.DB.prepare(`
        UPDATE monthly_statements
           SET status = 'FAILED', last_error = ?,
               next_generation_attempt_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).bind(errorText(error), `+${delay} minutes`, statement.id).run();
      await upsertAlert(env, {
        key: `statement:generation:${statement.id}`,
        severity: 'ERROR',
        subjectType: 'STATEMENT',
        subjectId: statement.id,
        message: `Monthly statement generation failed and will retry automatically: ${errorText(error)}`,
      });
    }
  }
  return { completed, failed };
}

async function generateStatement(env, statementId) {
  let statement = await env.DB.prepare(`SELECT * FROM monthly_statements WHERE id = ?`).bind(statementId).first();
  if (!statement) throw new Error(`Statement ${statementId} not found`);
  if (!env.TRANSACTION_RECORDS) throw new Error('TRANSACTION_RECORDS R2 binding is required for monthly statement durability');

  let snapshot;
  if (statement.snapshot_json) {
    snapshot = JSON.parse(statement.snapshot_json);
    const hash = await sha256Hex(new TextEncoder().encode(statement.snapshot_json));
    if (hash !== statement.snapshot_sha256) throw new Error(`Source snapshot hash mismatch for ${statement.id}`);
  } else {
    snapshot = statement.scope_type === 'MERCHANT'
      ? await buildMerchantSnapshot(env, statement)
      : await buildPartnerSnapshot(env, statement);
    const snapshotJson = JSON.stringify(snapshot);
    const snapshotHash = await sha256Hex(new TextEncoder().encode(snapshotJson));
    await env.DB.prepare(`
      UPDATE monthly_statements
         SET snapshot_json = ?, snapshot_sha256 = ?, source_as_of = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND snapshot_json IS NULL
    `).bind(snapshotJson, snapshotHash, statement.id).run();
    statement = await env.DB.prepare(`SELECT * FROM monthly_statements WHERE id = ?`).bind(statement.id).first();
    snapshot = JSON.parse(statement.snapshot_json);
  }

  if (statement.scope_type === 'MERCHANT') {
    await persistMerchantItems(env, statement.id, snapshot.items || []);
  }

  const bytes = buildStatementPdf(snapshot);
  const pdfHash = await sha256Hex(bytes);
  const objectKey = `monthly-statements/${statement.scope_type.toLowerCase()}/${statement.scope_id}/${statement.period_label}/v${statement.statement_version}.pdf`;
  await env.TRANSACTION_RECORDS.put(objectKey, bytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: {
      statementId: statement.id,
      scopeType: statement.scope_type,
      scopeId: statement.scope_id,
      period: statement.period_label,
      sha256: pdfHash,
    },
  });

  const summary = snapshot.summary || {};
  await env.DB.prepare(`
    UPDATE monthly_statements
       SET status = 'GENERATED',
           transaction_count = ?, merchant_count = ?, protected_volume_cents = ?,
           builtegrity_fee_cents = ?, exception_count = ?, accounted_count = ?,
           object_key = ?, pdf_sha256 = ?, pdf_byte_length = ?,
           generated_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(
    Number(summary.transaction_count || 0),
    Number(summary.merchant_count || 0),
    Number(summary.protected_volume_cents || 0),
    Number(summary.builtegrity_fee_cents || 0),
    Number(summary.exception_count || 0),
    Number(summary.accounted_count || 0),
    objectKey,
    pdfHash,
    bytes.byteLength,
    statement.id,
  ).run();

  await resolveAlert(env, `statement:generation:${statement.id}`);
}

async function buildMerchantSnapshot(env, statement) {
  const merchant = await env.DB.prepare(`
    SELECT m.id, m.name, m.statement_email, m.email, p.name AS partner_name
      FROM merchants m
      JOIN partners p ON p.id = m.partner_id
     WHERE m.id = ?
  `).bind(statement.scope_id).first();
  if (!merchant) throw new Error(`Merchant ${statement.scope_id} not found`);

  const result = await env.DB.prepare(`
    SELECT t.id AS transaction_id, t.amount_cents, t.currency,
           t.integrity_fee_collected_cents AS integrity_fee_cents,
           t.payment_status, t.processor_payout_status AS payout_status,
           t.integrity_status, t.exception_status, t.payment_at,
           t.description AS transaction_description,
           COALESCE(c.merchant_customer_reference, c.name, c.id) AS customer_reference,
           COALESCE(p.merchant_reference, p.id) AS purchase_reference
      FROM transactions t
      JOIN customers c ON c.id = t.customer_id
      JOIN purchases p ON p.id = t.purchase_id
     WHERE t.merchant_id = ?
       AND datetime(t.created_at) >= datetime(?)
       AND datetime(t.created_at) < datetime(?)
     ORDER BY t.created_at, t.id
  `).bind(statement.scope_id, statement.period_start, statement.period_end_exclusive).all();

  const items = (result.results || []).map((row) => ({
    transaction_id: row.transaction_id,
    merchant_id: merchant.id,
    merchant_name: merchant.name,
    customer_reference: row.customer_reference || null,
    purchase_reference: row.purchase_reference || null,
    transaction_description: row.transaction_description || null,
    amount_cents: Number(row.amount_cents || 0),
    currency: row.currency || 'USD',
    integrity_fee_cents: Number(row.integrity_fee_cents || 0),
    payment_status: row.payment_status || null,
    payout_status: row.payout_status || null,
    integrity_status: row.integrity_status,
    exception_status: row.exception_status,
    payment_at: row.payment_at || null,
  }));

  return {
    kind: 'MERCHANT_MONTHLY_STATEMENT',
    statement_id: statement.id,
    period_label: statement.period_label,
    period_start: statement.period_start,
    period_end_exclusive: statement.period_end_exclusive,
    merchant: { id: merchant.id, name: merchant.name, partner_name: merchant.partner_name },
    summary: summarizeMerchantItems(items),
    items,
    generated_from: 'Builtegrity canonical transaction records',
  };
}

async function buildPartnerSnapshot(env, statement) {
  const partner = await env.DB.prepare(`SELECT id, name, partner_type, statement_email FROM partners WHERE id = ?`).bind(statement.scope_id).first();
  if (!partner) throw new Error(`Partner ${statement.scope_id} not found`);

  const result = await env.DB.prepare(`
    SELECT m.id AS merchant_id, m.name AS merchant_name,
           COUNT(t.id) AS transaction_count,
           COALESCE(SUM(CASE WHEN lower(COALESCE(t.payment_status,'')) = 'succeeded' THEN t.amount_cents ELSE 0 END),0) AS protected_volume_cents,
           COALESCE(SUM(t.integrity_fee_collected_cents),0) AS builtegrity_fee_cents,
           COALESCE(SUM(CASE WHEN t.exception_status = 'NEEDS_ATTENTION' THEN 1 ELSE 0 END),0) AS exception_count,
           COALESCE(SUM(CASE WHEN t.integrity_status = 'ACCOUNTED' THEN 1 ELSE 0 END),0) AS accounted_count
      FROM merchants m
      LEFT JOIN transactions t
        ON t.merchant_id = m.id
       AND datetime(t.created_at) >= datetime(?)
       AND datetime(t.created_at) < datetime(?)
     WHERE m.partner_id = ?
     GROUP BY m.id, m.name
     ORDER BY m.name, m.id
  `).bind(statement.period_start, statement.period_end_exclusive, statement.scope_id).all();

  const merchants = (result.results || []).map((row) => ({
    merchant_id: row.merchant_id,
    merchant_name: row.merchant_name,
    transaction_count: Number(row.transaction_count || 0),
    protected_volume_cents: Number(row.protected_volume_cents || 0),
    builtegrity_fee_cents: Number(row.builtegrity_fee_cents || 0),
    exception_count: Number(row.exception_count || 0),
    accounted_count: Number(row.accounted_count || 0),
  }));

  return {
    kind: 'PARTNER_MONTHLY_STATEMENT',
    statement_id: statement.id,
    period_label: statement.period_label,
    period_start: statement.period_start,
    period_end_exclusive: statement.period_end_exclusive,
    partner: { id: partner.id, name: partner.name, partner_type: partner.partner_type },
    summary: {
      merchant_count: merchants.length,
      transaction_count: merchants.reduce((sum, row) => sum + row.transaction_count, 0),
      protected_volume_cents: merchants.reduce((sum, row) => sum + row.protected_volume_cents, 0),
      builtegrity_fee_cents: merchants.reduce((sum, row) => sum + row.builtegrity_fee_cents, 0),
      exception_count: merchants.reduce((sum, row) => sum + row.exception_count, 0),
      accounted_count: merchants.reduce((sum, row) => sum + row.accounted_count, 0),
    },
    merchants,
    generated_from: 'Builtegrity canonical merchant transaction records',
  };
}

function summarizeMerchantItems(items) {
  return {
    merchant_count: 1,
    transaction_count: items.length,
    protected_volume_cents: items.reduce((sum, row) => sum + (String(row.payment_status || '').toLowerCase() === 'succeeded' ? row.amount_cents : 0), 0),
    builtegrity_fee_cents: items.reduce((sum, row) => sum + row.integrity_fee_cents, 0),
    exception_count: items.reduce((sum, row) => sum + (row.exception_status === 'NEEDS_ATTENTION' ? 1 : 0), 0),
    accounted_count: items.reduce((sum, row) => sum + (row.integrity_status === 'ACCOUNTED' ? 1 : 0), 0),
  };
}

async function persistMerchantItems(env, statementId, items) {
  if (!items.length) return;
  const statements = items.map((item) => env.DB.prepare(`
    INSERT OR IGNORE INTO monthly_statement_items
      (id, statement_id, transaction_id, merchant_id, merchant_name,
       customer_reference, purchase_reference, transaction_description,
       amount_cents, currency, integrity_fee_cents, payment_status, payout_status,
       integrity_status, exception_status, payment_at, snapshot_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    `STMI-${statementId}-${item.transaction_id}`,
    statementId,
    item.transaction_id,
    item.merchant_id,
    item.merchant_name,
    item.customer_reference,
    item.purchase_reference,
    item.transaction_description,
    item.amount_cents,
    item.currency,
    item.integrity_fee_cents,
    item.payment_status,
    item.payout_status,
    item.integrity_status,
    item.exception_status,
    item.payment_at,
    JSON.stringify(item),
  ));
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
}

async function prepareDeliveries(env) {
  const rows = await env.DB.prepare(`
    SELECT s.id, s.scope_type, s.scope_id, s.status,
           CASE
             WHEN s.scope_type = 'MERCHANT' THEN COALESCE(m.statement_email, m.email)
             WHEN s.scope_type = 'PARTNER' THEN p.statement_email
           END AS recipient_email,
           p.partner_type
      FROM monthly_statements s
      LEFT JOIN merchants m ON s.scope_type = 'MERCHANT' AND m.id = s.scope_id
      LEFT JOIN partners p ON s.scope_type = 'PARTNER' AND p.id = s.scope_id
     WHERE s.generated_at IS NOT NULL
       AND s.status IN ('GENERATED','DELIVERY_PENDING','AWAITING_RECIPIENT')
     ORDER BY s.period_start ASC
     LIMIT 200
  `).all();

  let created = 0;
  let awaitingRecipient = 0;
  for (const row of rows.results || []) {
    const email = normalizeEmail(row.recipient_email);
    if (!email) {
      awaitingRecipient += 1;
      await env.DB.prepare(`UPDATE monthly_statements SET status='AWAITING_RECIPIENT', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(row.id).run();
      if (!(row.scope_type === 'PARTNER' && row.partner_type === 'HOUSE')) {
        await upsertAlert(env, {
          key: `statement:recipient:${row.id}`,
          severity: 'WARN',
          subjectType: row.scope_type,
          subjectId: row.scope_id,
          message: `${row.id} is generated but has no statement delivery email. Delivery will resume automatically after an address is configured.`,
        });
      }
      continue;
    }

    const deliveryId = `STMD-${row.id}-${await sha256Short(email)}`;
    const inserted = await env.DB.prepare(`
      INSERT OR IGNORE INTO monthly_statement_deliveries
        (id, statement_id, recipient_email, status, next_attempt_at)
      VALUES (?, ?, ?, 'PENDING', CURRENT_TIMESTAMP)
    `).bind(deliveryId, row.id, email).run();
    created += Number(inserted.meta?.changes || 0);
    await env.DB.prepare(`UPDATE monthly_statements SET status='DELIVERY_PENDING', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status <> 'DELIVERED'`).bind(row.id).run();
    await resolveAlert(env, `statement:recipient:${row.id}`);
  }
  return { created, awaiting_recipient: awaitingRecipient };
}

async function deliverDueStatements(env, batchSize) {
  const due = await env.DB.prepare(`
    SELECT d.*, s.scope_type, s.scope_id, s.period_label, s.object_key,
           s.pdf_sha256, s.pdf_byte_length,
           CASE WHEN s.scope_type='MERCHANT' THEN m.name ELSE p.name END AS scope_name
      FROM monthly_statement_deliveries d
      JOIN monthly_statements s ON s.id = d.statement_id
      LEFT JOIN merchants m ON s.scope_type='MERCHANT' AND m.id=s.scope_id
      LEFT JOIN partners p ON s.scope_type='PARTNER' AND p.id=s.scope_id
     WHERE d.status IN ('PENDING','RETRY')
       AND (d.next_attempt_at IS NULL OR datetime(d.next_attempt_at) <= datetime('now'))
     ORDER BY d.created_at
     LIMIT ?
  `).bind(Math.max(1, Math.min(Number(batchSize || DELIVERY_BATCH_SIZE), 100))).all();

  let delivered = 0;
  let failed = 0;
  for (const delivery of due.results || []) {
    const claimed = await env.DB.prepare(`
      UPDATE monthly_statement_deliveries
         SET status='SENDING', attempts=attempts+1, last_attempt_at=CURRENT_TIMESTAMP,
             updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND status IN ('PENDING','RETRY')
    `).bind(delivery.id).run();
    if (!Number(claimed.meta?.changes || 0)) continue;

    try {
      await deliverStatementEmail(env, delivery);
      delivered += 1;
      await env.DB.prepare(`
        UPDATE monthly_statement_deliveries
           SET status='DELIVERED', delivered_at=CURRENT_TIMESTAMP,
               next_attempt_at=NULL, last_error=NULL, updated_at=CURRENT_TIMESTAMP
         WHERE id=?
      `).bind(delivery.id).run();
      const pending = await env.DB.prepare(`
        SELECT COUNT(*) AS count FROM monthly_statement_deliveries
         WHERE statement_id=? AND status <> 'DELIVERED'
      `).bind(delivery.statement_id).first();
      if (Number(pending?.count || 0) === 0) {
        await env.DB.prepare(`UPDATE monthly_statements SET status='DELIVERED', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(delivery.statement_id).run();
      }
      await resolveAlert(env, `statement:delivery:${delivery.statement_id}`);
    } catch (error) {
      failed += 1;
      const refreshed = await env.DB.prepare(`SELECT attempts FROM monthly_statement_deliveries WHERE id=?`).bind(delivery.id).first();
      const delay = retryMinutes(Number(refreshed?.attempts || 1));
      await env.DB.prepare(`
        UPDATE monthly_statement_deliveries
           SET status='RETRY', next_attempt_at=datetime('now', ?),
               last_error=?, updated_at=CURRENT_TIMESTAMP
         WHERE id=?
      `).bind(`+${delay} minutes`, errorText(error), delivery.id).run();
      await upsertAlert(env, {
        key: `statement:delivery:${delivery.statement_id}`,
        severity: Number(refreshed?.attempts || 1) >= 4 ? 'ERROR' : 'WARN',
        subjectType: 'STATEMENT',
        subjectId: delivery.statement_id,
        message: `Monthly statement email failed; automatic retry is scheduled in ${delay} minute(s): ${errorText(error)}`,
      });
    }
  }
  return { delivered, failed };
}

async function deliverStatementEmail(env, delivery) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
  const from = String(env.STATEMENT_EMAIL_FROM || '').trim();
  if (!from) throw new Error('STATEMENT_EMAIL_FROM is not configured');
  if (!env.TRANSACTION_RECORDS) throw new Error('TRANSACTION_RECORDS binding is not configured');

  const object = await env.TRANSACTION_RECORDS.get(delivery.object_key);
  if (!object) throw new Error(`Statement PDF object is missing: ${delivery.object_key}`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  const hash = await sha256Hex(bytes);
  if (hash !== delivery.pdf_sha256) throw new Error(`Statement PDF hash mismatch for ${delivery.statement_id}`);

  const body = {
    from,
    to: [delivery.recipient_email],
    subject: `Builtegrity monthly transaction statement — ${delivery.period_label}`,
    text: [
      `${delivery.scope_name || delivery.scope_id},`,
      '',
      `Attached is your Builtegrity monthly transaction statement for ${delivery.period_label}.`,
      delivery.scope_type === 'PARTNER'
        ? 'The statement is summarized by merchant and intentionally does not expose merchant customer details.'
        : 'The statement itemizes the Builtegrity transactions created for your merchant account during the period.',
      '',
      'This is an operational transaction-integrity statement generated from Builtegrity records. It is not a bank statement, processor statement, tax return, or accounting opinion.',
      '',
      'Every payment accounted for.',
    ].join('\n'),
    attachments: [{
      filename: `builtegrity-${delivery.period_label}-${delivery.scope_id}.pdf`,
      content: bytesToBase64(bytes),
      content_type: 'application/pdf',
    }],
    tags: [
      { name: 'type', value: 'monthly-statement' },
      { name: 'period', value: delivery.period_label.replace(/[^A-Za-z0-9_-]/g, '-') },
    ],
  };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
      'Idempotency-Key': `monthly-statement/${delivery.id}`.slice(0, 256),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Resend HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 800)}`);
  const providerId = payload.id || payload.data?.id || null;
  if (providerId) {
    await env.DB.prepare(`UPDATE monthly_statement_deliveries SET provider_message_id=? WHERE id=?`).bind(providerId, delivery.id).run();
  }
}

async function reconcileStatementHealth(env, period) {
  const overdue = await env.DB.prepare(`
    SELECT COUNT(*) AS count
      FROM monthly_statements
     WHERE period_start = ?
       AND status <> 'DELIVERED'
       AND NOT (scope_type='PARTNER' AND scope_id IN (SELECT id FROM partners WHERE partner_type='HOUSE' AND statement_email IS NULL))
  `).bind(period.start).first();

  const failedGeneration = await env.DB.prepare(`SELECT COUNT(*) AS count FROM monthly_statements WHERE status='FAILED'`).first();
  const deliveryRetries = await env.DB.prepare(`SELECT COUNT(*) AS count FROM monthly_statement_deliveries WHERE status='RETRY'`).first();

  return {
    undelivered_current_period: Number(overdue?.count || 0),
    failed_generation: Number(failedGeneration?.count || 0),
    delivery_retries: Number(deliveryRetries?.count || 0),
  };
}

async function upsertAlert(env, alert) {
  await env.DB.prepare(`
    INSERT INTO system_alerts
      (alert_key, category, severity, status, subject_type, subject_id, message)
    VALUES (?, 'STATEMENT', ?, 'OPEN', ?, ?, ?)
    ON CONFLICT(alert_key) DO UPDATE SET
      severity=excluded.severity, status='OPEN', subject_type=excluded.subject_type,
      subject_id=excluded.subject_id, message=excluded.message,
      last_seen_at=CURRENT_TIMESTAMP, resolved_at=NULL,
      occurrences=system_alerts.occurrences+1
  `).bind(alert.key, alert.severity, alert.subjectType || null, alert.subjectId || null, String(alert.message || '').slice(0, 2000)).run();
}

async function resolveAlert(env, key) {
  await env.DB.prepare(`
    UPDATE system_alerts SET status='RESOLVED', resolved_at=CURRENT_TIMESTAMP, last_seen_at=CURRENT_TIMESTAMP
     WHERE alert_key=? AND status='OPEN'
  `).bind(key).run();
}

function buildStatementPdf(snapshot) {
  const lines = [];
  lines.push('BUILTEGRITY MONTHLY TRANSACTION STATEMENT');
  lines.push('Every payment accounted for.');
  lines.push('');
  lines.push(`Statement: ${display(snapshot.statement_id)}`);
  lines.push(`Period: ${display(snapshot.period_label)} (UTC calendar month)`);
  if (snapshot.kind === 'MERCHANT_MONTHLY_STATEMENT') {
    lines.push(`Merchant: ${display(snapshot.merchant.name)} (${display(snapshot.merchant.id)})`);
    lines.push(`Partner: ${display(snapshot.merchant.partner_name || 'Builtegrity Direct')}`);
  } else {
    lines.push(`Partner: ${display(snapshot.partner.name)} (${display(snapshot.partner.id)})`);
  }
  lines.push('');
  lines.push('SUMMARY');
  lines.push(`Transactions: ${Number(snapshot.summary.transaction_count || 0)}`);
  lines.push(`Successful protected volume: ${formatMoney(snapshot.summary.protected_volume_cents || 0)}`);
  lines.push(`Builtegrity fees recorded: ${formatMoney(snapshot.summary.builtegrity_fee_cents || 0)}`);
  lines.push(`Accounted transactions: ${Number(snapshot.summary.accounted_count || 0)}`);
  lines.push(`Transactions needing attention: ${Number(snapshot.summary.exception_count || 0)}`);

  if (snapshot.kind === 'MERCHANT_MONTHLY_STATEMENT') {
    lines.push('');
    lines.push('TRANSACTION DETAIL');
    for (const item of snapshot.items || []) {
      lines.push(`${display(item.transaction_id)} | ${formatMoney(item.amount_cents, item.currency)} | Customer ${display(item.customer_reference || 'n/a')} | Purchase ${display(item.purchase_reference || 'n/a')} | Payment ${display(item.payment_status || 'pending')} | Payout ${display(item.payout_status || 'pending')} | Integrity ${display(item.integrity_status)}`);
    }
  } else {
    lines.push('');
    lines.push('MERCHANT DETAIL');
    for (const merchant of snapshot.merchants || []) {
      lines.push(`${display(merchant.merchant_name)} (${display(merchant.merchant_id)}) | ${merchant.transaction_count} tx | ${formatMoney(merchant.protected_volume_cents)} volume | ${formatMoney(merchant.builtegrity_fee_cents)} Builtegrity fees | ${merchant.exception_count} needing attention`);
    }
    lines.push('');
    lines.push('Partner statements are intentionally merchant-level and do not disclose merchant customer details.');
  }

  lines.push('');
  lines.push('This is an operational transaction-integrity statement generated from Builtegrity canonical records.');
  lines.push('It is not a bank statement, processor statement, tax return, legal opinion, or accounting opinion.');
  lines.push('The immutable structured Builtegrity record remains authoritative if this rendered PDF and later system views differ.');
  return createSimplePdf(lines);
}

function createSimplePdf(lines) {
  const wrapped = lines.flatMap((line) => wrapLine(line, 92));
  const pageSize = 46;
  const pages = [];
  for (let i = 0; i < wrapped.length; i += pageSize) pages.push(wrapped.slice(i, i + pageSize));
  if (!pages.length) pages.push(['Builtegrity Monthly Transaction Statement']);

  const objects = [];
  const reserve = () => { objects.push(''); return objects.length; };
  const set = (id, value) => { objects[id - 1] = value; };
  const catalogId = reserve();
  const pagesId = reserve();
  const fontId = reserve();
  set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageIds = [];
  for (const pageLines of pages) {
    const contentId = reserve();
    const pageId = reserve();
    pageIds.push(pageId);
    const stream = pageStream(pageLines);
    set(contentId, `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
  }
  set(pagesId, `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
  set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let pdf = '%PDF-1.4\n% Builtegrity\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

function pageStream(lines) {
  const commands = ['BT', '/F1 9 Tf', '42 748 Td', '12 TL'];
  lines.forEach((line, index) => {
    if (index > 0) commands.push('T*');
    commands.push(`(${escapePdf(line)}) Tj`);
  });
  commands.push('ET');
  return commands.join('\n');
}

function wrapLine(value, width) {
  const text = display(value);
  if (text.length <= width) return [text];
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= width) current += ` ${word}`;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
}

function escapePdf(value) {
  return display(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function display(value) {
  return String(value ?? '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '?');
}

function formatMoney(cents, currency = 'USD') {
  const value = Number(cents || 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency || 'USD').toUpperCase() }).format(value);
  } catch {
    return `${String(currency || 'USD').toUpperCase()} ${value.toFixed(2)}`;
  }
}

function previousUtcMonth(now) {
  const startThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(startThisMonth.getUTCFullYear(), startThisMonth.getUTCMonth() - 1, 1));
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + 1;
  return {
    start: start.toISOString(),
    endExclusive: startThisMonth.toISOString(),
    label: `${year}-${String(month).padStart(2, '0')}`,
    compact: `${year}${String(month).padStart(2, '0')}`,
  };
}

function retryMinutes(attempts) {
  return Math.min(MAX_RETRY_MINUTES, Math.max(15, 15 * (2 ** Math.min(Math.max(attempts - 1, 0), 7))));
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Short(value) {
  const hex = await sha256Hex(new TextEncoder().encode(String(value)));
  return hex.slice(0, 16);
}

function bytesToBase64(bytes) {
  const chunkSize = 24_576;
  const pieces = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    let binary = '';
    for (let j = 0; j < chunk.length; j += 1) binary += String.fromCharCode(chunk[j]);
    pieces.push(btoa(binary));
  }
  return pieces.join('');
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function errorText(error) {
  return String(error?.message || error || 'Unknown error').slice(0, 2000);
}

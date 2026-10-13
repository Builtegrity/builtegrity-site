const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export async function handleResendStatementWebhook(request, env) {
  if (request.method !== 'POST') return null;
  const url = new URL(request.url);
  if (url.pathname !== '/api/records/resend-statement-webhook') return null;

  if (!env.RESEND_WEBHOOK_SECRET) {
    return json({ error: 'Resend webhook verification is not configured' }, 503);
  }

  const rawBody = await request.text();
  const verification = await verifySvixWebhook(rawBody, request.headers, env.RESEND_WEBHOOK_SECRET);
  if (!verification.ok) return json({ error: 'Invalid Resend webhook signature' }, 400);

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'Invalid JSON payload' }, 400);
  }

  const eventId = request.headers.get('svix-id');
  const eventType = String(event?.type || '');
  const providerMessageId = event?.data?.email_id ? String(event.data.email_id) : null;
  const recipient = Array.isArray(event?.data?.to) && event.data.to.length
    ? String(event.data.to[0]).toLowerCase()
    : null;
  const eventCreatedAt = event?.created_at || event?.data?.created_at || null;

  if (!eventId || !eventType) return json({ error: 'Webhook event identity is missing' }, 400);

  const inserted = await env.DB.prepare(`
    INSERT OR IGNORE INTO monthly_statement_email_events
      (event_id, provider_message_id, event_type, recipient_email, event_created_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    eventId,
    providerMessageId,
    eventType,
    recipient,
    eventCreatedAt,
    rawBody,
  ).run();

  if (!Number(inserted.meta?.changes || 0)) {
    return json({ received: true, duplicate: true });
  }

  if (!providerMessageId) return json({ received: true, matched: false });

  const delivery = await env.DB.prepare(`
    SELECT d.*, s.id AS statement_id
      FROM monthly_statement_deliveries d
      JOIN monthly_statements s ON s.id = d.statement_id
     WHERE d.provider_message_id = ?
       AND (? IS NULL OR lower(d.recipient_email) = lower(?))
     LIMIT 1
  `).bind(providerMessageId, recipient, recipient).first();

  if (!delivery) return json({ received: true, matched: false });

  await applyDeliveryEvent(env, delivery, eventType, event);
  return json({ received: true, matched: true, statement_id: delivery.statement_id });
}

async function applyDeliveryEvent(env, delivery, eventType, event) {
  const messageId = event?.data?.message_id ? String(event.data.message_id) : null;
  const providerEventAt = event?.created_at || event?.data?.created_at || new Date().toISOString();

  if (eventType === 'email.delivered') {
    await env.DB.prepare(`
      UPDATE monthly_statement_deliveries
         SET status = 'DELIVERED', provider_status = 'email.delivered',
             provider_last_event_at = ?, provider_message_id_header = COALESCE(?, provider_message_id_header),
             delivered_at = COALESCE(delivered_at, ?), next_attempt_at = NULL,
             last_error = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).bind(providerEventAt, messageId, providerEventAt, delivery.id).run();

    const remaining = await env.DB.prepare(`
      SELECT COUNT(*) AS count
        FROM monthly_statement_deliveries
       WHERE statement_id = ? AND status <> 'DELIVERED'
    `).bind(delivery.statement_id).first();

    if (Number(remaining?.count || 0) === 0) {
      await env.DB.prepare(`
        UPDATE monthly_statements
           SET status = 'DELIVERED', last_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).bind(delivery.statement_id).run();
    }
    await resolveAlert(env, `statement:delivery:${delivery.statement_id}`);
    await resolveAlert(env, `statement:provider-delay:${delivery.statement_id}`);
    return;
  }

  if (eventType === 'email.sent') {
    await updateProviderState(env, delivery.id, 'SENDING', eventType, providerEventAt, messageId, null);
    return;
  }

  if (eventType === 'email.delivery_delayed') {
    await updateProviderState(env, delivery.id, 'SENDING', eventType, providerEventAt, messageId, 'Provider reported delayed email delivery.');
    await upsertAlert(env, {
      key: `statement:provider-delay:${delivery.statement_id}`,
      severity: 'WARN',
      subjectType: 'STATEMENT',
      subjectId: delivery.statement_id,
      message: `${delivery.statement_id} email delivery is delayed at the recipient mail system. The provider remains responsible for its delivery retry sequence.`,
    });
    return;
  }

  if (['email.bounced', 'email.failed', 'email.suppressed', 'email.complained'].includes(eventType)) {
    const reason = providerFailureReason(eventType, event);
    await updateProviderState(env, delivery.id, 'FAILED', eventType, providerEventAt, messageId, reason);
    await env.DB.prepare(`
      UPDATE monthly_statements
         SET status = 'DELIVERY_PENDING', last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).bind(reason, delivery.statement_id).run();
    await upsertAlert(env, {
      key: `statement:delivery:${delivery.statement_id}`,
      severity: ['email.bounced', 'email.suppressed', 'email.complained'].includes(eventType) ? 'ERROR' : 'WARN',
      subjectType: 'STATEMENT',
      subjectId: delivery.statement_id,
      message: `${delivery.statement_id} was generated and stored, but recipient email delivery ended as ${eventType}: ${reason}`,
    });
    return;
  }

  await env.DB.prepare(`
    UPDATE monthly_statement_deliveries
       SET provider_status = ?, provider_last_event_at = ?,
           provider_message_id_header = COALESCE(?, provider_message_id_header),
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(eventType, providerEventAt, messageId, delivery.id).run();
}

async function updateProviderState(env, deliveryId, status, providerStatus, providerEventAt, messageId, error) {
  await env.DB.prepare(`
    UPDATE monthly_statement_deliveries
       SET status = ?, provider_status = ?, provider_last_event_at = ?,
           provider_message_id_header = COALESCE(?, provider_message_id_header),
           last_error = ?, next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(status, providerStatus, providerEventAt, messageId, error, deliveryId).run();
}

function providerFailureReason(eventType, event) {
  const bounce = event?.data?.bounce;
  const candidates = [
    bounce?.message,
    event?.data?.error?.message,
    event?.data?.reason,
    event?.data?.message,
  ].filter(Boolean);
  return String(candidates[0] || `Resend reported ${eventType}`).slice(0, 1800);
}

async function verifySvixWebhook(payload, headers, webhookSecret) {
  const id = headers.get('svix-id');
  const timestamp = headers.get('svix-timestamp');
  const signatureHeader = headers.get('svix-signature');
  if (!id || !timestamp || !signatureHeader) return { ok: false };

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return { ok: false };
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > MAX_TIMESTAMP_SKEW_SECONDS) return { ok: false };

  const secretText = String(webhookSecret || '').trim();
  const secretBase64 = secretText.startsWith('whsec_') ? secretText.slice(6) : secretText;
  let secretBytes;
  try {
    secretBytes = base64ToBytes(secretBase64);
  } catch {
    return { ok: false };
  }

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signedContent = `${id}.${timestamp}.${payload}`;
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent)));

  const candidates = String(signatureHeader).split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const comma = entry.indexOf(',');
      if (comma === -1 || entry.slice(0, comma) !== 'v1') return null;
      try { return base64ToBytes(entry.slice(comma + 1)); } catch { return null; }
    })
    .filter(Boolean);

  return { ok: candidates.some((candidate) => constantTimeEqual(digest, candidate)) };
}

function constantTimeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}

function base64ToBytes(value) {
  const binary = atob(String(value));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function upsertAlert(env, alert) {
  await env.DB.prepare(`
    INSERT INTO system_alerts
      (alert_key, category, severity, status, subject_type, subject_id, message)
    VALUES (?, 'STATEMENT', ?, 'OPEN', ?, ?, ?)
    ON CONFLICT(alert_key) DO UPDATE SET
      severity = excluded.severity,
      status = 'OPEN',
      subject_type = excluded.subject_type,
      subject_id = excluded.subject_id,
      message = excluded.message,
      last_seen_at = CURRENT_TIMESTAMP,
      resolved_at = NULL,
      occurrences = system_alerts.occurrences + 1
  `).bind(
    alert.key,
    alert.severity,
    alert.subjectType || null,
    alert.subjectId || null,
    String(alert.message || '').slice(0, 2000),
  ).run();
}

async function resolveAlert(env, key) {
  await env.DB.prepare(`
    UPDATE system_alerts
       SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP
     WHERE alert_key = ? AND status = 'OPEN'
  `).bind(key).run();
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function processAuthorizedPlatformCredits(env, options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit || 25)));
  const rows = await env.DB.prepare(`
    SELECT c.*, t.stripe_application_fee_id, t.processor_account_id,
           t.application_fee_gross_confirmed_cents, t.application_fee_refunded_cents
    FROM platform_fee_credit_authorizations c
    JOIN transactions t ON t.id=c.transaction_id AND t.merchant_id=c.merchant_id
    WHERE c.status IN ('AUTHORIZED','PROCESSING')
    ORDER BY c.authorized_at ASC
    LIMIT ?
  `).bind(limit).all();

  const stats = { attempted: 0, processing: 0, blocked: 0 };
  for (const credit of rows.results || []) {
    stats.attempted += 1;
    if (!credit.stripe_application_fee_id) {
      await openCreditAlert(env, credit, 'The processor application-fee ID is not available yet; automatic credit is waiting for processor reconciliation.');
      stats.blocked += 1;
      continue;
    }
    if (!env.STRIPE_SECRET_KEY) {
      await openCreditAlert(env, credit, 'STRIPE_SECRET_KEY is unavailable; an authorized Builtegrity fee credit cannot be processed.');
      stats.blocked += 1;
      continue;
    }

    const unrefundedCash = Math.max(
      0,
      Number(credit.application_fee_gross_confirmed_cents || 0) - Number(credit.application_fee_refunded_cents || 0),
    );
    if (Number(credit.amount_cents || 0) > unrefundedCash) {
      await openCreditAlert(env, credit, `Authorized credit ${credit.amount_cents}c exceeds currently unrefunded Builtegrity fee cash ${unrefundedCash}c.`);
      stats.blocked += 1;
      continue;
    }

    const body = new URLSearchParams();
    body.set('amount', String(Number(credit.amount_cents)));
    body.set('metadata[builtegrity_credit_id]', credit.id);
    body.set('metadata[builtegrity_tx_id]', credit.transaction_id);
    body.set('metadata[reason_code]', credit.reason_code);

    try {
      const response = await fetch(
        `https://api.stripe.com/v1/application_fees/${encodeURIComponent(credit.stripe_application_fee_id)}/refunds`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            'content-type': 'application/x-www-form-urlencoded',
            'Idempotency-Key': `builtegrity-credit-${credit.id}`,
          },
          body: body.toString(),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || `Stripe HTTP ${response.status}`);

      await env.DB.prepare(`
        UPDATE platform_fee_credit_authorizations
           SET status='PROCESSING', processor_fee_refund_id=COALESCE(processor_fee_refund_id, ?)
         WHERE id=? AND status IN ('AUTHORIZED','PROCESSING')
      `).bind(payload.id || null, credit.id).run();
      await resolveCreditAlert(env, credit.id);
      stats.processing += 1;
    } catch (error) {
      await openCreditAlert(env, credit, `Automatic Builtegrity fee credit failed and will retry idempotently: ${String(error?.message || error).slice(0, 1000)}`);
      stats.blocked += 1;
    }
  }
  return stats;
}

async function openCreditAlert(env, credit, message) {
  const key = `finance:platform-credit:${credit.id}`;
  await env.DB.prepare(`
    INSERT INTO system_alerts
      (alert_key,category,severity,status,subject_type,subject_id,message)
    VALUES (?,'FINANCE','CRITICAL','OPEN','TRANSACTION',?,?)
    ON CONFLICT(alert_key) DO UPDATE SET
      status='OPEN', severity='CRITICAL', message=excluded.message,
      last_seen_at=CURRENT_TIMESTAMP, occurrences=system_alerts.occurrences+1, resolved_at=NULL
  `).bind(key, credit.transaction_id, message).run();
}

async function resolveCreditAlert(env, creditId) {
  await env.DB.prepare(`
    UPDATE system_alerts
       SET status='RESOLVED', resolved_at=CURRENT_TIMESTAMP, last_seen_at=CURRENT_TIMESTAMP
     WHERE alert_key=? AND status='OPEN'
  `).bind(`finance:platform-credit:${creditId}`).run();
}

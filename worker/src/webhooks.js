import {
  advanceLifecycle,
  claimWebhook,
  failWebhook,
  finishWebhook,
  getTransaction,
  openException,
  recomputeIntegrity,
  recordEvent,
  resolveException,
} from './db.js';
import {
  listPayoutBalanceTransactions,
  retrieveCharge,
  retrievePaymentIntent,
} from './stripe.js';

function stripeTime(seconds) {
  if (!seconds) return null;
  return new Date(Number(seconds) * 1000).toISOString();
}

function txIdFromObject(object) {
  return object?.metadata?.builtegrity_tx_id || object?.client_reference_id || null;
}

function summarizeBalanceFees(balance) {
  if (!balance || typeof balance !== 'object') {
    return { processorFeeCents: null, breakdownJson: null, source: null };
  }

  const details = Array.isArray(balance.fee_details) ? balance.fee_details : [];
  if (details.length) {
    const normalized = details.map((item) => ({
      type: item?.type || null,
      amount: Number(item?.amount || 0),
      currency: item?.currency || balance.currency || null,
      description: item?.description || null,
    }));
    const processorFeeCents = normalized
      .filter((item) => item.type !== 'application_fee')
      .reduce((sum, item) => sum + item.amount, 0);
    return {
      processorFeeCents,
      breakdownJson: JSON.stringify(normalized),
      source: 'FEE_DETAILS',
    };
  }

  return {
    processorFeeCents: Number(balance.fee || 0),
    breakdownJson: null,
    source: 'BALANCE_TOTAL_UNVERIFIED',
  };
}

async function insertFinancialAdjustment(env, values) {
  if (!Number.isFinite(Number(values.amountCents)) || Number(values.amountCents) <= 0) return;
  await env.DB.prepare(`
    INSERT OR IGNORE INTO transaction_financial_adjustments
      (id, transaction_id, merchant_id, processor, adjustment_type, direction,
       amount_cents, currency, processor_event_id, processor_object_id, adjustment_at, details_json)
    VALUES (?, ?, ?, 'STRIPE', ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    values.id,
    values.transactionId,
    values.merchantId,
    values.adjustmentType,
    values.direction,
    Number(values.amountCents),
    String(values.currency || 'USD').toUpperCase(),
    values.processorEventId || null,
    values.processorObjectId || null,
    values.adjustmentAt,
    JSON.stringify(values.details || {}),
  ).run();
}

export async function processStripeWebhook(env, event) {
  const claim = await claimWebhook(env, event);
  if (!claim.claimed) return { duplicate: true };

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutCompleted(env, event);
        break;
      case 'checkout.session.async_payment_failed':
        await handleCheckoutFailed(env, event);
        break;
      case 'payment_intent.succeeded':
        await handlePaymentSucceeded(env, event);
        break;
      case 'payment_intent.payment_failed':
        await handlePaymentFailed(env, event);
        break;
      case 'application_fee.created':
        await handleApplicationFeeCreated(env, event);
        break;
      case 'application_fee.refunded':
        await handleApplicationFeeRefunded(env, event);
        break;
      case 'charge.refunded':
        await handleChargeRefunded(env, event);
        break;
      case 'charge.dispute.created':
        await handleDisputeOpened(env, event);
        break;
      case 'charge.dispute.closed':
        await handleDisputeClosed(env, event);
        break;
      case 'payout.reconciliation_completed':
      case 'payout.paid':
        await handlePayoutReady(env, event);
        break;
      case 'payout.failed':
        await handlePayoutFailed(env, event);
        break;
      default:
        break;
    }

    await finishWebhook(env, event.id);
    return { processed: true };
  } catch (error) {
    await failWebhook(env, event.id, error);
    throw error;
  }
}

async function handleCheckoutCompleted(env, event) {
  const session = event.data.object;
  const txId = txIdFromObject(session);
  if (!txId) return;

  await env.DB.prepare(`
    UPDATE transactions
       SET stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, ?),
           stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
           payment_status = COALESCE(?, payment_status),
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(
    session.id,
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
    session.payment_status || null,
    txId,
  ).run();

  await advanceLifecycle(env, txId, 'PAYMENT_PENDING');
  await recordEvent(env, txId, 'CHECKOUT_COMPLETED', 'STRIPE', `${event.id}:checkout`, {
    checkout_session_id: session.id,
    payment_status: session.payment_status,
  }, stripeTime(event.created));
}

async function handleCheckoutFailed(env, event) {
  const session = event.data.object;
  const txId = txIdFromObject(session);
  if (!txId) return;
  await recordEvent(env, txId, 'PAYMENT_FAILED', 'STRIPE', `${event.id}:checkout_failed`, {
    checkout_session_id: session.id,
  }, stripeTime(event.created));
  await openException(env, txId, 'PAYMENT_FAILED', 'Stripe reported an asynchronous Checkout payment failure.');
}

async function handlePaymentSucceeded(env, event) {
  const eventIntent = event.data.object;
  const txId = txIdFromObject(eventIntent);
  if (!txId) return;

  const tx = await getTransaction(env, txId);
  if (!tx) return;
  const accountId = event.account || tx.processor_account_id;
  if (!accountId) throw new Error(`No connected Stripe account for ${txId}`);

  const paymentIntent = await retrievePaymentIntent(env, accountId, eventIntent.id);
  const latestCharge = paymentIntent.latest_charge;
  const chargeId = typeof latestCharge === 'string' ? latestCharge : latestCharge?.id;
  if (!chargeId) throw new Error(`PaymentIntent ${paymentIntent.id} has no latest charge`);
  const charge = await retrieveCharge(env, accountId, chargeId);
  const balance = charge.balance_transaction;
  const balanceId = typeof balance === 'string' ? balance : balance?.id;
  const applicationFee = charge.application_fee;
  const applicationFeeId = typeof applicationFee === 'string' ? applicationFee : applicationFee?.id;
  const availableOn = typeof balance === 'object' ? stripeTime(balance.available_on) : null;
  const feeSummary = summarizeBalanceFees(balance);
  const grossApplicationFee = typeof applicationFee === 'object' ? Number(applicationFee.amount || 0) : 0;
  const refundedApplicationFee = typeof applicationFee === 'object' ? Number(applicationFee.amount_refunded || 0) : 0;
  const currentApplicationFeeCash = grossApplicationFee > 0
    ? Math.max(0, grossApplicationFee - refundedApplicationFee)
    : null;

  await env.DB.prepare(`
    UPDATE transactions
       SET stripe_payment_intent_id = ?,
           stripe_charge_id = ?,
           stripe_balance_transaction_id = COALESCE(?, stripe_balance_transaction_id),
           stripe_application_fee_id = COALESCE(?, stripe_application_fee_id),
           payment_status = 'succeeded',
           payment_at = COALESCE(payment_at, ?),
           customer_paid_cents = ?,
           stripe_available_on = COALESCE(?, stripe_available_on),
           processor_fee_cents = COALESCE(?, processor_fee_cents),
           processor_fee_breakdown_json = COALESCE(?, processor_fee_breakdown_json),
           processor_fee_source = COALESCE(?, processor_fee_source),
           application_fee_gross_confirmed_cents = CASE
             WHEN application_fee_gross_confirmed_cents = 0 AND ? > 0 THEN ?
             ELSE application_fee_gross_confirmed_cents
           END,
           integrity_fee_collected_cents = CASE
             WHEN ? IS NOT NULL THEN ?
             ELSE integrity_fee_collected_cents
           END,
           application_fee_refunded_cents = CASE
             WHEN ? > application_fee_refunded_cents THEN ?
             ELSE application_fee_refunded_cents
           END,
           expected_merchant_net_cents = COALESCE(?, expected_merchant_net_cents),
           tax_data_reconciled_at = CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP ELSE tax_data_reconciled_at END,
           last_reconciled_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(
    paymentIntent.id,
    charge.id,
    balanceId || null,
    applicationFeeId || null,
    stripeTime(paymentIntent.created),
    Number(charge.amount_captured || paymentIntent.amount_received || 0),
    availableOn,
    feeSummary.processorFeeCents,
    feeSummary.breakdownJson,
    feeSummary.source,
    grossApplicationFee,
    grossApplicationFee,
    currentApplicationFeeCash,
    currentApplicationFeeCash,
    refundedApplicationFee,
    refundedApplicationFee,
    typeof balance === 'object' ? Number(balance.net || 0) : null,
    availableOn,
    txId,
  ).run();

  await advanceLifecycle(env, txId, 'PAID');
  await recordEvent(env, txId, 'PAYMENT_SUCCEEDED', 'STRIPE', `${event.id}:payment`, {
    payment_intent_id: paymentIntent.id,
    charge_id: charge.id,
    amount_received: paymentIntent.amount_received,
    stripe_available_on: availableOn,
  }, stripeTime(event.created));

  if (balanceId) {
    await advanceLifecycle(env, txId, 'PAYOUT_PENDING');
    await recordEvent(env, txId, 'BALANCE_RECORDED', 'STRIPE', `${event.id}:balance`, {
      balance_transaction_id: balanceId,
      processor_fee_cents: feeSummary.processorFeeCents,
      processor_fee_source: feeSummary.source,
      merchant_net_cents: typeof balance === 'object' ? balance.net : null,
      available_on: typeof balance === 'object' ? balance.available_on : null,
    }, stripeTime(event.created));
  }

  await resolveException(env, txId, 'PAYMENT_FAILED', 'Stripe later confirmed the payment succeeded.');
  await recomputeIntegrity(env, txId);
}

async function handlePaymentFailed(env, event) {
  const intent = event.data.object;
  const txId = txIdFromObject(intent);
  if (!txId) return;

  await env.DB.prepare(`
    UPDATE transactions
       SET stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
           payment_status = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(intent.id, intent.status || 'failed', txId).run();

  await recordEvent(env, txId, 'PAYMENT_FAILED', 'STRIPE', `${event.id}:payment_failed`, {
    payment_intent_id: intent.id,
    decline_code: intent.last_payment_error?.decline_code || null,
    message: intent.last_payment_error?.message || null,
  }, stripeTime(event.created));
  await openException(env, txId, 'PAYMENT_FAILED', intent.last_payment_error?.message || 'Stripe reported that the payment failed.');
}

async function handleApplicationFeeCreated(env, event) {
  const fee = event.data.object;
  const chargeId = typeof fee.charge === 'string' ? fee.charge : fee.charge?.id;
  if (!chargeId) return;

  const tx = await env.DB.prepare(`
    SELECT id FROM transactions WHERE stripe_charge_id = ? LIMIT 1
  `).bind(chargeId).first();
  if (!tx) return;

  const gross = Number(fee.amount || 0);
  const refunded = Number(fee.amount_refunded || 0);
  const net = Math.max(0, gross - refunded);

  await env.DB.prepare(`
    UPDATE transactions
       SET stripe_application_fee_id = ?,
           application_fee_gross_confirmed_cents = CASE
             WHEN application_fee_gross_confirmed_cents = 0 THEN ?
             ELSE application_fee_gross_confirmed_cents
           END,
           integrity_fee_collected_cents = ?,
           application_fee_refunded_cents = MAX(application_fee_refunded_cents, ?),
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(fee.id, gross, net, refunded, tx.id).run();

  await recordEvent(env, tx.id, 'APPLICATION_FEE_RECORDED', 'STRIPE', `${event.id}:fee`, {
    application_fee_id: fee.id,
    gross_amount: gross,
    amount_refunded: refunded,
    current_net_amount: net,
  }, stripeTime(event.created));
}

async function handleApplicationFeeRefunded(env, event) {
  const fee = event.data.object;
  const chargeId = typeof fee.charge === 'string' ? fee.charge : fee.charge?.id;
  const tx = await env.DB.prepare(`
    SELECT id, merchant_id, currency, application_fee_refunded_cents
      FROM transactions
     WHERE stripe_application_fee_id = ?
        OR (? IS NOT NULL AND stripe_charge_id = ?)
     LIMIT 1
  `).bind(fee.id, chargeId || null, chargeId || null).first();
  if (!tx) return;

  const gross = Number(fee.amount || 0);
  const cumulativeRefunded = Number(fee.amount_refunded || 0);
  const priorRefunded = Number(tx.application_fee_refunded_cents || 0);
  const refundDelta = Math.max(0, cumulativeRefunded - priorRefunded);
  const net = Math.max(0, gross - cumulativeRefunded);

  await env.DB.prepare(`
    UPDATE transactions
       SET stripe_application_fee_id = COALESCE(stripe_application_fee_id, ?),
           application_fee_gross_confirmed_cents = CASE
             WHEN application_fee_gross_confirmed_cents = 0 THEN ?
             ELSE application_fee_gross_confirmed_cents
           END,
           integrity_fee_collected_cents = ?,
           application_fee_refunded_cents = MAX(application_fee_refunded_cents, ?),
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(fee.id, gross, net, cumulativeRefunded, tx.id).run();

  if (refundDelta > 0) {
    await insertFinancialAdjustment(env, {
      id: `ADJ-${event.id}-APPFEE`,
      transactionId: tx.id,
      merchantId: tx.merchant_id,
      adjustmentType: 'APPLICATION_FEE_REFUND',
      direction: 'BUILTEGRITY_OUTFLOW',
      amountCents: refundDelta,
      currency: fee.currency || tx.currency,
      processorEventId: event.id,
      processorObjectId: fee.id,
      adjustmentAt: stripeTime(event.created),
      details: {
        application_fee_id: fee.id,
        cumulative_refunded_cents: cumulativeRefunded,
        gross_application_fee_cents: gross,
      },
    });
  }

  await recordEvent(env, tx.id, 'APPLICATION_FEE_REFUNDED', 'STRIPE', `${event.id}:fee_refund`, {
    application_fee_id: fee.id,
    refund_delta: refundDelta,
    cumulative_refunded: cumulativeRefunded,
    current_net_amount: net,
  }, stripeTime(event.created));
}

async function handleChargeRefunded(env, event) {
  const charge = event.data.object;
  const tx = await env.DB.prepare(`
    SELECT id, merchant_id, currency, refunded_cents
      FROM transactions
     WHERE stripe_charge_id = ?
     LIMIT 1
  `).bind(charge.id).first();
  if (!tx) return;

  const cumulativeRefunded = Number(charge.amount_refunded || 0);
  const priorRefunded = Number(tx.refunded_cents || 0);
  const refundDelta = Math.max(0, cumulativeRefunded - priorRefunded);

  await env.DB.prepare(`
    UPDATE transactions
       SET payment_status = ?,
           refunded_cents = MAX(refunded_cents, ?),
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(charge.refunded ? 'refunded' : 'partially_refunded', cumulativeRefunded, tx.id).run();

  if (refundDelta > 0) {
    await insertFinancialAdjustment(env, {
      id: `ADJ-${event.id}-REFUND`,
      transactionId: tx.id,
      merchantId: tx.merchant_id,
      adjustmentType: 'REFUND',
      direction: 'MERCHANT_OUTFLOW',
      amountCents: refundDelta,
      currency: charge.currency || tx.currency,
      processorEventId: event.id,
      processorObjectId: charge.id,
      adjustmentAt: stripeTime(event.created),
      details: {
        charge_id: charge.id,
        cumulative_refunded_cents: cumulativeRefunded,
        fully_refunded: Boolean(charge.refunded),
      },
    });
  }

  await recordEvent(env, tx.id, 'REFUND_SUCCEEDED', 'STRIPE', `${event.id}:refund`, {
    charge_id: charge.id,
    refund_delta: refundDelta,
    amount_refunded: cumulativeRefunded,
    fully_refunded: Boolean(charge.refunded),
  }, stripeTime(event.created));
  await recomputeIntegrity(env, tx.id);
}

async function handleDisputeOpened(env, event) {
  const dispute = event.data.object;
  const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
  if (!chargeId) return;
  const tx = await env.DB.prepare(`SELECT id FROM transactions WHERE stripe_charge_id = ? LIMIT 1`).bind(chargeId).first();
  if (!tx) return;

  await recordEvent(env, tx.id, 'DISPUTE_OPENED', 'STRIPE', `${event.id}:dispute_opened`, {
    dispute_id: dispute.id,
    amount: dispute.amount,
    reason: dispute.reason,
    status: dispute.status,
  }, stripeTime(event.created));
  await openException(env, tx.id, 'DISPUTE_OPENED', `Stripe dispute ${dispute.id} is open.`);
}

async function handleDisputeClosed(env, event) {
  const dispute = event.data.object;
  const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
  if (!chargeId) return;
  const tx = await env.DB.prepare(`SELECT id FROM transactions WHERE stripe_charge_id = ? LIMIT 1`).bind(chargeId).first();
  if (!tx) return;

  await recordEvent(env, tx.id, 'DISPUTE_CLOSED', 'STRIPE', `${event.id}:dispute_closed`, {
    dispute_id: dispute.id,
    status: dispute.status,
  }, stripeTime(event.created));
  await resolveException(env, tx.id, 'DISPUTE_OPENED', `Stripe dispute ${dispute.id} closed with status ${dispute.status}.`);
}

async function handlePayoutReady(env, event) {
  const payout = event.data.object;
  const accountId = event.account;
  if (!accountId) return;
  const balanceTransactions = await listPayoutBalanceTransactions(env, accountId, payout.id);
  const chargeSources = new Map(
    balanceTransactions
      .filter((item) => typeof item.source === 'string' && item.source.startsWith('ch_'))
      .map((item) => [item.source, item]),
  );

  for (const [chargeId, balanceItem] of chargeSources.entries()) {
    const tx = await env.DB.prepare(`
      SELECT id FROM transactions
      WHERE stripe_charge_id = ? AND merchant_id IN (
        SELECT id FROM merchants WHERE processor_account_id = ?
      )
      LIMIT 1
    `).bind(chargeId, accountId).first();
    if (!tx) continue;

    await env.DB.prepare(`
      UPDATE transactions
         SET stripe_payout_id = ?,
             payout_accounted = 1,
             processor_payout_status = ?,
             expected_payout_arrival = ?,
             transaction_payout_contribution_cents = ?,
             payout_batch_total_cents = ?,
             last_reconciled_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).bind(
      payout.id,
      payout.status || (event.type === 'payout.paid' ? 'paid' : 'pending'),
      stripeTime(payout.arrival_date),
      Number(balanceItem.net || 0),
      Number(payout.amount || 0),
      tx.id,
    ).run();

    await recordEvent(env, tx.id, 'PAYOUT_IDENTIFIED', 'STRIPE', `${event.id}:${tx.id}:identified`, {
      payout_id: payout.id,
      payout_status: payout.status,
      transaction_contribution_cents: balanceItem.net,
      payout_batch_total_cents: payout.amount,
    }, stripeTime(event.created));

    if (event.type === 'payout.paid' || payout.status === 'paid') {
      await env.DB.prepare(`
        UPDATE transactions
           SET processor_payout_status = 'paid',
               actual_merchant_net_cents = COALESCE(transaction_payout_contribution_cents, expected_merchant_net_cents),
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).bind(tx.id).run();
      await advanceLifecycle(env, tx.id, 'COMPLETE');
      await recordEvent(env, tx.id, 'PAYOUT_PAID', 'STRIPE', `${event.id}:${tx.id}:paid`, {
        payout_id: payout.id,
      }, stripeTime(event.created));
      await resolveException(env, tx.id, 'PAYOUT_FAILED', 'Stripe later reported the payout paid.');
      await resolveException(env, tx.id, 'EXPECTED_PAYOUT_NOT_FOUND', 'Transaction was reconciled to a Stripe payout.');
    }

    await recomputeIntegrity(env, tx.id);
  }
}

async function handlePayoutFailed(env, event) {
  const payout = event.data.object;
  const result = await env.DB.prepare(`
    SELECT id FROM transactions WHERE stripe_payout_id = ?
  `).bind(payout.id).all();

  for (const tx of result.results || []) {
    await env.DB.prepare(`
      UPDATE transactions
         SET processor_payout_status = 'failed', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).bind(tx.id).run();
    await recordEvent(env, tx.id, 'PAYOUT_FAILED', 'STRIPE', `${event.id}:${tx.id}:failed`, {
      payout_id: payout.id,
      failure_code: payout.failure_code || null,
      failure_message: payout.failure_message || null,
    }, stripeTime(event.created));
    await openException(env, tx.id, 'PAYOUT_FAILED', payout.failure_message || `Stripe payout ${payout.id} failed.`);
  }
}

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

  await env.DB.prepare(`
    UPDATE transactions
       SET stripe_payment_intent_id = ?,
           stripe_charge_id = ?,
           stripe_balance_transaction_id = COALESCE(?, stripe_balance_transaction_id),
           stripe_application_fee_id = COALESCE(?, stripe_application_fee_id),
           payment_status = 'succeeded',
           payment_at = COALESCE(payment_at, ?),
           customer_paid_cents = ?,
           processor_fee_cents = COALESCE(?, processor_fee_cents),
           expected_merchant_net_cents = COALESCE(?, expected_merchant_net_cents),
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
    typeof balance === 'object' ? Number(balance.fee || 0) : null,
    typeof balance === 'object' ? Number(balance.net || 0) : null,
    txId,
  ).run();

  await advanceLifecycle(env, txId, 'PAID');
  await recordEvent(env, txId, 'PAYMENT_SUCCEEDED', 'STRIPE', `${event.id}:payment`, {
    payment_intent_id: paymentIntent.id,
    charge_id: charge.id,
    amount_received: paymentIntent.amount_received,
  }, stripeTime(event.created));

  if (balanceId) {
    await advanceLifecycle(env, txId, 'PAYOUT_PENDING');
    await recordEvent(env, txId, 'BALANCE_RECORDED', 'STRIPE', `${event.id}:balance`, {
      balance_transaction_id: balanceId,
      processor_fee_cents: typeof balance === 'object' ? balance.fee : null,
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

  await env.DB.prepare(`
    UPDATE transactions
       SET stripe_application_fee_id = ?,
           integrity_fee_collected_cents = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(fee.id, Number(fee.amount || 0), tx.id).run();

  await recordEvent(env, tx.id, 'APPLICATION_FEE_RECORDED', 'STRIPE', `${event.id}:fee`, {
    application_fee_id: fee.id,
    amount: fee.amount,
  }, stripeTime(event.created));
}

async function handleChargeRefunded(env, event) {
  const charge = event.data.object;
  const tx = await env.DB.prepare(`
    SELECT id FROM transactions WHERE stripe_charge_id = ? LIMIT 1
  `).bind(charge.id).first();
  if (!tx) return;

  await env.DB.prepare(`
    UPDATE transactions
       SET payment_status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(charge.refunded ? 'refunded' : 'partially_refunded', tx.id).run();

  await recordEvent(env, tx.id, 'REFUND_RECORDED', 'STRIPE', `${event.id}:refund`, {
    charge_id: charge.id,
    amount_refunded: charge.amount_refunded,
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

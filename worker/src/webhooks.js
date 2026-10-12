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

function objectId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}

export async function processStripeWebhook(env, event) {
  const claim = await claimWebhook(env, event);
  if (!claim.claimed) {
    if (claim.inProgress) {
      const error = new Error(`Stripe webhook ${event.id} is already being processed; retry later`);
      error.status = 409;
      error.retryable = true;
      throw error;
    }
    return { duplicate: true };
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutCompleted(env, event);
        break;
      case 'checkout.session.expired':
        await handleCheckoutExpired(env, event);
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
      case 'payout.canceled':
        await handlePayoutCanceled(env, event);
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

  const tx = await getTransaction(env, txId);
  if (!tx) throw new Error(`Stripe Checkout ${session.id} references missing transaction ${txId}`);

  await env.DB.prepare(`
    UPDATE transactions
       SET stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, ?),
           stripe_checkout_url = COALESCE(stripe_checkout_url, ?),
           stripe_checkout_expires_at = COALESCE(stripe_checkout_expires_at, ?),
           stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
           payment_status = COALESCE(?, payment_status),
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(
    session.id,
    session.url || null,
    stripeTime(session.expires_at),
    objectId(session.payment_intent),
    session.payment_status || null,
    txId,
  ).run();

  await advanceLifecycle(env, txId, 'PAYMENT_PENDING');
  await recordEvent(env, txId, 'CHECKOUT_COMPLETED', 'STRIPE', `${event.id}:checkout`, {
    checkout_session_id: session.id,
    payment_status: session.payment_status,
  }, stripeTime(event.created));
}

async function handleCheckoutExpired(env, event) {
  const session = event.data.object;
  const txId = txIdFromObject(session);
  if (!txId) return;

  const tx = await getTransaction(env, txId);
  if (!tx) throw new Error(`Expired Stripe Checkout ${session.id} references missing transaction ${txId}`);

  await env.DB.prepare(`
    UPDATE transactions
       SET stripe_checkout_url = CASE WHEN stripe_checkout_session_id = ? THEN NULL ELSE stripe_checkout_url END,
           stripe_checkout_expires_at = CASE WHEN stripe_checkout_session_id = ? THEN ? ELSE stripe_checkout_expires_at END,
           payment_status = CASE WHEN stripe_checkout_session_id = ? THEN COALESCE(?, payment_status) ELSE payment_status END,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(
    session.id,
    session.id,
    stripeTime(session.expires_at),
    session.id,
    session.payment_status || null,
    txId,
  ).run();

  await recordEvent(env, txId, 'CHECKOUT_EXPIRED', 'STRIPE', `${event.id}:checkout_expired`, {
    checkout_session_id: session.id,
  }, stripeTime(event.created));
}

async function handleCheckoutFailed(env, event) {
  const session = event.data.object;
  const txId = txIdFromObject(session);
  if (!txId) return;

  const tx = await getTransaction(env, txId);
  if (!tx) throw new Error(`Failed Stripe Checkout ${session.id} references missing transaction ${txId}`);

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
  if (!tx) throw new Error(`Stripe PaymentIntent ${eventIntent.id} references missing transaction ${txId}`);
  const accountId = event.account || tx.processor_account_id;
  if (!accountId) throw new Error(`No connected Stripe account for ${txId}`);
  ensureTransactionAccount(tx, accountId);

  const paymentIntent = await retrievePaymentIntent(env, accountId, eventIntent.id);
  const latestCharge = paymentIntent.latest_charge;
  const chargeId = objectId(latestCharge);
  if (!chargeId) throw new Error(`PaymentIntent ${paymentIntent.id} has no latest charge`);
  const charge = await retrieveCharge(env, accountId, chargeId);
  const balance = charge.balance_transaction;
  const balanceId = objectId(balance);
  const applicationFee = charge.application_fee;
  const applicationFeeId = objectId(applicationFee);
  const collectedFee = typeof applicationFee === 'object' && applicationFee
    ? Number(applicationFee.amount || 0)
    : Number.isFinite(Number(charge.application_fee_amount))
      ? Number(charge.application_fee_amount)
      : null;

  await env.DB.prepare(`
    UPDATE transactions
       SET stripe_payment_intent_id = ?,
           stripe_charge_id = ?,
           stripe_balance_transaction_id = COALESCE(?, stripe_balance_transaction_id),
           stripe_application_fee_id = COALESCE(?, stripe_application_fee_id),
           integrity_fee_collected_cents = COALESCE(?, integrity_fee_collected_cents),
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
    collectedFee,
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

  if (applicationFeeId || collectedFee !== null) {
    await recordEvent(env, txId, 'APPLICATION_FEE_RECORDED', 'STRIPE', `${event.id}:payment_fee`, {
      application_fee_id: applicationFeeId,
      amount: collectedFee,
    }, stripeTime(event.created));
  }

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
  if (collectedFee !== null && collectedFee >= Number(tx.integrity_fee_earned_cents || 0)) {
    await resolveException(env, txId, 'UNEXPECTED_FEE', 'Stripe payment reconciliation confirmed the expected application fee.');
  }
  await recomputeIntegrity(env, txId);
}

async function handlePaymentFailed(env, event) {
  const intent = event.data.object;
  const txId = txIdFromObject(intent);
  if (!txId) return;

  const tx = await getTransaction(env, txId);
  if (!tx) throw new Error(`Failed Stripe PaymentIntent ${intent.id} references missing transaction ${txId}`);
  if (event.account) ensureTransactionAccount(tx, event.account);

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
  const chargeId = objectId(fee.charge);
  const accountId = objectId(fee.account) || event.account || null;
  if (!chargeId || !accountId) return;

  const resolved = await findBuiltegrityTransactionForCharge(env, accountId, fee.charge);
  if (!resolved) return;
  const { tx } = resolved;

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
  if (Number(fee.amount || 0) >= Number(tx.integrity_fee_earned_cents || 0)) {
    await resolveException(env, tx.id, 'UNEXPECTED_FEE', 'Stripe application-fee event confirmed the expected fee.');
  }
  await recomputeIntegrity(env, tx.id);
}

async function handleApplicationFeeRefunded(env, event) {
  const fee = event.data.object;
  const accountId = objectId(fee.account) || event.account || null;

  const linked = fee.id
    ? await env.DB.prepare(`SELECT id FROM transactions WHERE stripe_application_fee_id = ? LIMIT 1`).bind(fee.id).first()
    : null;
  let tx = linked ? await getTransaction(env, linked.id) : null;

  if (!tx && fee.charge) {
    const resolved = await findBuiltegrityTransactionForCharge(env, accountId, fee.charge);
    tx = resolved?.tx || null;
  }
  if (!tx) return;
  if (accountId) ensureTransactionAccount(tx, accountId);

  const amount = Number(fee.amount || 0);
  const amountRefunded = Number(fee.amount_refunded || 0);
  const netCollected = Math.max(0, amount - amountRefunded);

  await env.DB.prepare(`
    UPDATE transactions
       SET stripe_application_fee_id = COALESCE(stripe_application_fee_id, ?),
           integrity_fee_collected_cents = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(fee.id || null, netCollected, tx.id).run();

  await recordEvent(env, tx.id, 'APPLICATION_FEE_REFUNDED', 'STRIPE', `${event.id}:fee_refund`, {
    application_fee_id: fee.id || null,
    amount,
    amount_refunded: amountRefunded,
    net_collected: netCollected,
    fully_refunded: Boolean(fee.refunded),
  }, stripeTime(event.created));

  await openException(
    env,
    tx.id,
    'APPLICATION_FEE_REFUNDED',
    `Stripe reports ${amountRefunded} cent(s) of the application fee refunded. Refund-fee economics require explicit reconciliation before ACCOUNTED can be restored.`,
  );
}

async function handleChargeRefunded(env, event) {
  const resolved = await findBuiltegrityTransactionForCharge(env, event.account || null, event.data.object);
  if (!resolved) return;
  const { tx, charge } = resolved;
  const amountRefunded = Number(charge.amount_refunded || 0);
  const status = charge.refunded ? 'refunded' : 'partially_refunded';

  await env.DB.prepare(`
    UPDATE transactions
       SET payment_status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(status, tx.id).run();

  await recordEvent(env, tx.id, 'REFUND_RECORDED', 'STRIPE', `${event.id}:refund`, {
    charge_id: charge.id,
    amount_refunded: amountRefunded,
    fully_refunded: Boolean(charge.refunded),
  }, stripeTime(event.created));

  await openException(
    env,
    tx.id,
    'REFUND_RECORDED',
    `Stripe recorded a ${charge.refunded ? 'full' : 'partial'} refund of ${amountRefunded} cents. Refund economics require explicit reconciliation before this transaction can be ACCOUNTED again.`,
  );
}

async function handleDisputeOpened(env, event) {
  const dispute = event.data.object;
  const resolved = await findBuiltegrityTransactionForCharge(env, event.account || null, dispute.charge);
  if (!resolved) return;
  const { tx } = resolved;

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
  const resolved = await findBuiltegrityTransactionForCharge(env, event.account || null, dispute.charge);
  if (!resolved) return;
  const { tx } = resolved;
  const status = String(dispute.status || '').toLowerCase();

  await recordEvent(env, tx.id, 'DISPUTE_CLOSED', 'STRIPE', `${event.id}:dispute_closed`, {
    dispute_id: dispute.id,
    status: dispute.status,
  }, stripeTime(event.created));

  if (status === 'won' || status === 'warning_closed') {
    await resolveException(env, tx.id, 'DISPUTE_OPENED', `Stripe dispute ${dispute.id} closed favorably with status ${dispute.status}.`);
    await resolveException(env, tx.id, 'DISPUTE_LOST', `Stripe dispute ${dispute.id} later closed favorably.`);
    await resolveException(env, tx.id, 'DISPUTE_OUTCOME_REVIEW', `Stripe dispute ${dispute.id} closed favorably.`);
    return;
  }

  if (status === 'lost') {
    await resolveException(env, tx.id, 'DISPUTE_OPENED', `Stripe dispute ${dispute.id} closed as lost.`);
    await openException(env, tx.id, 'DISPUTE_LOST', `Stripe dispute ${dispute.id} was lost. Transaction economics require review before ACCOUNTED can be restored.`);
    return;
  }

  await resolveException(env, tx.id, 'DISPUTE_OPENED', `Stripe dispute ${dispute.id} closed with status ${dispute.status || 'unknown'}.`);
  await openException(env, tx.id, 'DISPUTE_OUTCOME_REVIEW', `Stripe dispute ${dispute.id} closed with unclassified status ${dispute.status || 'unknown'} and requires review.`);
}

async function handlePayoutReady(env, event) {
  const payout = event.data.object;
  const accountId = event.account;
  if (!accountId) return;
  const payoutStatus = String(payout.status || (event.type === 'payout.paid' ? 'paid' : 'pending')).toLowerCase();
  const balanceTransactions = await listPayoutBalanceTransactions(env, accountId, payout.id);
  const chargeSources = new Map(
    balanceTransactions
      .filter((item) => typeof item.source === 'string' && item.source.startsWith('ch_'))
      .map((item) => [item.source, item]),
  );

  for (const [chargeId, balanceItem] of chargeSources.entries()) {
    const resolved = await findBuiltegrityTransactionForCharge(env, accountId, chargeId);
    if (!resolved) continue;
    const { tx } = resolved;

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
      payoutStatus,
      stripeTime(payout.arrival_date),
      Number(balanceItem.net || 0),
      Number(payout.amount || 0),
      tx.id,
    ).run();

    await recordEvent(env, tx.id, 'PAYOUT_IDENTIFIED', 'STRIPE', `${event.id}:${tx.id}:identified`, {
      payout_id: payout.id,
      payout_status: payoutStatus,
      transaction_contribution_cents: balanceItem.net,
      payout_batch_total_cents: payout.amount,
    }, stripeTime(event.created));

    if (payoutStatus === 'paid') {
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
      await resolveException(env, tx.id, 'PAYOUT_CANCELED', 'Stripe later reported the payout paid.');
      await resolveException(env, tx.id, 'EXPECTED_PAYOUT_NOT_FOUND', 'Transaction was reconciled to a Stripe payout.');
    } else if (payoutStatus === 'failed') {
      await recordEvent(env, tx.id, 'PAYOUT_FAILED', 'STRIPE', `${event.id}:${tx.id}:failed_reconciled`, {
        payout_id: payout.id,
        failure_code: payout.failure_code || null,
        failure_message: payout.failure_message || null,
      }, stripeTime(event.created));
      await openException(env, tx.id, 'PAYOUT_FAILED', payout.failure_message || `Stripe payout ${payout.id} failed.`);
    } else if (payoutStatus === 'canceled') {
      await recordEvent(env, tx.id, 'PAYOUT_CANCELED', 'STRIPE', `${event.id}:${tx.id}:canceled_reconciled`, {
        payout_id: payout.id,
      }, stripeTime(event.created));
      await openException(env, tx.id, 'PAYOUT_CANCELED', `Stripe payout ${payout.id} was canceled and requires review.`);
    }

    await recomputeIntegrity(env, tx.id);
  }
}

async function handlePayoutFailed(env, event) {
  const payout = event.data.object;
  const transactionIds = await transactionsForPayout(env, event);

  for (const txId of transactionIds) {
    await env.DB.prepare(`
      UPDATE transactions
         SET processor_payout_status = 'failed', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).bind(txId).run();
    await recordEvent(env, txId, 'PAYOUT_FAILED', 'STRIPE', `${event.id}:${txId}:failed`, {
      payout_id: payout.id,
      failure_code: payout.failure_code || null,
      failure_message: payout.failure_message || null,
    }, stripeTime(event.created));
    await openException(env, txId, 'PAYOUT_FAILED', payout.failure_message || `Stripe payout ${payout.id} failed.`);
  }
}

async function handlePayoutCanceled(env, event) {
  const payout = event.data.object;
  const transactionIds = await transactionsForPayout(env, event);

  for (const txId of transactionIds) {
    await env.DB.prepare(`
      UPDATE transactions
         SET processor_payout_status = 'canceled', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).bind(txId).run();
    await recordEvent(env, txId, 'PAYOUT_CANCELED', 'STRIPE', `${event.id}:${txId}:canceled`, {
      payout_id: payout.id,
    }, stripeTime(event.created));
    await openException(env, txId, 'PAYOUT_CANCELED', `Stripe payout ${payout.id} was canceled and requires review.`);
  }
}

async function transactionsForPayout(env, event) {
  const payout = event.data.object;
  const accountId = event.account;
  const transactionIds = new Set();

  const linked = await env.DB.prepare(`
    SELECT id FROM transactions WHERE stripe_payout_id = ?
  `).bind(payout.id).all();
  for (const tx of linked.results || []) transactionIds.add(tx.id);

  if (accountId) {
    const balanceTransactions = await listPayoutBalanceTransactions(env, accountId, payout.id);
    for (const item of balanceTransactions) {
      if (typeof item.source !== 'string' || !item.source.startsWith('ch_')) continue;
      const resolved = await findBuiltegrityTransactionForCharge(env, accountId, item.source);
      if (!resolved) continue;
      transactionIds.add(resolved.tx.id);
      await env.DB.prepare(`
        UPDATE transactions
           SET stripe_payout_id = COALESCE(stripe_payout_id, ?),
               payout_accounted = 1,
               transaction_payout_contribution_cents = COALESCE(transaction_payout_contribution_cents, ?),
               payout_batch_total_cents = COALESCE(payout_batch_total_cents, ?),
               expected_payout_arrival = COALESCE(expected_payout_arrival, ?),
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).bind(
        payout.id,
        Number(item.net || 0),
        Number(payout.amount || 0),
        stripeTime(payout.arrival_date),
        resolved.tx.id,
      ).run();
    }
  }

  return transactionIds;
}

async function findBuiltegrityTransactionForCharge(env, accountId, chargeLike) {
  const chargeId = objectId(chargeLike);
  if (!chargeId) return null;

  let tx = await env.DB.prepare(`
    SELECT id FROM transactions WHERE stripe_charge_id = ? LIMIT 1
  `).bind(chargeId).first();
  if (tx) {
    const full = await getTransaction(env, tx.id);
    if (accountId) ensureTransactionAccount(full, accountId);
    return { tx: full, charge: typeof chargeLike === 'object' ? chargeLike : await retrieveCharge(env, accountId || full.processor_account_id, chargeId) };
  }

  if (!accountId) return null;
  const charge = typeof chargeLike === 'object' && chargeLike?.id
    ? chargeLike
    : await retrieveCharge(env, accountId, chargeId);

  const metadataTxId = txIdFromObject(charge);
  if (metadataTxId) {
    const full = await getTransaction(env, metadataTxId);
    if (!full) throw new Error(`Stripe charge ${chargeId} references missing transaction ${metadataTxId}`);
    ensureTransactionAccount(full, accountId);
    return { tx: full, charge };
  }

  const paymentIntentId = objectId(charge.payment_intent);
  if (!paymentIntentId) return null;

  tx = await env.DB.prepare(`
    SELECT id FROM transactions WHERE stripe_payment_intent_id = ? LIMIT 1
  `).bind(paymentIntentId).first();
  if (tx) {
    const full = await getTransaction(env, tx.id);
    ensureTransactionAccount(full, accountId);
    return { tx: full, charge };
  }

  const intent = await retrievePaymentIntent(env, accountId, paymentIntentId);
  const intentTxId = txIdFromObject(intent);
  if (!intentTxId) return null;
  const full = await getTransaction(env, intentTxId);
  if (!full) throw new Error(`Stripe PaymentIntent ${paymentIntentId} references missing transaction ${intentTxId}`);
  ensureTransactionAccount(full, accountId);
  return { tx: full, charge };
}

function ensureTransactionAccount(tx, accountId) {
  if (!tx) throw new Error('Cannot validate Stripe account for a missing transaction');
  if (tx.processor_account_id && tx.processor_account_id !== accountId) {
    throw new Error(`Stripe account mismatch for ${tx.id}: expected ${tx.processor_account_id}, received ${accountId}`);
  }
}

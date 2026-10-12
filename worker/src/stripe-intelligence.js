import { retrieveCharge, retrievePaymentIntent } from './stripe.js';
import {
  linkTransactionArtifact,
  observeTransactionComponent,
  recordTransactionSourceObject,
} from './transaction-intelligence.js';

function stripeTime(seconds) {
  if (!seconds) return null;
  return new Date(Number(seconds) * 1000).toISOString();
}

function txIdFromObject(object) {
  return object?.metadata?.builtegrity_tx_id || object?.client_reference_id || null;
}

export async function projectStripeEventToTransactionIntelligence(env, event) {
  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
      case 'checkout.session.async_payment_failed':
        return projectCheckout(env, event);
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
        return projectPaymentIntent(env, event);
      case 'application_fee.created':
        return projectApplicationFee(env, event);
      case 'charge.refunded':
        return projectRefund(env, event);
      case 'charge.dispute.created':
      case 'charge.dispute.closed':
        return projectDispute(env, event);
      case 'payout.reconciliation_completed':
      case 'payout.paid':
      case 'payout.failed':
        return projectPayout(env, event);
      default:
        return { projected: false, reason: 'event_not_material_to_transaction_graph' };
    }
  } catch (error) {
    // Transaction processing has already happened by the time this projection runs.
    // Intelligence projection must be repairable/replayable rather than causing Stripe webhook retries.
    console.error('Stripe transaction-intelligence projection failed', event.id, error);
    return { projected: false, projection_error: String(error?.message || error) };
  }
}

async function projectCheckout(env, event) {
  const session = event.data?.object || {};
  const txId = txIdFromObject(session);
  if (!txId || !session.id) return { projected: false, reason: 'transaction_not_identified' };

  await recordTransactionSourceObject(env, {
    transaction_id: txId,
    source_system: 'STRIPE',
    object_type: 'CHECKOUT_SESSION',
    external_id: session.id,
    external_parent_id: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
    observed_at: stripeTime(event.created),
    metadata: { payment_status: session.payment_status || null, status: session.status || null },
  });
  return { projected: true, transaction_id: txId };
}

async function projectPaymentIntent(env, event) {
  const intentEvent = event.data?.object || {};
  const txId = txIdFromObject(intentEvent);
  if (!txId || !intentEvent.id) return { projected: false, reason: 'transaction_not_identified' };

  await recordTransactionSourceObject(env, {
    transaction_id: txId,
    source_system: 'STRIPE',
    object_type: 'PAYMENT_INTENT',
    external_id: intentEvent.id,
    observed_at: stripeTime(event.created),
    metadata: { status: intentEvent.status || null },
  });

  if (event.type !== 'payment_intent.succeeded') return { projected: true, transaction_id: txId };

  const tx = await env.DB.prepare(`
    SELECT id, processor_account_id FROM transactions t
    JOIN merchants m ON m.id = t.merchant_id
    WHERE t.id = ?
  `).bind(txId).first();
  const accountId = event.account || tx?.processor_account_id;
  if (!accountId) return { projected: true, transaction_id: txId, receipt_projected: false };

  const intent = await retrievePaymentIntent(env, accountId, intentEvent.id);
  const latestCharge = intent.latest_charge;
  const chargeId = typeof latestCharge === 'string' ? latestCharge : latestCharge?.id;
  if (!chargeId) return { projected: true, transaction_id: txId, receipt_projected: false };
  const charge = typeof latestCharge === 'object' && latestCharge?.balance_transaction
    ? latestCharge
    : await retrieveCharge(env, accountId, chargeId);

  await recordTransactionSourceObject(env, {
    transaction_id: txId,
    source_system: 'STRIPE',
    object_type: 'CHARGE',
    external_id: charge.id,
    external_parent_id: intent.id,
    observed_at: stripeTime(event.created),
    metadata: { amount: charge.amount, amount_captured: charge.amount_captured, status: charge.status || null },
  });

  const balance = charge.balance_transaction;
  const balanceId = typeof balance === 'string' ? balance : balance?.id;
  if (balanceId) {
    await recordTransactionSourceObject(env, {
      transaction_id: txId,
      source_system: 'STRIPE',
      object_type: 'BALANCE_TRANSACTION',
      external_id: balanceId,
      external_parent_id: charge.id,
      observed_at: stripeTime(event.created),
      metadata: typeof balance === 'object' ? { fee: balance.fee, net: balance.net, available_on: balance.available_on } : {},
    });
  }

  const fee = charge.application_fee;
  const feeId = typeof fee === 'string' ? fee : fee?.id;
  if (feeId) {
    await recordTransactionSourceObject(env, {
      transaction_id: txId,
      source_system: 'STRIPE',
      object_type: 'APPLICATION_FEE',
      external_id: feeId,
      external_parent_id: charge.id,
      observed_at: stripeTime(event.created),
      metadata: typeof fee === 'object' ? { amount: fee.amount } : {},
    });
  }

  if (charge.receipt_url) {
    await linkTransactionArtifact(env, {
      transaction_id: txId,
      artifact_type: 'RECEIPT',
      source_system: 'STRIPE',
      source_ref: `${charge.id}:receipt`,
      external_url: charge.receipt_url,
      observed_at: stripeTime(event.created),
      metadata: {
        charge_id: charge.id,
        receipt_number: charge.receipt_number || null,
        provider_hosted: true,
      },
    });
  }

  return { projected: true, transaction_id: txId, receipt_projected: Boolean(charge.receipt_url) };
}

async function projectApplicationFee(env, event) {
  const fee = event.data?.object || {};
  const chargeId = typeof fee.charge === 'string' ? fee.charge : fee.charge?.id;
  if (!chargeId || !fee.id) return { projected: false, reason: 'missing_charge' };
  const tx = await env.DB.prepare(`SELECT id FROM transactions WHERE stripe_charge_id = ? LIMIT 1`).bind(chargeId).first();
  if (!tx) return { projected: false, reason: 'transaction_not_identified' };

  await recordTransactionSourceObject(env, {
    transaction_id: tx.id,
    source_system: 'STRIPE',
    object_type: 'APPLICATION_FEE',
    external_id: fee.id,
    external_parent_id: chargeId,
    observed_at: stripeTime(event.created),
    metadata: { amount: fee.amount || null },
  });
  return { projected: true, transaction_id: tx.id };
}

async function projectRefund(env, event) {
  const charge = event.data?.object || {};
  if (!charge.id) return { projected: false, reason: 'missing_charge' };
  const tx = await env.DB.prepare(`SELECT id FROM transactions WHERE stripe_charge_id = ? LIMIT 1`).bind(charge.id).first();
  if (!tx) return { projected: false, reason: 'transaction_not_identified' };

  const prior = await env.DB.prepare(`
    SELECT COALESCE(SUM(amount_cents),0) AS amount
    FROM transaction_components
    WHERE transaction_id = ? AND source_system = 'STRIPE'
      AND component_type_code IN ('FULL_REFUND','PARTIAL_REFUND')
      AND basis = 'ACTUAL'
  `).bind(tx.id).first();
  const cumulative = Math.max(0, Number(charge.amount_refunded || 0));
  const delta = Math.max(0, cumulative - Number(prior?.amount || 0));
  if (delta > 0) {
    await observeTransactionComponent(env, {
      transaction_id: tx.id,
      component_type_code: charge.refunded && Number(prior?.amount || 0) === 0 ? 'FULL_REFUND' : 'PARTIAL_REFUND',
      scope: 'PAYMENT',
      basis: 'ACTUAL',
      amount_cents: delta,
      source_system: 'STRIPE',
      source_ref: `${event.id}:refund-delta`,
      raw_label: charge.refunded ? 'Stripe full refund' : 'Stripe partial refund',
      observed_at: stripeTime(event.created),
      metadata: { charge_id: charge.id, cumulative_amount_refunded: cumulative, now_fully_refunded: Boolean(charge.refunded) },
    });
  }

  await linkTransactionArtifact(env, {
    transaction_id: tx.id,
    artifact_type: 'REFUND_RECEIPT',
    source_system: 'STRIPE',
    source_ref: `${event.id}:refund-record`,
    observed_at: stripeTime(event.created),
    metadata: { charge_id: charge.id, cumulative_amount_refunded: cumulative, fully_refunded: Boolean(charge.refunded) },
  });
  return { projected: true, transaction_id: tx.id, refund_delta_cents: delta };
}

async function projectDispute(env, event) {
  const dispute = event.data?.object || {};
  const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
  if (!chargeId || !dispute.id) return { projected: false, reason: 'missing_charge' };
  const tx = await env.DB.prepare(`SELECT id FROM transactions WHERE stripe_charge_id = ? LIMIT 1`).bind(chargeId).first();
  if (!tx) return { projected: false, reason: 'transaction_not_identified' };

  await recordTransactionSourceObject(env, {
    transaction_id: tx.id,
    source_system: 'STRIPE',
    object_type: 'DISPUTE',
    external_id: dispute.id,
    external_parent_id: chargeId,
    observed_at: stripeTime(event.created),
    metadata: { amount: dispute.amount || null, reason: dispute.reason || null, status: dispute.status || null },
  });

  if (event.type === 'charge.dispute.created') {
    await observeTransactionComponent(env, {
      transaction_id: tx.id,
      component_type_code: 'DISPUTE_PRINCIPAL',
      scope: 'PAYMENT',
      basis: 'OBSERVED',
      amount_cents: Number(dispute.amount || 0),
      source_system: 'STRIPE',
      source_ref: `${dispute.id}:principal`,
      raw_label: `Stripe dispute ${dispute.reason || ''}`.trim(),
      observed_at: stripeTime(event.created),
      metadata: { dispute_id: dispute.id, reason: dispute.reason || null, status: dispute.status || null },
    });
  } else if (event.type === 'charge.dispute.closed' && String(dispute.status || '').toLowerCase() === 'won') {
    await observeTransactionComponent(env, {
      transaction_id: tx.id,
      component_type_code: 'DISPUTE_RECOVERY',
      scope: 'PAYMENT',
      basis: 'OBSERVED',
      amount_cents: Number(dispute.amount || 0),
      source_system: 'STRIPE',
      source_ref: `${dispute.id}:recovery`,
      raw_label: 'Stripe dispute won',
      observed_at: stripeTime(event.created),
      metadata: { dispute_id: dispute.id, status: dispute.status || null },
    });
  }

  return { projected: true, transaction_id: tx.id };
}

async function projectPayout(env, event) {
  const payout = event.data?.object || {};
  if (!payout.id) return { projected: false, reason: 'missing_payout' };
  const rows = await env.DB.prepare(`SELECT id FROM transactions WHERE stripe_payout_id = ?`).bind(payout.id).all();
  let count = 0;
  for (const tx of rows.results || []) {
    await recordTransactionSourceObject(env, {
      transaction_id: tx.id,
      source_system: 'STRIPE',
      object_type: 'PAYOUT',
      external_id: payout.id,
      observed_at: stripeTime(event.created),
      metadata: { amount: payout.amount || null, status: payout.status || null, arrival_date: payout.arrival_date || null },
    });
    count += 1;
  }
  return { projected: count > 0, projected_transactions: count };
}

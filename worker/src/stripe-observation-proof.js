/**
 * Stripe observation pilot: verified payment -> proposed usage ledger entry.
 * Pure, non-deploying functions. They never persist or bill a merchant.
 *
 * The caller MUST verify the raw Stripe webhook signature and independently
 * retrieve the PaymentIntent and Charge from the *same authorized* Stripe account.
 * Only an authenticated server-side codepath may assert the evidence flags.
 */
import { assessUsageEligibility } from './usage-billing-primitives.js';
import { usageLedgerEntry } from './usage-fee-ledger.js';

const USD_3_PERCENT_POLICY = 'BG_OBSERVED_300BPS_V1';
const RATE_BPS = 300n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const fail = (reason) => Object.freeze({ eligible: false, reason });
const idOf = (value) => typeof value === 'string' ? value : value?.id;

export function normalizeExternallyInitiatedStripePayment({
  event, connection, retrievedIntent, retrievedCharge,
  signatureVerified = false, processorAccessVerified = false,
} = {}) {
  if (signatureVerified !== true || processorAccessVerified !== true) return fail('SOURCE_NOT_VERIFIED');
  if (event?.type !== 'payment_intent.succeeded') return fail('NOT_SUPPORTED_PAYMENT_EVENT');
  if (!/^acct_[A-Za-z0-9]+$/.test(String(event?.account || ''))) return fail('MISSING_STRIPE_ACCOUNT_CONTEXT');
  if (connection?.provider !== 'STRIPE' || connection?.status !== 'ACTIVE'
      || connection.processorAccountId !== event.account || !connection.merchantId
      || connection.paymentsReadable !== true) return fail('UNAUTHORIZED_OR_INACTIVE_CONNECTION');

  const eventIntent = event?.data?.object;
  if (!/^pi_[A-Za-z0-9]+$/.test(String(eventIntent?.id || ''))
      || retrievedIntent?.id !== eventIntent.id
      || retrievedIntent?.status !== 'succeeded'
      || eventIntent.status !== 'succeeded') return fail('PAYMENT_NOT_INDEPENDENTLY_CONFIRMED');
  if (eventIntent.currency !== retrievedIntent.currency
      || eventIntent.amount_received !== retrievedIntent.amount_received) return fail('PAYMENT_FACTS_MISMATCH');
  if (String(retrievedIntent.currency).toLowerCase() !== 'usd') return fail('UNSUPPORTED_CURRENCY');
  const amountCents = retrievedIntent.amount_received;
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return fail('INVALID_CAPTURE_AMOUNT');

  const chargeId = idOf(retrievedIntent.latest_charge);
  if (!chargeId || retrievedCharge?.id !== chargeId
      || idOf(retrievedCharge.payment_intent) !== retrievedIntent.id
      || retrievedCharge.paid !== true || retrievedCharge.captured !== true
      || retrievedCharge.status !== 'succeeded'
      || retrievedCharge.currency !== retrievedIntent.currency
      || retrievedCharge.amount_captured !== amountCents) return fail('CHARGE_NOT_INDEPENDENTLY_CONFIRMED');
  const balanceTransactionId = idOf(retrievedCharge.balance_transaction);
  if (!balanceTransactionId) return fail('BALANCE_TRANSACTION_PENDING');
  const created = Number(event?.created);
  if (!Number.isSafeInteger(created) || created <= 0) return fail('INVALID_EVENT_TIMESTAMP');

  // Legacy Builtegrity-controlled Checkout remains a separate fee lane.
  if (retrievedIntent.metadata?.builtegrity_tx_id || retrievedCharge.metadata?.builtegrity_tx_id
      || eventIntent.metadata?.builtegrity_tx_id) return fail('LEGACY_BUILTEGRITY_CHECKOUT');

  return Object.freeze({
    eligible: true,
    merchantId: connection.merchantId,
    provider: 'STRIPE',
    processorAccountId: connection.processorAccountId,
    transactionId: retrievedIntent.id,
    chargeId: retrievedCharge.id,
    balanceTransactionId,
    amountCents,
    currency: 'USD',
    occurredAt: new Date(created * 1000).toISOString(),
    recordClassification: 'OBSERVED',
    integrityState: 'INCOMPLETE', // payout/bank finality has not been established
    // Unversioned economic identity prevents the same payment from being billed
    // again solely because a merchant signed an updated pricing agreement.
    economicKey: JSON.stringify([connection.merchantId, 'STRIPE', connection.processorAccountId, retrievedIntent.id, 'SUCCESSFUL_PAYMENT']),
  });
}

/** Generate a dry-run *proposal* only; no entitlement is saved or paid here. */
export function previewStripeObservationFee({observation, agreement, existingApplicationFee} = {}) {
  if (!observation?.eligible) return fail(observation?.reason || 'NO_VERIFIED_OBSERVATION');
  if (typeof existingApplicationFee !== 'boolean') return fail('APPLICATION_FEE_EVIDENCE_REQUIRED');
  if (existingApplicationFee) return fail('APPLICATION_FEE_ALREADY_COLLECTED');
  if (agreement?.pricingPolicyId !== USD_3_PERCENT_POLICY || agreement?.rateBps !== 300)
    return fail('PRICING_NOT_EXPLICITLY_APPROVED');
  const eligibility = assessUsageEligibility({
    agreement,
    payment: {
      verified: true,
      provider: observation.provider,
      processorAccountId: observation.processorAccountId,
      transactionId: observation.transactionId,
      merchantId: observation.merchantId,
      occurredAt: observation.occurredAt,
      currency: observation.currency,
      status: 'SUCCEEDED',
      amountMinor: observation.amountCents,
    },
    collectionMode: 'USAGE_BILLING',
    existingApplicationFee,
  });
  if (!eligibility.eligible) return fail(eligibility.reason);
  // One USD cent is 10,000 micros; 300 bps is exactly amount_cents*300 micros.
  // Keeping micros avoids rounding before invoice/settlement aggregation.
  const feeMicros = BigInt(observation.amountCents) * RATE_BPS;
  if (feeMicros > MAX_SAFE) return fail('FEE_EXCEEDS_SAFE_INTEGER');
  const proposedLedgerEntry = usageLedgerEntry({
    eligibility,
    merchantId: observation.merchantId,
    provider: observation.provider,
    processorAccountId: observation.processorAccountId,
    transactionId: observation.transactionId,
    currency: observation.currency,
    amountMicros: Number(feeMicros),
    occurredAt: observation.occurredAt,
  });
  return Object.freeze({
    eligible: true,
    mode: 'DRY_RUN_ONLY',
    collectionAuthorizedByThisFunction: false,
    economicKey: observation.economicKey,
    entry: proposedLedgerEntry,
    recordClassification: observation.recordClassification,
    integrityState: observation.integrityState,
  });
}

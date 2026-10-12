import { processStripeWebhook as processUncheckedStripeWebhook } from './webhooks.js';

const DIRECT_TRANSACTION_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.expired',
  'checkout.session.async_payment_failed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
]);

export async function processStripeWebhook(env, event) {
  await requireDirectTransactionAccount(env, event);
  return processUncheckedStripeWebhook(env, event);
}

export async function requireDirectTransactionAccount(env, event) {
  if (!DIRECT_TRANSACTION_EVENTS.has(String(event?.type || ''))) return;

  const object = event?.data?.object;
  const transactionId = object?.metadata?.builtegrity_tx_id || object?.client_reference_id || null;
  if (!transactionId) return;

  const row = await env.DB.prepare(`
    SELECT t.id, m.processor_account_id
    FROM transactions t
    JOIN merchants m ON m.id = t.merchant_id
    WHERE t.id = ?
    LIMIT 1
  `).bind(transactionId).first();

  if (!row) {
    throw new Error(`Stripe ${event.type} references missing transaction ${transactionId}`);
  }

  const expectedAccount = String(row.processor_account_id || '').trim();
  const eventAccount = String(event.account || '').trim();
  if (!expectedAccount || !eventAccount || expectedAccount !== eventAccount) {
    throw new Error(`Stripe connected-account boundary mismatch for ${transactionId}`);
  }
}

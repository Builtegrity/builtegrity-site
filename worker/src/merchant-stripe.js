import { retrieveConnectedAccount } from './stripe.js';

export async function verifyMerchantStripe(env, merchantId) {
  const merchant = await env.DB.prepare(`SELECT * FROM merchants WHERE id = ?`).bind(merchantId).first();
  if (!merchant) return json({ error: 'Merchant not found' }, 404);
  if (!merchant.processor_account_id || !String(merchant.processor_account_id).startsWith('acct_')) {
    return json({ compatible: false, reason: 'No Stripe connected account is stored for this merchant' }, 409);
  }

  const account = await retrieveConnectedAccount(env, merchant.processor_account_id);
  const payoutInterval = account.settings?.payouts?.schedule?.interval || null;
  const automaticPayouts = payoutInterval ? payoutInterval !== 'manual' : false;
  const country = String(account.country || '').toUpperCase();
  const usLaunchCompatible = country === 'US';
  const compatible = Boolean(
    account.charges_enabled &&
    account.payouts_enabled &&
    account.details_submitted &&
    automaticPayouts &&
    usLaunchCompatible,
  );

  await env.DB.prepare(`
    UPDATE merchants
       SET status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).bind(compatible ? 'ACTIVE' : 'TEST', merchantId).run();

  const reasons = [];
  if (!account.charges_enabled) reasons.push('charges are not enabled');
  if (!account.payouts_enabled) reasons.push('payouts are not enabled');
  if (!account.details_submitted) reasons.push('Stripe account details are incomplete');
  if (!automaticPayouts) reasons.push('automatic payouts are not confirmed');
  if (!usLaunchCompatible) reasons.push(`launch country must be US (received ${country || 'unknown'})`);

  return json({
    compatible,
    reason: compatible ? null : reasons.join('; '),
    account_id: account.id,
    country: country || null,
    charges_enabled: Boolean(account.charges_enabled),
    payouts_enabled: Boolean(account.payouts_enabled),
    payout_interval: payoutInterval,
    automatic_payouts: automaticPayouts,
    details_submitted: Boolean(account.details_submitted),
  }, compatible ? 200 : 409);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

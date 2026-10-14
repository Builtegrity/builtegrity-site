export const FEE_REFUND_ACK_VERSION = 'BG-FEE-REFUND-ACK-V1';
export const FEE_REFUND_ACK_TEXT = 'I understand that Builtegrity charges only on successfully processed PROTECTED payments; the Builtegrity Platform Fee becomes earned when that protected payment succeeds and the matching Builtegrity application fee is confirmed by the processor; and a later refund, partial refund, cancellation, or dispute does not by itself reverse an earned Platform Fee except where applicable law, processor requirements, or a verified Builtegrity error requires a refund or credit.';

const HANDLER_RANK = new Map([
  ['RETAIN_IF_EARNED', 0],
  ['PRO_RATA_APP_FEE', 1],
  ['FULL_APP_FEE_ON_FULL_REFUND', 2],
  ['FULL_APP_FEE_ON_FULL_REFUND_OR_LOST_DISPUTE', 3],
  ['FULL_APP_FEE_ON_ANY_REFUND', 4],
]);

export async function getActiveFeeRefundPolicy(env) {
  const controls = await env.DB.prepare(`
    SELECT platform_fee_refund_policy_status,platform_fee_refund_policy_reference,
           platform_fee_refund_policy_reviewed_at,platform_fee_refund_policy_next_review_due_at
      FROM platform_compliance_controls WHERE id='GLOBAL'
  `).first();
  if (!controls || controls.platform_fee_refund_policy_status !== 'APPROVED') {
    throw statusError('Builtegrity Platform Fee refund policy has not been approved for live use', 503);
  }
  if (!controls.platform_fee_refund_policy_reference || !controls.platform_fee_refund_policy_reviewed_at) {
    throw statusError('Builtegrity Platform Fee refund policy approval evidence is incomplete', 503);
  }
  if (controls.platform_fee_refund_policy_next_review_due_at && Date.parse(controls.platform_fee_refund_policy_next_review_due_at) <= Date.now()) {
    throw statusError('Builtegrity Platform Fee refund policy legal review has expired', 503);
  }

  const policy = await env.DB.prepare(`
    SELECT * FROM fee_refund_policy_versions
    WHERE status='APPROVED' AND effective_at IS NOT NULL AND datetime(effective_at)<=CURRENT_TIMESTAMP
      AND (next_review_due_at IS NULL OR datetime(next_review_due_at)>CURRENT_TIMESTAMP)
      AND counsel_reference IS NOT NULL AND counsel_reviewed_at IS NOT NULL
    ORDER BY datetime(effective_at) DESC, created_at DESC LIMIT 1
  `).first();
  if (!policy) throw statusError('No current counsel-approved Platform Fee refund policy exists', 503);
  return policy;
}

export async function getCurrentMerchantFeePolicyAcceptance(env, merchantId) {
  let policy;
  try { policy = await getActiveFeeRefundPolicy(env); }
  catch (error) { return { ready: false, reason: error.message, policy: null, fee_schedule: null, acceptance: null }; }

  const feeSchedule = await env.DB.prepare(`
    SELECT * FROM legal_document_versions
    WHERE document_type='FEE_SCHEDULE' AND status='APPROVED'
      AND effective_at IS NOT NULL AND datetime(effective_at)<=CURRENT_TIMESTAMP
    ORDER BY datetime(effective_at) DESC, created_at DESC LIMIT 1
  `).first();
  if (!feeSchedule) return { ready: false, reason: 'No approved Fee Schedule is effective', policy, fee_schedule: null, acceptance: null };

  const acceptance = await env.DB.prepare(`
    SELECT * FROM merchant_fee_policy_acceptances
    WHERE merchant_id=? AND fee_schedule_version=? AND fee_refund_policy_version=?
      AND acknowledgment_version=?
    ORDER BY accepted_at DESC LIMIT 1
  `).bind(merchantId, feeSchedule.version, policy.version, FEE_REFUND_ACK_VERSION).first();

  return {
    ready: Boolean(acceptance),
    reason: acceptance ? null : 'Explicit Platform Fee earning/refund acknowledgment is missing',
    policy,
    fee_schedule: feeSchedule,
    acceptance: acceptance || null,
    acknowledgment_version: FEE_REFUND_ACK_VERSION,
    acknowledgment_text: FEE_REFUND_ACK_TEXT,
  };
}

export async function recordMerchantFeePolicyAcceptance(env, merchantId, externalUserId, input = {}, requestEvidence = {}) {
  if (input.fee_refund_policy_acknowledged !== true) {
    throw statusError('Explicit Platform Fee earning/refund acknowledgment is required', 400);
  }
  const current = await getCurrentMerchantFeePolicyAcceptance(env, merchantId);
  if (!current.policy || !current.fee_schedule) throw statusError(current.reason || 'Fee policy is unavailable', 503);

  const acknowledgementSha = await sha256Hex(FEE_REFUND_ACK_TEXT);
  const networkHash = await evidenceHash(env, requestEvidence.ip || '');
  const userAgentHash = await evidenceHash(env, requestEvidence.userAgent || '');
  const id = `MFPA-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT OR IGNORE INTO merchant_fee_policy_acceptances
      (id,merchant_id,external_user_id,fee_schedule_version,fee_refund_policy_version,
       acknowledgment_version,acknowledgment_text,acknowledgment_sha256,
       network_evidence_hash,user_agent_hash,evidence_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, merchantId, externalUserId,
    current.fee_schedule.version, current.policy.version,
    FEE_REFUND_ACK_VERSION, FEE_REFUND_ACK_TEXT, acknowledgementSha,
    networkHash, userAgentHash,
    JSON.stringify({
      fee_schedule_document_id: current.fee_schedule.id,
      fee_schedule_public_path: current.fee_schedule.public_path,
      fee_refund_policy_id: current.policy.id,
      disclosure_summary: current.policy.disclosure_summary,
    }),
  ).run();
  return getCurrentMerchantFeePolicyAcceptance(env, merchantId);
}

export async function resolveFeeRefundRule(env, merchantStateCode, customerStateCode) {
  const policy = await getActiveFeeRefundPolicy(env);
  const merchantRule = await loadStateRule(env, merchantStateCode, 'merchant');
  const customerRule = await loadStateRule(env, customerStateCode, 'customer');
  const candidates = [
    { code: policy.default_handler_code, source: `POLICY:${policy.version}` },
    { code: merchantRule.handler.code, source: `MERCHANT_STATE:${merchantRule.state.state_code}` },
    { code: customerRule.handler.code, source: `CUSTOMER_STATE:${customerRule.state.state_code}` },
  ];
  const selected = candidates.sort((a, b) => rankHandler(b.code) - rankHandler(a.code))[0];
  return {
    policy,
    handler_code: selected.code,
    rule_source: selected.source,
    merchant_state_code: merchantRule.state.state_code,
    customer_state_code: customerRule.state.state_code,
    merchant_state_reference: merchantRule.state.platform_fee_refund_reference,
    customer_state_reference: customerRule.state.platform_fee_refund_reference,
    all_handlers: candidates,
  };
}

export async function lockTransactionFeeRefundRule(env, transactionId) {
  const tx = await env.DB.prepare(`
    SELECT t.*,m.state_code AS merchant_state_code
      FROM transactions t JOIN merchants m ON m.id=t.merchant_id
     WHERE t.id=?
  `).bind(transactionId).first();
  if (!tx) throw statusError('Transaction not found while locking fee/refund compliance', 404);
  if (tx.fee_refund_rule_locked_at) return tx;
  if (tx.payment_at || tx.stripe_checkout_session_id) throw statusError('Fee/refund compliance must be locked before Checkout starts', 409);
  if (!/^[A-Z]{2}$/.test(String(tx.customer_attested_state_code || ''))) {
    throw statusError('Customer state must be attested before fee/refund compliance can be locked', 409);
  }

  const merchantAcceptance = await getCurrentMerchantFeePolicyAcceptance(env, tx.merchant_id);
  if (!merchantAcceptance.ready) throw statusError(merchantAcceptance.reason || 'Merchant fee-policy acceptance is missing', 409);
  const rule = await resolveFeeRefundRule(env, tx.merchant_state_code, tx.customer_attested_state_code);
  if (merchantAcceptance.policy.id !== rule.policy.id) throw statusError('Merchant fee-policy acceptance is not for the current refund policy', 409);

  await env.DB.prepare(`
    UPDATE transactions
       SET fee_refund_policy_version_id=?,merchant_fee_policy_acceptance_id=?,
           fee_refund_handler_code=?,fee_refund_rule_source=?,
           fee_refund_merchant_state_code=?,fee_refund_customer_state_code=?,
           fee_refund_rule_locked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND fee_refund_rule_locked_at IS NULL AND payment_at IS NULL AND stripe_checkout_session_id IS NULL
  `).bind(
    rule.policy.id,
    merchantAcceptance.acceptance.id,
    rule.handler_code,
    rule.rule_source,
    rule.merchant_state_code,
    rule.customer_state_code,
    transactionId,
  ).run();
  return env.DB.prepare(`SELECT * FROM transactions WHERE id=?`).bind(transactionId).first();
}

export function assertTransactionFeeRefundRuleLocked(tx) {
  if (!tx?.fee_refund_rule_locked_at || !tx?.fee_refund_policy_version_id || !tx?.merchant_fee_policy_acceptance_id || !tx?.fee_refund_handler_code) {
    throw statusError('Transaction Platform Fee/refund compliance rule is not locked', 409);
  }
  if (!HANDLER_RANK.has(tx.fee_refund_handler_code)) throw statusError('Transaction references an unknown Platform Fee refund handler', 409);
  return true;
}

export function calculateRequiredPlatformFeeRefundCents(input = {}) {
  const handlerCode = String(input.handler_code || '');
  const grossFee = nonnegativeInt(input.gross_application_fee_cents);
  const underlyingAmount = nonnegativeInt(input.underlying_amount_cents);
  const cumulativeRefunded = Math.min(underlyingAmount, nonnegativeInt(input.cumulative_underlying_refunded_cents));
  const disputeLost = Boolean(input.dispute_lost);
  if (!HANDLER_RANK.has(handlerCode)) throw new Error(`Unknown fee refund handler ${handlerCode}`);
  if (grossFee <= 0 || underlyingAmount <= 0) return 0;

  if (handlerCode === 'RETAIN_IF_EARNED') return 0;
  if (handlerCode === 'FULL_APP_FEE_ON_ANY_REFUND') return cumulativeRefunded > 0 ? grossFee : 0;
  if (handlerCode === 'FULL_APP_FEE_ON_FULL_REFUND') return cumulativeRefunded >= underlyingAmount ? grossFee : 0;
  if (handlerCode === 'FULL_APP_FEE_ON_FULL_REFUND_OR_LOST_DISPUTE') {
    return (cumulativeRefunded >= underlyingAmount || disputeLost) ? grossFee : 0;
  }
  if (handlerCode === 'PRO_RATA_APP_FEE') {
    if (cumulativeRefunded <= 0) return 0;
    return Math.min(grossFee, Math.ceil((grossFee * cumulativeRefunded) / underlyingAmount));
  }
  return 0;
}

export async function authorizeRequiredPlatformFeeRefund(env, transactionId, trigger = {}) {
  const tx = await env.DB.prepare(`
    SELECT id,merchant_id,currency,amount_cents,customer_paid_cents,refunded_cents,
           application_fee_gross_confirmed_cents,application_fee_refunded_cents,
           platform_fee_earned_at,fee_refund_policy_version_id,fee_refund_handler_code,
           fee_refund_rule_source,fee_refund_merchant_state_code,fee_refund_customer_state_code
      FROM transactions WHERE id=?
  `).bind(transactionId).first();
  if (!tx) throw statusError('Transaction not found while evaluating required Platform Fee refund', 404);
  if (!tx.fee_refund_handler_code) throw statusError('Transaction has no locked Platform Fee refund handler', 409);

  const grossFee = nonnegativeInt(tx.application_fee_gross_confirmed_cents);
  const underlyingAmount = Math.max(1, nonnegativeInt(tx.customer_paid_cents || tx.amount_cents));
  const cumulativeRefunded = nonnegativeInt(trigger.cumulative_refunded_cents ?? tx.refunded_cents);
  const target = calculateRequiredPlatformFeeRefundCents({
    handler_code: tx.fee_refund_handler_code,
    gross_application_fee_cents: grossFee,
    underlying_amount_cents: underlyingAmount,
    cumulative_underlying_refunded_cents: cumulativeRefunded,
    dispute_lost: trigger.type === 'DISPUTE_LOST',
  });
  if (target <= 0) return { authorized: false, target_cents: 0, reason: 'NO_REFUND_REQUIRED' };

  const alreadyRefunded = nonnegativeInt(tx.application_fee_refunded_cents);
  const pending = await env.DB.prepare(`
    SELECT COALESCE(SUM(amount_cents),0) AS cents
      FROM platform_fee_credit_authorizations
     WHERE transaction_id=? AND reason_code='LEGAL_REQUIRED_CREDIT'
       AND status IN ('AUTHORIZED','PROCESSING')
  `).bind(tx.id).first();
  const pendingCents = nonnegativeInt(pending?.cents);
  const delta = Math.max(0, target - alreadyRefunded - pendingCents);
  if (delta <= 0) return { authorized: false, target_cents: target, reason: 'ALREADY_AUTHORIZED_OR_REFUNDED' };

  const creditId = `PFC-LEGAL-${tx.id}-${tx.fee_refund_handler_code}-${target}`;
  const evidence = [
    `POLICY=${tx.fee_refund_policy_version_id || 'UNKNOWN'}`,
    `HANDLER=${tx.fee_refund_handler_code}`,
    `SOURCE=${tx.fee_refund_rule_source || 'UNKNOWN'}`,
    `MERCHANT_STATE=${tx.fee_refund_merchant_state_code || 'UNKNOWN'}`,
    `CUSTOMER_STATE=${tx.fee_refund_customer_state_code || 'UNKNOWN'}`,
    `TRIGGER=${trigger.type || 'UNDERLYING_REFUND'}`,
    `TARGET=${target}`,
  ].join(';');

  await env.DB.prepare(`
    INSERT OR IGNORE INTO platform_fee_credit_authorizations
      (id,transaction_id,merchant_id,amount_cents,currency,reason_code,evidence_reference,authorization_source,status)
    VALUES(?,?,?,?,?,'LEGAL_REQUIRED_CREDIT',?,'LEGAL','AUTHORIZED')
  `).bind(creditId, tx.id, tx.merchant_id, delta, tx.currency || 'USD', evidence).run();

  return { authorized: true, credit_id: creditId, amount_cents: delta, target_cents: target };
}

async function loadStateRule(env, stateCode, role) {
  const code = String(stateCode || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw statusError(`Valid ${role} U.S. state is required for Platform Fee refund compliance`, 409);
  const state = await env.DB.prepare(`SELECT * FROM state_jurisdiction_support WHERE state_code=?`).bind(code).first();
  if (!state || state.platform_fee_refund_review_status !== 'READY') {
    throw statusError(`${role} state ${code} is not legally cleared for Platform Fee refund treatment`, 409);
  }
  if (!state.platform_fee_refund_reference || !state.platform_fee_refund_reviewed_at) {
    throw statusError(`${role} state ${code} Platform Fee refund evidence is incomplete`, 409);
  }
  if (state.platform_fee_refund_next_review_due_at && Date.parse(state.platform_fee_refund_next_review_due_at) <= Date.now()) {
    throw statusError(`${role} state ${code} Platform Fee refund review has expired`, 409);
  }
  const handler = await env.DB.prepare(`
    SELECT * FROM fee_refund_handler_catalog WHERE code=? AND implementation_status='TESTED'
  `).bind(state.platform_fee_refund_handler_code || '').first();
  if (!handler) throw statusError(`${role} state ${code} does not have a tested Platform Fee refund handler`, 409);
  return { state, handler };
}

function rankHandler(code) {
  if (!HANDLER_RANK.has(code)) throw statusError(`Unknown Platform Fee refund handler ${code}`, 503);
  return HANDLER_RANK.get(code);
}

function nonnegativeInt(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function evidenceHash(env, value) {
  if (!value) return null;
  const salt = String(env.COMPLIANCE_EVIDENCE_SALT || '');
  if (!salt) throw statusError('COMPLIANCE_EVIDENCE_SALT is required to record fee-policy acceptance evidence', 503);
  return sha256Hex(`${salt}:${value}`);
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

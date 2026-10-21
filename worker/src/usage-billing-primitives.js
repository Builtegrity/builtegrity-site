/**
 * Processor-neutral usage billing primitives (NOT wired into live collection).
 * No billing entitlement is created without a signed active agreement and verified processor truth.
 * This module deliberately does not implement the pricing policy or send invoices.
 */
export function entitlementKey({merchantId, provider, processorAccountId, transactionId, component, agreementVersion}) {
  for (const [name, value] of Object.entries({merchantId, provider, processorAccountId, transactionId, component, agreementVersion})) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`Missing ${name}`);
  }
  // JSON encoding gives an unambiguous composite key even when IDs contain separators.
  return JSON.stringify([merchantId, provider, processorAccountId, transactionId, component, agreementVersion]);
}

export function assessUsageEligibility({agreement, payment, collectionMode, existingApplicationFee = false}) {
  if (!agreement || agreement.status !== "ACTIVE" || !agreement.acceptedAt ||
      !agreement.effectiveFrom || !agreement.version || !agreement.pricingPolicyId) {
    return {eligible: false, reason: "NO_ACTIVE_ACCEPTED_PRICING_AGREEMENT"};
  }
  if (!payment || !payment.verified || !payment.provider || !payment.processorAccountId ||
      !payment.transactionId || !payment.occurredAt || !payment.currency) {
    return {eligible: false, reason: "PROCESSOR_TRUTH_UNVERIFIED"};
  }
  if (payment.merchantId !== agreement.merchantId) return {eligible: false, reason: "MERCHANT_MISMATCH"};
  if (payment.occurredAt < agreement.effectiveFrom ||
      (agreement.effectiveUntil && payment.occurredAt >= agreement.effectiveUntil)) {
    return {eligible: false, reason: "OUTSIDE_CONTRACTED_INTERVAL"};
  }
  if (agreement.currency !== payment.currency) return {eligible: false, reason: "CURRENCY_MISMATCH"};
  if (payment.status !== "SUCCEEDED" || !Number.isSafeInteger(payment.amountMinor) ||
      payment.amountMinor <= 0) return {eligible: false, reason: "NOT_CONFIRMED_QUALIFYING_PAYMENT"};
  if (collectionMode !== "USAGE_BILLING") return {eligible: false, reason: "NOT_METERED_COLLECTION"};
  if (existingApplicationFee) return {eligible: false, reason: "APPLICATION_FEE_ALREADY_COLLECTED"};
  if (!agreement.billingAuthorized) return {eligible: false, reason: "BILLING_NOT_AUTHORIZED"};
  if (!agreement.allowedProviders?.includes(payment.provider)) return {eligible: false, reason: "PROVIDER_NOT_CONTRACTED"};
  return {
    eligible: true,
    key: entitlementKey({
      merchantId: agreement.merchantId, provider: payment.provider,
      processorAccountId: payment.processorAccountId, transactionId: payment.transactionId,
      component: "SUCCESSFUL_PAYMENT", agreementVersion: agreement.version
    }),
    pricingPolicyId: agreement.pricingPolicyId
  };
}

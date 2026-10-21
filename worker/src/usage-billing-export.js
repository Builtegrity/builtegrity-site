/**
 * Billing export preparation (NO STRIPE API CALLS, NO LIVE COLLECTION).
 * Use a durable database outbox with permanent UNIQUE idempotency keys.
 * Stripe meter-event identifiers may deduplicate only for a bounded window:
 * never rely on provider-side dedupe as the sole lifelong charge guard.
 */
export function prepareUsageInvoiceExport({agreement,entry,alreadyExported=false}) {
  if (!agreement || agreement.status!=="ACTIVE" || !agreement.billingAuthorized ||
      !agreement.billingCustomerRef || !agreement.meterEventName ||
      !agreement.version || !agreement.merchantId) {
    return {ready:false,reason:"AGREEMENT_OR_BILLING_CONFIGURATION_INCOMPLETE"};
  }
  if (!entry || !entry.entryKey || entry.merchantId!==agreement.merchantId ||
      entry.collectionStatus!=="UNBILLED" || !Number.isSafeInteger(entry.amountMicros) ||
      entry.amountMicros<0 || entry.currency!==agreement.currency) {
    return {ready:false,reason:"INVALID_OR_MISMATCHED_ENTITLEMENT"};
  }
  if(alreadyExported)return {ready:false,reason:"ALREADY_EXPORTED"};
  // Do not coerce micros to cents and lose fractional entitlement.
  // Price-specific invoice line aggregation is required before final settlement.
  // In Stripe metered mode, meter 'value' must match the approved meter price
  // configuration; never send micros as counts to an unconfigured price.
  return {
    ready:true,
    outboxKey:JSON.stringify(["usage-export",entry.entryKey,agreement.version]),
    sourceEntitlementKey:entry.entryKey,
    billingCustomerRef:agreement.billingCustomerRef,
    billingMeterName:agreement.meterEventName,
    amountMicros:entry.amountMicros,
    requiresPricingAggregation:true
  };
}

/**
 * Deterministic append-only usage ledger planning.
 * Pure functions: no database writes or payment collection.
 * Storage MUST enforce UNIQUE(entitlement_key) and UNIQUE(adjustment_key)
 * and commit entitlement + event checkpoint atomically.
 */
export function usageLedgerEntry({eligibility,merchantId,provider,processorAccountId,transactionId,currency,amountMicros,occurredAt}) {
  if (!eligibility?.eligible || !eligibility.key) throw new Error("INELIGIBLE_TRANSACTION");
  if (!Number.isSafeInteger(amountMicros) || amountMicros < 0) throw new TypeError("INVALID_FEE_MICROS");
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new TypeError("INVALID_CURRENCY");
  for (const value of [merchantId,provider,processorAccountId,transactionId,occurredAt]) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError("MISSING_LEDGER_IDENTITY");
  }
  return Object.freeze({
    entryKey:eligibility.key,
    merchantId,provider,processorAccountId,transactionId,
    currency,amountMicros,occurredAt,
    pricingPolicyId:eligibility.pricingPolicyId,
    type:"EARNED_USAGE_FEE",
    collectionStatus:"UNBILLED"
  });
}

/** Adjustment entries can only reference original entitlements; never mutate historical entries. */
export function adjustmentEntry({original,adjustmentId,deltaMicros,reason,occurredAt}) {
  if (!original?.entryKey || !original.merchantId || !original.currency) throw new Error("MISSING_ORIGINAL");
  if (typeof adjustmentId !== "string" || !adjustmentId.trim()) throw new Error("MISSING_ADJUSTMENT_ID");
  if (!Number.isSafeInteger(deltaMicros) || deltaMicros >= 0) throw new Error("INVALID_CREDIT");
  if (Math.abs(deltaMicros)>original.amountMicros) throw new Error("CREDIT_EXCEEDS_ORIGINAL");
  if (!["REFUND","DISPUTE","MANUAL_APPROVED_CREDIT"].includes(reason)) throw new Error("INVALID_ADJUSTMENT_REASON");
  if (typeof occurredAt!=="string" || !occurredAt.trim()) throw new Error("MISSING_TIMESTAMP");
  return Object.freeze({
    adjustmentKey:JSON.stringify([original.entryKey,adjustmentId,reason]),
    entitlementKey:original.entryKey,
    merchantId:original.merchantId,
    currency:original.currency,
    deltaMicros,reason,occurredAt
  });
}

/** Invoice reconciliation does not imply cash collection. */
export function summarizeLedger({entitlements,adjustments,collections=[]}) {
  const currencies=new Set([...entitlements,...adjustments,...collections].map(x=>x.currency));
  if(currencies.size>1) throw new Error("MIXED_CURRENCIES");
  const uniq=(rows,key)=>{ const set=new Set();for(const row of rows){if(!row[key]||set.has(row[key]))throw new Error("DUPLICATE_OR_MISSING_LEDGER_KEY");set.add(row[key]);}};
  uniq(entitlements,"entryKey");uniq(adjustments,"adjustmentKey");uniq(collections,"collectionKey");
  const entries=new Map(entitlements.map(x=>[x.entryKey,x]));
  let earned=0,credited=0,collected=0;
  for(const e of entitlements){if(!Number.isSafeInteger(e.amountMicros)||e.amountMicros<0)throw new Error("INVALID_AMOUNT");earned+=e.amountMicros;}
  const creditsByEntry=new Map();
  for(const a of adjustments){
    const original=entries.get(a.entitlementKey);
    if(!original||a.merchantId!==original.merchantId||a.currency!==original.currency||!Number.isSafeInteger(a.deltaMicros)||a.deltaMicros>=0)throw new Error("INVALID_ADJUSTMENT");
    creditsByEntry.set(a.entitlementKey,(creditsByEntry.get(a.entitlementKey)||0)+(-a.deltaMicros));
    if(creditsByEntry.get(a.entitlementKey)>original.amountMicros)throw new Error("OVER_CREDITED");
    credited+=-a.deltaMicros;
  }
  for(const c of collections){if(!Number.isSafeInteger(c.collectedMicros)||c.collectedMicros<0)throw new Error("INVALID_COLLECTION");collected+=c.collectedMicros;}
  if (![earned,credited,collected].every(Number.isSafeInteger))throw new Error("LEDGER_OVERFLOW");
  return Object.freeze({currency:[...currencies][0]||null,earnedMicros:earned,creditedMicros:credited,netEarnedMicros:earned-credited,collectedMicros:collected});
}

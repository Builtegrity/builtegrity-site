/**
 * Merchant-branded transaction delivery policy.
 *
 * Intended entrypoints:
 *  - merchant preference update: validateMerchantDeliveryPreferences
 *  - transaction completion: buildCustomerDeliveryDecision
 *  - email rendering: renderTransactionEmail
 *  - PDF generation: resolveDocumentBranding / getDocumentThemeCss
 *
 * IMPORTANT: Callers must obtain transaction details server-side, verify tenant
 * ownership and purpose, and enforce existing authenticated PDF authorization.
 * This module does not send mail, grant PDF access, or process raw HTML.
 */
const THEMES = Object.freeze({
  default: { accent: "#171717", ink: "#171717", background: "#ffffff", surface: "#f5f5f5" },
  emerald: { accent: "#147d54", ink: "#16352b", background: "#ffffff", surface: "#eef7f1" },
  ocean: { accent: "#1959a6", ink: "#152e48", background: "#ffffff", surface: "#eff6fd" },
  violet: { accent: "#7045a3", ink: "#332345", background: "#ffffff", surface: "#f6f1fa" },
  slate: { accent: "#475569", ink: "#1e293b", background: "#ffffff", surface: "#f1f5f9" },
  neon: { accent: "#6d9900", ink: "#111111", background: "#ffffff", surface: "#f2f8e4" }
});
export const MERCHANT_TRANSACTION_THEMES = Object.keys(THEMES);
const safe = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[c]);
const opt = value => value === true;

/** Separate opt-ins; preserve existing behavior when settings are absent. */
export function validateMerchantDeliveryPreferences(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid merchant preferences");
  const theme = String(input.theme ?? "default");
  if (!Object.hasOwn(THEMES, theme)) throw new RangeError("Unsupported merchant theme");
  for (const key of ["themePdfEnabled", "customerTransactionEmailEnabled", "themeEmailEnabled"]) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") throw new TypeError(key + " must be boolean");
  }
  return {
    theme,
    themePdfEnabled: opt(input.themePdfEnabled),
    customerTransactionEmailEnabled: opt(input.customerTransactionEmailEnabled),
    themeEmailEnabled: opt(input.themeEmailEnabled)
  };
}

/** Static whitelist; no merchant-authored CSS or arbitrary remote imagery. */
export function resolveDocumentBranding(preferences, merchant = {}) {
  const p = validateMerchantDeliveryPreferences(preferences);
  const chosen = p.themePdfEnabled ? p.theme : "default";
  return {
    theme: chosen,
    colors: { ...THEMES[chosen] },
    merchantName: String(merchant.displayName || merchant.name || "Merchant").slice(0, 120),
    attribution: "Transaction details provided through Builtegrity"
  };
}

export function getDocumentThemeCss(preferences, merchant) {
  const { colors } = resolveDocumentBranding(preferences, merchant);
  return [
    ":root { --receipt-accent: " + colors.accent + "; --receipt-ink: " + colors.ink +
      "; --receipt-surface: " + colors.surface + "; --receipt-bg: " + colors.background + "; }",
    ".receipt { color:var(--receipt-ink);background:var(--receipt-bg); }",
    ".receipt__header { border-top:4px solid var(--receipt-accent); }",
    ".receipt__title { color:var(--receipt-accent); }",
    ".receipt__summary { background:var(--receipt-surface); }"
  ].join("\n");
}

/**
 * Delivery only for completed, eligible transactions with an existing customer
 * email and affirmative merchant opt-in. Caller must enforce legal delivery
 * basis, recipient verification, unsubscribe rules where applicable, and idempotency.
 */
export function buildCustomerDeliveryDecision({ preferences, transaction, customer } = {}) {
  const p = validateMerchantDeliveryPreferences(preferences);
  const email = String(customer?.email ?? "").trim();
  const status = String(transaction?.status ?? "").toLowerCase();
  const eligible = ["succeeded", "paid", "refunded", "partially_refunded"].includes(status);
  const validEmail = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
  return {
    send: p.customerTransactionEmailEnabled && eligible && validEmail,
    reason: !p.customerTransactionEmailEnabled ? "merchant_opted_out" : !eligible ? "transaction_not_eligible" : !validEmail ? "missing_recipient" : "eligible",
    theme: p.themeEmailEnabled ? p.theme : "default",
    recipient: validEmail ? email : null,
    idempotencyKey: transaction?.id && status ? "customer-transaction:" + transaction.id + ":" + status : null
  };
}

/** No PDF/download links, customer passwords, or merchant dashboard secrets. */
export function renderTransactionEmail({ preferences, merchant = {}, transaction = {}, customer = {} } = {}) {
  const decision = buildCustomerDeliveryDecision({ preferences, merchant, transaction, customer });
  if (!decision.send || !decision.idempotencyKey) return null;
  const colors = THEMES[decision.theme];
  const merchantName = String(merchant.displayName || merchant.name || "Your merchant").slice(0,120);
  const identifier = String(transaction.publicReference || transaction.reference || "").slice(0,80);
  const status = String(transaction.status || "").replaceAll("_", " ");
  const amount = String(transaction.formattedAmount || "").slice(0,60);
  const date = String(transaction.formattedDate || "").slice(0,60);
  const refund = /refund/i.test(status);
  const subject = merchantName + (refund ? " — transaction refund update" : " — transaction confirmation");
  return {
    to: decision.recipient,
    subject,
    idempotencyKey: decision.idempotencyKey,
    html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f8f9fb;font-family:Arial,sans-serif;color:${colors.ink}">
      <main style="max-width:560px;margin:auto;padding:28px;background:${colors.background};border-top:5px solid ${colors.accent}">
        <h1 style="font-size:22px;color:${colors.accent}">${safe(merchantName)}</h1>
        <p>${refund ? "Your transaction has a refund update." : "Your transaction was completed."}</p>
        <div style="padding:16px;background:${colors.surface};line-height:1.8">
          ${identifier ? `<div>Reference: ${safe(identifier)}</div>` : ""}
          <div>Status: ${safe(status)}</div>
          ${amount ? `<div>Amount: ${safe(amount)}</div>` : ""}
          ${date ? `<div>Date: ${safe(date)}</div>` : ""}
        </div>
        <p style="font-size:12px">Transaction details provided through Builtegrity on behalf of ${safe(merchantName)}.</p>
        <p style="font-size:12px">For transaction questions, contact ${safe(merchantName)}.</p>
      </main></body></html>`,
    text: [merchantName, refund ? "Transaction refund update" : "Transaction confirmation",
      identifier && "Reference: " + identifier, "Status: " + status,
      amount && "Amount: " + amount, date && "Date: " + date,
      "Transaction details provided through Builtegrity on behalf of " + merchantName]
      .filter(Boolean).join("\n")
  };
}

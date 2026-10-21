# Builtegrity non-disruptive merchant onboarding — implementation contract

**Status:** Draft engineering acceptance contract, not live onboarding or authorization to collect money.
**Rule:** Merchant's existing checkout, POS, invoices, payouts and settlement ownership do not change.

## Sequence
1. Present provider selection and capability matrix. Stripe observation connector is first; Square is a separately gated adapter. Never imply that a Stripe Connect platform connection can observe arbitrary accounts already controlled by another platform.
2. Explain requested scopes before authorization: payments; refunds/disputes; payouts/balance transactions where accessible. Clearly show which capabilities cannot be provided under the account's access mode.
3. Complete processor-supported OAuth/authorization with anti-CSRF state, merchant-scoped identity, expiration, credential rotation and secure token storage outside repository/database plaintext. Verify processor account ID server-side. Deduplicate or reject cross-merchant account ownership conflicts; require explicit authorized transfer procedure.
4. Independently create Builtegrity merchant identity and optional merchant dashboard. Preserve merchant's ability to use read-only emailed transaction status links without disclosing downloadable sensitive PDFs until login.
5. Show the **actual priced billing agreement** (owner-locked version, eligibility rule, effective start, refund/adjustment policy, invoice cadence, payment failures, cancellation, taxes if applicable). Require affirmative merchant acceptance. Do not silently begin usage fees simply because OAuth completed.
6. Collect a reusable *merchant billing payment method* through a hosted processor payment-setup flow. Use processor token/ID only. Securely link to the Builtegrity billing account, not the merchant's own customer charge ledger.
7. Mark ACTIVE only when processor scopes/identity are verified, pricing is owner-locked, consent evidence persisted, billing authorization and collection method confirmed, and mandatory legal/tax gates pass. Otherwise stay PENDING/RESTRICTED; observability may exist without revenue accrual only under explicitly permitted contract terms.
8. Baseline reconcile provider data from authorized effective start date; do not charge retroactively for imported/backfilled transactions that predate accepted terms.
9. Show transaction ingestion and billing-health status on merchant dashboard. Suspended/revoked connection prevents statements implying full coverage; resume with scoped backfill and no duplicate entitlements.
10. On cancel: stop future eligible accrual according to effective termination terms; settle already owed authorized balances, revoke tokens when appropriate, retain records under lawful retention policy.

## Explicit failure cases
- OAuth callback uses mismatched state: reject, no merchant connection.
- Connected account differs from expected merchant: quarantine for review, no billing.
- Missing payout scopes: monitor payment only, payout status UNKNOWN, no false `ACCOUNTED` assertion.
- Processor webhook delayed: backfill via API when authorized; dedupe provider IDs.
- Billing collection fails: invoice remains outstanding and dunning policy begins. Integrity recording remains truthful.
- Successful processor event before agreement effective date: no usage entitlement.
- Transaction contains collected Stripe application fee: do not generate separate metered fee.
- No billing card authorization: cannot activate automatic charging.
- Refund/dispute: write an adjustment under the signed versioned refund policy, not an uncontracted waiver.
- Account links to multiple merchants: require tenant ownership controls and prohibit accidental cross-tenant data visibility.

## Acceptance
Prove that an externally initiated test Stripe payment creates exactly one observed transaction and one separately authorized usage entitlement; invoice processing reconciles to the correct entitlement once; merchant continues to accept customer payments without changing their existing checkout.

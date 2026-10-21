# Processor-neutral observation and usage billing — additive implementation contract

Status: **DESIGN / NOT LIVE**. This document proposes a new revenue path; it does not replace the canonical `ops/system-contract.json` or authorize live collection. No checkout, classification, price, refund, legal or provider authorization is changed by this document.

## Non-negotiable product boundary
1. Existing merchant checkout and money flow are unchanged by a monitoring connection. Builtegrity is not merchant of record or payment processor.
2. Retain optional Builtegrity-hosted checkout and its existing PROTECTED fee path, evidence gates and application-fee ledger.
3. OBSERVED remains an accurate *source/record classification*, not a statement about whether subscription/usage fees are due. Never relabel OBSERVED transactions as PROTECTED merely to bill for them.
4. New usage billing is a **separate merchant-contractual entitlement and collection mechanism** from processor application fees. Treat it as a proposed change requiring pricing owner lock and legal/processor review before live activation.
5. Supported payment processors, scopes, data visibility, connected-platform conflicts and payout/bank visibility must be disclosed per adapter; do not claim universal completeness.

## Data model extension (proposed; additive migrations only)
- `merchant_processor_connections`: merchant_id, provider, provider_account_id, connection_mode, scope snapshot, status, timestamps, cursor/checkpoint, health status, unique(provider,provider_account_id,merchant_id).
- `processor_events_inbox`: provider, provider_account_id, event_id, event_type, received_at, verified_signature metadata, payload location/digest, handling status; UNIQUE(provider,provider_account_id,event_id). Authenticate signatures and resolve tenant before writing.
- `billing_agreements`: merchant_id, versioned signed offer/pricing policy, qualifying criteria, effective interval, fee currency, billing cadence, payment authorization reference, provider billing customer ID, status, consent evidence, start/end, no retroactive changes.
- `usage_entitlements`: unique merchant_id + provider + processor account + transaction ID + fee component + agreement version + eligible transition; origin transaction, source class (OBSERVED/PROTECTED/IMPORTED), processor truth, amount in micros, currency, status, eligibility evidence, timestamps. Do not bill an application-fee-collected entitlement a second time.
- `usage_adjustments`: immutable credit/debit entries for refunded, reversed, disputed or reclassified transactions, linked to original entitlement; exact agreement policy governs.
- `usage_invoice_lines`: many-to-one entitlement/adjustment to external metered usage or invoice line; unique idempotency keys, period identifiers, provider response IDs and statuses.
- `billing_collections`: customer payment status, actual settled/failed/refunded amounts, provider IDs, retry/dunning events and reconciliation status; accounting of **earned**, **invoiced**, **collected**, **reversed**, **outstanding** must remain separate.
- Every new table includes tenant-scoped authorization controls, suitable indexes, timestamps and an audit trail. Never put payment method credentials or sensitive customer details in D1.

## Ingestion and reconciliation
1. Onboard an existing merchant through an approved processor authorization flow for observation. Keep source checkout unmodified. Request only required scopes. Confirm current account identity, connection restrictions and access to payments, refunds, disputes, balances/payouts separately.
2. Verify webhook authenticity; store deduplicated events durably before acknowledgment. Persist provider identifiers and all processor-known timestamps. Acknowledge retries idempotently; process eventual, duplicate and out-of-order events.
3. Backfill historical activity only within authorized scope and agreed start date; reconcile webhook coverage periodically against provider APIs. Reconnect/revoke events pause unsupported assertions and new accrual when data is stale.
4. Preserve the original event stream and transaction records. Normalize provider payment, charge, refund, dispute, balance transaction and payout objects with explicit mappings, never infer bank-posted from payout sent.
5. Independently run eligibility rules on successful processor-confirmed qualifying transactions under *current effective agreement*. Create exactly one entitlement per eligibility key. A failed invoice does not remove the transaction integrity record.
6. Use an independent Stripe Billing account/customer relationship for merchant metered invoicing. Never assume observation-only connected accounts authorize application-fee deduction. Use provider-native application fees only where supported and separately contracted.
7. Reconcile invoiced usage back to local entries and Stripe Billing invoice/payment events; monitor unreported usage, duplicate submission, failures, credits, disputes, stale connection, and currency conflicts.
8. Disable invoice generation for any tenant without versioned price lock, affirmative merchant billing authorization, valid collection method, completed integration tests and applicable legal/tax review.

## Commercial rules to explicitly approve before activation
- Pricing is currently an **unlocked TEST_CANDIDATE** in the canonical contract; no flat 25-cent default is authorized.
- Decide whether PROTECTED checkout and OBSERVED transactions are both billable, and the mutually exclusive application-fee versus usage-billing allocation.
- Define qualifying event (payment succeeded vs net settled), capture time, refunds (full/partial), chargebacks, minimum/maximum fee, rounding, billable start, suspension, cancellation, dispute period, currency, invoice cadence and sales-tax treatment.
- No retroactive billing beyond explicitly accepted effective terms; no hidden deductions from merchant balances.

## Live gates and required tests
- Verify zero checkout regression; optional hosted checkout still works and retains its evidence gates.
- Synthetic tests: duplicate event, reordered payment/refund, webhook replay with bad signature, cross-tenant forged IDs, import vs observed, backfill replay, price policy rollover, application-fee double-charge exclusion, partial refund, dispute reversal, failed payment, reconnect, missing scopes, payout unavailable and invoice dispute.
- Test-mode merchant A uses hosted checkout; merchant B uses native Stripe Checkout or POS/invoice outside Builtegrity; merchant C uses Square once adapter exists. Trace each transaction to its integrity record and **separate** revenue ledger.
- Real production launch remains BLOCKED by `npm run system:gate:live`, `npm run owner:gate:live`, migrations, live credentials, compliance clearance and operator signoff.

# Partner-first distribution and collection architecture (proposal)

**Status:** DESIGN ONLY — not a production release, not an approved commercial or legal policy.
**Date:** 2026-11-14
**Intended relationship:** This is an additive architecture proposal. Canonical authority remains in ops/system-contract.json, ops/document-register.json, and docs/MASTER.md. Do not hand-edit the generated master. PR #69 is the existing unmerged observation/usage-billing foundation; reconcile with it before implementing. PR #76 is a separate optional merchant Impact proposal.

## Product decision to validate

Builtegrity is a processor-neutral transaction-integrity software provider distributed primarily through ISOs, payment resellers, gateways, and compatible processors, with a direct-to-merchant Stripe integration as a secondary channel. Merchant checkout and processor normally stay unchanged. A processor partnership may add a supported collection rail, but must not imply Builtegrity can debit a merchant's existing funds merely by observing transactions.

Outcomes:
1. Partner can introduce and track eligible merchants without handling merchant credentials.
2. Merchant expressly opts in to observation and separately accepts priced billing authorization.
3. Provider-certified and signature-verified transaction activity creates normalized merchant-scoped records.
4. Successful, qualifying, verified record creation creates at most one contractual usage-fee entitlement.
5. A selected, provider-supported collection rail collects the due fee after it is legitimately earned.
6. Partner commission is calculated on actually collected Builtegrity revenue, according to a versioned partner agreement.
7. Merchant receives an itemized monthly summary even if fees were already collected throughout the month.

The owner has proposed percentage-based per-record economics, but this RFC intentionally **does not lock the numerical price, impact contribution, partner split, or refund terms**. These must be approved, versioned, disclosed and tested before enabling collection.

## Distribution lanes

| Lane | Merchant's checkout | Data connection | Default fee rail | Distribution |
| --- | --- | --- | --- | --- |
| A: ISO/reseller referral | Unchanged | Merchant-authorized Stripe/other supported connector | Separate authorized Builtegrity billing | Partner referral/deep link |
| B: processor/API partner | Usually unchanged within compatible processor | Authorized partner API + merchant scope/contract | Provider-native settlement **if expressly supported**; otherwise separate billing | Partner-managed opt-in |
| C: direct Stripe merchant | Unchanged | Merchant-authorized Stripe observation | Separate authorized Builtegrity billing | Direct/self-service |
| D: optional Builtegrity-hosted checkout | Changes for transactions merchant elects to route | Existing Stripe Connect architecture | Existing authorized application-fee rail | Optional, not necessary for lanes A–C |

For B, receiving one partner-level credential is not blanket consent to use all merchant data. Contract, applicable permissions, privacy/processor restrictions and merchant enrollment determine scope. Account-level Connect limitations must be surfaced; do not promise compatibility with a merchant under another platform.

## Modules and canonical boundaries

### 1. Partner directory and tenancy

Proposed additive tables (migration names/numbers determined only at implementation):
- partner_organizations: partner category, brand profile, status, owner org reference, supported processor families.
- partner_memberships: authenticated user -> partner org -> role, with explicit grants and revocation.
- partner_program_versions: accepted proposal version, coverage, territory/channel, distribution mode, commission formula and effective dates; private signed contracts stored outside public repo.
- partner_merchant_enrollments: partner, merchant, invitation token digest, accepted enrollment mode, status, acceptance timestamps, effective/ended interval; immutable attribution history.
- partner_commission_ledger: each eligible collected-fee allocation with source collection ID and versioned agreement; unique source+partner+component; append-only adjustments, no retroactive rewriting.
- partner_commission_settlements: authorized processor payouts or separate payables and reconciled status.

A merchant may have integrations with multiple processors, but one fee entitlement cannot be attributed/collected twice. Partner access is limited to the merchant enrollments expressly authorized; a partner dashboard shows aggregate performance and its own commissions, **not** other merchants' customer-level records by default. Clerk authenticates, Builtegrity authorization in D1 scopes access. Do not use partner affiliation as a bypass for merchant data.

### 2. Processor observation adapters

Contract per adapter: capabilities(), authorize(), revoke(), fetchEvents(cursor), fetchTransaction(id), fetchAdjustments(), fetchPayouts() if supported, verifyWebhook(rawBody, headers), normalizeEvent(). An integration capability record explicitly states which facts are accessible (payment confirmation, refunds, disputes, balances, automatic payouts, bank receipt unknown) and states NOT_SUPPORTED where absent.

All provider event receipts are signature-verified, durable, merchant-resolved and idempotent before acknowledgement. Provider API backfill reconciles missed and delayed events without fabricating status. Source classification remains OBSERVED for independently observed activity; PROTECTED remains reserved for the existing validated checkout classification. Never upgrade OBSERVED to PROTECTED merely for billing.

Initial adapter: Stripe observation. Secondary adapter selection requires a signed/design-partner arrangement and sandbox. NMI reporting and Payabli API/split funding are candidates to evaluate; their docs do not prove permission to apply this product's fee to arbitrary legacy payments.

### 3. Record, entitlement and collection separation

A normalized payment may be known before a record meets its verification criteria. Model four independent lifecycles:
- payment fact: provider-observed, with source state/currency/amount;
- integrity record: PENDING / VERIFIED / EXCEPTION, with evidence and provenance;
- usage entitlement: INELIGIBLE / EARNED / ADJUSTED / VOIDED, with a signed pricing snapshot;
- collection: NOT_SUBMITTED / PENDING / COLLECTED / FAILED / REFUNDED / RECONCILED.

A fee entitlement is created only after verified eligibility and the applicable effective merchant agreement. The billing trigger must be a precisely defined verified event; it is not automatically "payment authorized", "browser redirected", "payout initiated", or "bank credited". Record and payout coverage are distinct, and report unknown states faithfully.

Unique canonical idempotency key: merchant + provider + provider account + source transaction + qualifying fee component + contract version (with a separate rule preventing duplicate economic entitlement on a contract rollover). Guard provider retries, imports/backfills, duplicate gateway event IDs, and race conditions at the D1 uniqueness layer. Original economic facts are immutable; refunds/disputes/corrections append linked adjustments. A payment already assessed a legacy Builtegrity application fee must not also be charged an observation usage fee for the same component.

### 4. Collection rail abstraction

Do **not** couple observation adapter with collections. Proposed interface:
- eligibility(merchant, connection, acceptedBillingAgreement, providerCapabilities)
- createInstruction(entitlementOrBatch, idempotencyKey)
- inspectCollection(providerReference)
- refundOrAdjust(collection, approvedAdjustment)
- reconcile(providerSettlementEvidence)

Rank rail preferences:
1. Provider-native fee allocation or post-verification balance deduction, **only with provider's written confirmation, merchant authorization, and an actual supported funds-flow model**.
2. Authorized off-session Stripe Billing or payment-method charging; create a separate merchant/customer billing relationship. Can collect each earned fee if economics work.
3. Automatic daily/threshold-based aggregation to reduce per-payment fees and retry noise, with individual transaction ledger attribution and a monthly summary. Merchant may have outstanding/failed billing even with auto-collection configured.
4. Manual invoicing is a controlled recovery path, not the intended merchant UX.

Pre-payment split funding requires instructions at original payment creation on some platforms. It cannot be retrospectively injected into unrelated legacy checkout transactions. It also cannot treat a not-yet-verified record as definitively earned without a separately authorized provisional hold/release mechanism. Never assume instant bank availability after a fee is recorded/allocated.

Separate earned, submitted, collected, available and actually paid-out monetary states. The reconciliation engine must not call a fee paid until provider evidence proves it. Fail closed for missing merchant consent or unavailable partner-provider permissions.

### 5. Partner commissions

Commissions are based on net **collected** Builtegrity software fees (subject to the agreement's explicitly defined returns/chargebacks/taxes), not gross merchant sales, merely observed activity, billed receivables or optional environmental contributions. Version the rate and eligibility before a merchant starts earning. Store immutable provenance, agreement version and adjustment links. Partner payout follows a defined settlement and reserve schedule; a refund triggers a linked commission reversal/offset as appropriate.

Do not promise processors rights to redistribute funds, share merchant data, or sign for Builtegrity without written agreements. Offer non-exclusive, small-scope partnerships first. Do not store confidential partner contracts or bank details in public GitHub.

### 6. Merchant onboarding and partner onboarding

Partner: interested -> reviewed -> sandbox approved -> technical capabilities verified -> limited pilot -> optional commercial distribution. Every advancement requires evidence; a landing page or partner logo is not a verified integration.

Merchant: partner referral -> merchant eligibility check -> scope disclosures -> explicit data authorization -> separate accepted pricing and billing agreement -> verified billing method/collection authority -> test and health check -> ACTIVE. Reject cross-tenant association, mismatch of processor account ID, missing billing authority and duplicate partner attribution. Clear disconnect/revoke and termination paths.

A partner-sourced merchant may use existing Stripe checkout through its existing processor; a processor cannot assume Builtegrity access to a whole installed base without provider permissions and merchant authorizations appropriate to the arrangement.

## Merchant and partner interfaces (prioritized)

**Merchant:** connection health; coverage limitations; transaction records; exception list; processor payout evidence and UNKNOWN states; amount/contract/version; per-transaction fee; adjustments; collected versus outstanding; optional contribution ledger; downloadable monthly statement; cancel/disconnect.

**Partner:** co-branded invitation link; onboarding funnel (invited, consented, connected, active); aggregate participating merchant counts; integration health; verified records, resolution rate, collections; commission ledger and remittances. No customer PII by default.

**Internal operator:** partner enrollment and scope approvals, release blocks, failed collection queue, merchant/partner dispute and correction trace, audit trail, provider key rotation and disaster recovery.

## Pilot and rollout (do in order)

**Gate 0 — Freeze the business contract and compatibility table.**
Document the merchant value hypothesis, qualifying-record definition, observation vs protection distinction, selected initial fee schedule, contribution behavior, partner commission proposal, adjustments/refunds, and processor access limitations. Owner lock + legal review are separate from code merge. Obtain one credible partner's desired use case before committing to an integration provider.

**Gate 1 — Direct Stripe observation demonstrator.**
Reconcile existing draft PR #69. Build a merchant-authorized Stripe connection capable of observing an **externally initiated** test payment, fetching relevant events, producing one verified record and a traceable entitlement *without moving money*. Confirm the existing hosted-checkout path remains unaffected.

**Gate 2 — First partner portal, minimal.**
Add partner organizations, merchant attribution, one co-branded invite link and a tenant-safe summary. Avoid full reseller white-label complexity at this stage.

**Gate 3 — First authorized collection.**
Obtain merchant billing authorization and integrate a supported separate Stripe billing rail; exercise per-record and batched collection in test mode, refunds, failed payments and reconciliation. Preserve the option for provider-native collections, but do not gate the pilot on provider granting them.

**Gate 4 — Partner pilot, 3–5 willing merchants.**
Start no-fee observation test, demonstrate measurable record coverage and exception value; only activate live 3%-style priced collection after explicit merchant consent, processor approval when applicable, commercial/legal approvals and existing TX-LIVE release gates. Track record coverage, exception false positives, statement accuracy, support minutes, willingness-to-pay and merchant churn signals.

**Gate 5 — Native settlement integration (only after partner commitment).**
Use an explicit provider capability contract and sandbox, then implement the provider-native rail where lawful/supported. Add provider reconciliation and commission settlement. Do not build speculative processor-specific integrations for uncommitted counterparties.

**Gate 6 — Distribution scale.**
Partner CRM integration, automated opt-in campaign, branded merchant onboarding, bulk reporting, automated settlement and partner success metrics. Separate release for optional Impact contribution funding and verified receipts.

## End-to-end acceptance tests

1. Merchant A enrolled by Partner P initiates payment **outside** Builtegrity. Exactly one OBSERVED record, verified entitlement and invoice instruction are created under the correct consent/version. Merchant A's checkout is unchanged.
2. Replay 20 webhooks, backfill the same payment and change contract version: no duplicate fee or partner commission.
3. Merchant B's payment, customer data, balance and payout never appear in Partner P's dashboard without explicit enrollment/authorization.
4. Revoked access, insufficient provider scopes, missing billing consent or stale verification stop further fee accrual and truthful completeness claims.
5. Payment verified but fee collection fails: merchant record persists; collection remains outstanding; no partner commission is marked paid.
6. Refund/chargeback creates an append-only adjustment; retry and refund ordering do not create negative duplicates.
7. A payment already charged a legacy protected application fee never receives another usage-fee charge.
8. Provider does not support payout visibility: the statement marks payout state UNKNOWN, not complete/bank-deposited.
9. Partner commission is earned under the agreed rule on collected software revenue, and reversals reconcile to original collections.
10. Disconnected merchant receives a lawful final statement; processing beyond the effective cancellation date does not accrue uncontracted fees.
11. Optional Impact contribution is opt-in and separately auditable; no charitable funding claim before verified provider receipt.
12. The full production release still requires system:gate:live, owner:gate:live, runtime/D1 readiness, security/legal/tax/financial evidence, credentials, tenant penetration tests and explicit release approval.

## Decisions to resolve before implementation

- Commercial validation: Are merchants willing to pay percentage-of-GMV for a service they perceive as reconciliation/documentation, and does an ISO risk losing merchants at that rate? Pilot before enshrining economics.
- Record qualification: verified payment event vs payout-reconciled record; establish whether fast fees and payout completeness require separate record stages.
- Collection economics: per-record rail fee and failed-collection risk vs transparent daily batch and monthly paid statement.
- Partner structure: simple referral first or negotiated embedded white-label; who owns support, merchant relationship, data, and commercial disclosures.
- First processor-native partner: verify actual API permissions and right to charge; do not infer from a marketing page about split funding.

## References and boundaries

- Existing code: README.md, worker/src, migrations, ops/system-contract.json, docs/production-readiness-gate.md.
- Pending foundation: PR #69 (processor-neutral usage-billing), do not duplicate or silently merge.
- Pending optional feature: PR #76 (Impact); does not authorize donation collection.
- NMI docs: https://docs.nmi.com/reference/getting-started (gateway reporting/merchant management; not automatic permission to debit legacy transactions).
- Payabli docs: https://docs.payabli.com/guides/pay-in-developer-routing-split-funds (configured split funding on selected API-initiated payment requests).
- Stripe docs: https://docs.stripe.com/connect and https://docs.stripe.com/billing (provider eligibility and collection arrangements must be validated specifically).

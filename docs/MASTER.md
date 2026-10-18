# Builtegrity Master Operating Record

> **Generated file. Do not hand-edit.** Run `npm run docs:fix` after changing canonical documentation inputs. CI verifies this file is current.

**System contract:** BUILTEGRITY-SYSTEM-V1 schema 1.4
**Release target:** TX-LIVE-0001
**Current phase:** PRE-PRODUCTION / LIVE BLOCKED until every required gate is verified.

This is the owner-facing map of Builtegrity. It summarizes canonical machine-readable state and points to the authoritative document for detail. It is not a substitute for `ops/system-contract.json`, D1 transaction evidence, processor truth, signed contracts, legal advice, or the private Owner Emergency Vault.

## 1. Core product contract

- **Processor:** STRIPE; Builtegrity is not the processor and does not custody merchant/customer funds.
- **Merchant role:** Merchant remains seller / merchant of record.
- **V1 charge model:** STRIPE_DIRECT_CHARGE_ON_CONNECTED_ACCOUNT.
- **V1 scope:** US_MERCHANT, US_CUSTOMER_TRANSACTION, USD, ONE_TIME_PAYMENT, AUTOMATIC_PAYOUTS.
- **Hierarchy:** PARTNER → MERCHANT → CUSTOMER → PURCHASE → TRANSACTION → TRANSACTION_DATA.
- **Customers:** MERCHANT_SCOPED. Direct merchants use PARTNER-0001.
- **Working promise:** Every payment accounted for. “Protected” is a Builtegrity record/revenue classification, not insurance or a guarantee of payment, dispute, legal, or bank outcome.

## 2. Transaction truth

- **Lifecycle:** CREATED → CONSENTED → PAYMENT_PENDING → PAID → PAYOUT_PENDING → COMPLETE.
- **Integrity:** INCOMPLETE | ACCOUNTED | NEEDS_ATTENTION.
- **Record/revenue class:** PENDING_PROTECTED | PROTECTED | OBSERVED | IMPORTED | FEE_EXCEPTION.
- **Invariant:** ACCOUNTED is an integrity/completeness state. PROTECTED is a record/revenue classification. They are different axes and must never be treated as synonyms.
- **Revenue class:** Only PROTECTED creates protected transaction-fee entitlement/revenue.
- **Carry:** A transaction's exact fee entitlement is attributed in micros only after the transaction becomes PROTECTED. Only whole cents are placed on a Stripe application fee. A residual smaller than one cent from a PROTECTED transaction accrues to the merchant carry ledger and may be reserved before a later checkout. Reserved prior carry is SETTLED only when that later payment itself becomes PROTECTED; a fee-exception reservation remains releasable. Later carry settlement is cash collection of prior fee entitlement, not new fee entitlement for the later transaction.
- **Protection rule:** PROTECTED requires the Builtegrity-controlled route, required customer jurisdiction attestation and pre-checkout legal-gate evidence, successful payment history, and processor-confirmed gross application fee exactly matching the locked whole-cent current-transaction fee plus any valid reserved prior carry collected on that payment.
- **Processor truth:** Real processor payment/fee facts must still be recorded even if a legal or protection prerequisite is missing. Missing pre-checkout legal evidence blocks PROTECTED promotion and routes the record to review; it must not cause truthful Stripe webhook data to be rejected or discarded.

## 3. Commercial model — implemented versus approved

- **Pricing implementation:** BG_STANDARD_V1 — TEST_CANDIDATE.
- **Pricing owner lock:** **PENDING_OWNER_LOCK**.
- **Pricing candidate:** 0.1% plus amount-band base fee; no upper Builtegrity fee cap.
- **Platform Fee/refund policy:** FEE-REFUND-POLICY-V1 — TEST_CANDIDATE.
- **Refund economic owner lock:** **PENDING_OWNER_LOCK**.
- **Refund legal status:** **PENDING_COUNSEL**.
- **Candidate default:** RETAIN_IF_EARNED; applicable legal/processor rules override the candidate and unknown/expired law fails closed.

## 4. Operating model

- Normal transactions should require no owner touch: checkout, pricing, processor-event ingestion, protection classification, payout reconciliation, statements, monitoring and routine retries are machine paths.
- Exceptions follow: detect → classify → self-repair/playbook → route to responsible party → verify authoritative state → close only when fixed.
- Human/vendor completion claims are not sufficient when the underlying system can be checked directly.
- Legal judgment, material pricing/governance changes, major security policy, vendor approval, non-preauthorized write-offs and true corporate-authority decisions remain outside autonomous outsourcing.
- The mature owner transaction-touch target is effectively zero; transaction volume should not scale owner workload.

## 5. Provider / outsourced-work semantics

Provider lifecycle: `CANDIDATE → QUOTED → CONTRACTED → VERIFIED → AUTOMATION_ENABLED`.

- **Counsel:** actual retained fintech/payments/SaaS attorney/law firm; AI is never counsel. Counsel verifies legal classification, deadlines and legal clearance.
- **Registered agent:** formal-service receipt + rapid forwarding into legal intake; not legal advice.
- **Cyber / Tech E&O insurer:** defined risk transfer and claims-response resources with known notice rules/exclusions.
- **Technical/operations provider:** bounded/capped work orders after automation fails; least privilege; machine acceptance test before closure.
- **Managed support:** self-service/playbook first; human support only for eligible unresolved work after volume justifies it.
- **Compliance/security platform:** evidence collection/control monitoring; never a substitute for counsel/auditor judgment.

See `docs/provider-procurement-standard.md` before requesting quotes or enabling any provider automation.

## 6. LIVE blocker dashboard

- **Source-control governance:** NOT_VERIFIED — branch protection/required CI must be independently verified before LIVE.
- **Deployment ownership:** PRELAUNCH_GITHUB_PAGES_CONFLICT — CLOUDFLARE_WORKER_STATIC_ASSETS must become the sole authoritative live runtime for builtegrity.com.
- **Required owner/provider systems verified:** 0/10.

| Required system | Status | Verification still needed |
| --- | --- | --- |
| Domain registrar / root domain authority | **UNVERIFIED** | Prove owner login, MFA recovery and domain-transfer authority without ChatGPT |
| GitHub source control | **PARTIALLY_VERIFIED** | Connected operator can push, but repository/organization admin recovery and off-provider clone still require proof |
| Cloudflare runtime / DNS / D1 / R2 / Turnstile | **NOT_ACTIVE** | Create production account resources, prove owner recovery, D1 restore, R2 retrieval/hash verification, deployment and rollback |
| Stripe platform / Connect processor adapter | **NOT_ACTIVE** | Prove owner platform recovery, test/live separation, key rotation, webhook control and emergency payment-route pause |
| Clerk identity provider | **NOT_ACTIVE** | Create application and prove owner recovery, identity migration path and controlled provider replacement |
| Resend outbound/inbound email adapter | **PARTIALLY_VERIFIED** | Account/domain exists but production DNS verification, dedicated API keys, legal receiving subdomain/webhook and owner-recovery test remain incomplete |
| Standing counsel / registered agent / legal-response program | **NOT_ACTIVE** | Execute active engagement, confirm privileged standing-counsel intake, test registered-agent forwarding, test signed counsel callback, and complete a legal incident drill without requiring owner message relay |
| Google Workspace business communications | **PARTIALLY_VERIFIED** | Monitored Builtegrity mailbox is reachable; super-admin recovery and export path still require proof |
| Business banking / accounting authority | **UNVERIFIED** | Prove direct owner recovery and identify the accounts used for live platform funds and accounting |
| Owner private emergency vault | **UNVERIFIED** | Create and test the private vault; never store its secret values in this repository |

**Release rule:** `TX-LIVE-0001` remains blocked until the whole-system live gate, production runtime/D1 readiness, applicable legal/commercial approvals, owner/provider recovery controls and test-mode end-to-end lifecycle all pass together. No green subsystem overrides a red/unknown blocking subsystem.

## 7. Canonical documentation map

### Accounting Tax

| Document | Authority | Required | Purpose |
| --- | --- | ---: | --- |
| [Company Books Automation](../docs/company-books-automation.md) | CANONICAL_POLICY | Yes | QuickBooks integration, reconciliation and company-book evidence flow. |
| [Sales Tax Program](../docs/sales-tax-program.md) | CANONICAL_POLICY | Yes | Builtegrity-service sales/use tax treatment and registration gate. |
| [Tax Compliance Automation](../docs/tax-compliance-automation.md) | CANONICAL_POLICY | Yes | Versioned tax obligations, evidence and automated readiness controls. |
| [Tax Season Readiness](../docs/tax-season-readiness.md) | RUNBOOK | Yes | Quarter/year-end workpapers and filing-provider boundary. |

### Automation Operations

| Document | Authority | Required | Purpose |
| --- | --- | ---: | --- |
| [Internal Case Engine](../docs/internal-case-engine.md) | CANONICAL_POLICY | Yes | Bounded human actions, verification and owner-touch minimization. |
| [Watchdog Operations](../docs/watchdog-operations.md) | RUNBOOK | Yes | Scheduled detection, routing, retries, dedupe and self-healing boundaries. |

### Economics

| Document | Authority | Required | Purpose |
| --- | --- | ---: | --- |
| [Financial Safety Covenant](../docs/financial-safety.md) | CANONICAL_POLICY | Yes | Unit economics, cash/runway, stale-evidence and machine-brake policy. |
| [Pricing Engine](../docs/pricing-engine.md) | CANONICAL_POLICY | Yes | BG_STANDARD_V1 candidate, micros/carry treatment and owner/legal lock boundaries. |

### Governance

| Document | Authority | Required | Purpose |
| --- | --- | ---: | --- |
| [Owner Control Manifest](../ops/owner-control-manifest.json) | CANONICAL_MACHINE | Yes | Owner recovery/readiness status for critical providers and systems. |
| [Owner Independence & Disaster Recovery](../docs/owner-independence-and-disaster-recovery.md) | CANONICAL_POLICY | Yes | Foundational owner-control, recovery and no-hidden-AI-dependency standard. |
| [Production Readiness Gate](../docs/production-readiness-gate.md) | CANONICAL_POLICY | Yes | Blocking checklist and release rule for TX-LIVE-0001. |
| [Provider Independence](../docs/provider-independence.md) | CANONICAL_POLICY | Yes | Adapter/provider replacement and ownership boundaries. |
| [Provider Procurement & Automation Standard](../docs/provider-procurement-standard.md) | CANONICAL_POLICY | Yes | Quote semantics, provider lifecycle, authority limits and automation-enablement criteria. |
| [System Contract](../ops/system-contract.json) | CANONICAL_MACHINE | Yes | Cross-system architecture, commercial decision state, deployment/source-control gates and release invariants. |

### Infrastructure

| Document | Authority | Required | Purpose |
| --- | --- | ---: | --- |
| [Deployment Ownership](../docs/deployment-ownership.md) | CANONICAL_POLICY | Yes | GitHub Pages pre-launch exception and Cloudflare Worker live-domain cutover. |

### Legal Compliance

| Document | Authority | Required | Purpose |
| --- | --- | ---: | --- |
| [International Expansion Gates](../docs/international-expansion-gates.md) | CANONICAL_POLICY | Yes | Requirements before leaving U.S./USD V1 scope. |
| [Legal Compliance Program](../docs/legal-compliance-program.md) | CANONICAL_POLICY | Yes | Legal/compliance perimeter, review evidence and fail-closed operation. |
| [Legal Incident Autopilot](../docs/legal-incident-autopilot.md) | CANONICAL_POLICY | Yes | Legal notice intake, evidence preservation, counsel routing and authority boundaries. |
| [State Jurisdiction Program](../docs/state-jurisdiction-program.md) | CANONICAL_POLICY | Yes | State-by-state review and customer/merchant jurisdiction gating. |

### Privacy Security

| Document | Authority | Required | Purpose |
| --- | --- | ---: | --- |
| [Data Retention Policy](../docs/data-retention-policy.md) | CANONICAL_POLICY | Yes | Retention, deletion, legal hold and record-preservation rules. |
| [Incident Response Plan](../docs/incident-response-plan.md) | RUNBOOK | Yes | Security incident containment, evidence, legal review and recovery. |
| [Information Security Program](../docs/information-security-program.md) | CANONICAL_POLICY | Yes | Security governance, access, vendor and control program. |
| [Security Reporting Policy](../SECURITY.md) | POLICY | Yes | Private vulnerability-reporting instructions and disclosure boundary. |

### Product

| Document | Authority | Required | Purpose |
| --- | --- | ---: | --- |
| [Brand System](../docs/brand-system.md) | REFERENCE | No | Current launch-shell brand reference. |
| [Comparison Model](../docs/comparison-model.md) | REFERENCE | No | Product comparison reference; non-canonical business logic. |
| [Merchant Self-Service Integrations & Help](../docs/merchant-self-service-fields-help.md) | RUNBOOK | No | Automatic custom field update sources, customer grouping, bank consent guidance and self-service Help request lifecycle. |

### Provider Setup

| Document | Authority | Required | Purpose |
| --- | --- | ---: | --- |
| [Clerk Setup](../docs/clerk-setup.md) | RUNBOOK | Yes | Identity-provider configuration without embedding credentials. |
| [Cloudflare Access Setup](../docs/cloudflare-access-setup.md) | RUNBOOK | No | Optional infrastructure defense-in-depth setup; not primary product auth. |
| [Dual Processor Integration](../docs/dual-processor-integration.md) | RUNBOOK | No | Stripe/Square processor adapter integration, Square developer setup and production safety gates. |

### Public Legal Documents

| Document | Authority | Required | Purpose |
| --- | --- | ---: | --- |
| [Acceptable Use Policy](../public/legal/acceptable-use/index.html) | MERCHANT_FACING_DRAFT | Yes | Prohibited/restricted use and enforcement disclosure. |
| [Data Processing Addendum](../public/legal/dpa/index.html) | MERCHANT_FACING_DRAFT | Yes | Merchant processor/service-provider data-protection terms. |
| [Electronic Records Consent](../public/legal/electronic-records/index.html) | MERCHANT_FACING_DRAFT | Yes | Electronic records/signature consent and statutory-boundary disclosure. |
| [Fee Schedule](../public/legal/fees/index.html) | MERCHANT_FACING_DRAFT | Yes | Merchant-facing BG_STANDARD_V1 fee/refund disclosure; must match locked commercial and legal policy before LIVE. |
| [Platform Agreement](../public/terms/index.html) | MERCHANT_FACING_DRAFT | Yes | Merchant platform terms; remains pre-launch draft until counsel-approved version is activated. |
| [Privacy Notice](../public/privacy/index.html) | PUBLIC_DISCLOSURE_DRAFT | Yes | Public privacy disclosure; version approval remains a legal/compliance gate. |
| [Security Summary](../public/legal/security/index.html) | PUBLIC_DISCLOSURE_DRAFT | Yes | Public security disclosure; not a certification or guarantee. |
| [Subprocessor Registry](../public/legal/subprocessors/index.html) | PUBLIC_DISCLOSURE_DRAFT | Yes | Public service-provider/subprocessor disclosure and change-control reference. |

### Reporting

| Document | Authority | Required | Purpose |
| --- | --- | ---: | --- |
| [Monthly Statements](../docs/monthly-statements.md) | CANONICAL_POLICY | Yes | Statement V2 semantics, immutable artifacts and delivery confirmation. |

### Transaction Engine

| Document | Authority | Required | Purpose |
| --- | --- | ---: | --- |
| [Transaction Economics & Records](../docs/transaction-economics-records.md) | CANONICAL_POLICY | Yes | Identity/economics/PDF boundaries, entitlement versus cash and cost semantics. |
| [Transaction Engine Runbook](../docs/transaction-engine-runbook.md) | RUNBOOK | Yes | Runtime setup, operating model, transaction flow and production configuration. |
| [Transaction Intelligence](../docs/transaction-intelligence.md) | CANONICAL_POLICY | Yes | Normalized transaction graph, unknown-component learning and modular profiles. |
| [Transaction Protection Classification](../docs/transaction-protection-classification.md) | CANONICAL_POLICY | Yes | PROTECTED/OBSERVED/IMPORTED classification and protection invariants. |

## 8. Private records — never place these in the repository

| Private record | Approved storage class | Required before LIVE | What belongs there |
| --- | --- | ---: | --- |
| Owner Emergency Vault | PRIVATE_OWNER_CONTROLLED_VAULT | Yes | Credentials, MFA recovery codes, account recovery identifiers, emergency contacts and secret inventory. |
| Executed Counsel Engagement / Privileged Matter Files | COUNSEL_SYSTEM_OR_PRIVATE_LEGAL_STORE | Yes | Signed engagement, privileged communications, legal opinions, claim strategy and confidential matter records. |
| Executed Provider Contracts / Quotes | PRIVATE_CONTRACT_STORE | Yes | Signed contracts, negotiated prices, security/DPA terms, account identifiers and confidential commercial terms. |
| Cyber / Tech E&O Policy and Claims Instructions | PRIVATE_INSURANCE_OR_CONTRACT_STORE | Yes | Policy documents, limits, exclusions, claim identifiers, notice instructions and broker/carrier contacts. |
| Banking / Accounting Recovery and Financial Credentials | PRIVATE_OWNER_VAULT_AND_FINANCIAL_PROVIDERS | Yes | Bank credentials, recovery data, account numbers and private financial institution records. |
| IP / Patent Strategy and Counsel Work Product | PRIVATE_IP_COUNSEL_STORE | No | Patentability analysis, claims strategy, disclosure analysis and privileged IP advice. |

Actual passwords, API keys, webhook signing secrets, backup codes, private keys, bank credentials, privileged legal communications, negotiated confidential provider terms and patent claim strategy must never be copied into this master or the public engineering repository.

## 9. Maintenance / self-repair contract

- `npm run docs:check` verifies every registered required document exists, every repository `docs/*.md` file is registered, private records have no repository path, and this generated master exactly matches canonical inputs.
- `npm run docs:fix` safely regenerates this master from `ops/system-contract.json`, `ops/owner-control-manifest.json` and `ops/document-register.json`.
- `npm run system:gate` includes documentation integrity, so documentation drift becomes a system failure instead of a forgotten cleanup task.
- CI must never auto-decide legal approval, owner commercial locks, provider approval, confidential storage location, or a security exception. Those fail visibly and require the proper authority.
- New documentation must be added to `ops/document-register.json`; deleted/renamed canonical docs require an intentional register update in the same reviewed change.

## 10. Owner quick commands

```bash
npm run docs:check       # verify master/document control
npm run docs:fix         # regenerate master after canonical changes
npm run system:gate      # structural/security/coherence/owner checks
npm run system:gate:live # must fail until every real LIVE gate is satisfied
```

For the full launch checklist, use `docs/production-readiness-gate.md`. For owner/provider recovery, use `docs/owner-independence-and-disaster-recovery.md` and `ops/owner-control-manifest.json`.

---

_Generated by `scripts/render-master-document.mjs`. If this file differs from the canonical sources, the documentation integrity gate must fail._

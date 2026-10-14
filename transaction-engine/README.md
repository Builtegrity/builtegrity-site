# Builtegrity Transaction Engine

This directory contains transaction-engine definitions and test fixtures. It is **not** a second application and it is not the canonical database schema.

## Canonical architecture

Builtegrity V1 is transaction-integrity infrastructure around Stripe. Stripe processes the payment; Builtegrity records, contextualizes, monitors, reconciles, and reports the transaction. Builtegrity does not become the merchant of record or custody merchant/customer funds in V1.

Core hierarchy:

`Partner → Merchant → Customer → Purchase → Transaction → Transaction Data`

Every merchant belongs to a parent partner category. Direct merchants use the internal `PARTNER-0001` / Builtegrity Direct relationship. Customer records are merchant-scoped.

## Three independent transaction-state axes

Never collapse these into one status.

### Lifecycle

`CREATED → CONSENTED → PAYMENT_PENDING → PAID → PAYOUT_PENDING → COMPLETE`

Lifecycle answers: **where is the transaction operationally?**

### Integrity

`INCOMPLETE | ACCOUNTED | NEEDS_ATTENTION`

ACCOUNTED is an integrity state. It answers: **is the transaction sufficiently reconciled/accounted for under the integrity model?**

### Record / revenue classification

`PENDING_PROTECTED | PROTECTED | OBSERVED | IMPORTED | FEE_EXCEPTION`

PROTECTED is a record/revenue classification. It answers: **did this payment use the controlled protected route, possess the required customer-jurisdiction and pre-checkout legal-gate evidence, succeed through the processor, and satisfy the exact processor-confirmed Builtegrity fee invariant?**

`ACCOUNTED` and `PROTECTED` are therefore not synonyms. A record can be operationally/integrity-accounted while belonging to a different source/revenue class.

Merchant-facing source classes are `PROTECTED`, `OBSERVED`, and `IMPORTED`. `PENDING_PROTECTED` and `FEE_EXCEPTION` are internal operational states.

Processor truth must always be preserved. If payment/application-fee evidence arrives but the required pre-checkout legal evidence is missing, Builtegrity records the Stripe facts but blocks PROTECTED promotion and routes the record to review rather than rejecting or discarding truthful processor evidence.

## Revenue invariant

Only `PROTECTED` transactions can create Builtegrity transaction-fee revenue.

`OBSERVED` transactions can be documented/monitored but do not create the transaction fee. `IMPORTED` transactions are archival/reference records and do not create the transaction fee.

There is no separate monthly/setup billing path in V1. The fee is merchant-side Platform Fee economics collected through the protected processor flow.

## Exact fee, cash, and carry

The current transaction's exact fee entitlement is represented in micros and becomes entitled only when that transaction becomes PROTECTED. Stripe application-fee collection occurs in whole smallest-currency units.

A PROTECTED transaction's fractional residual can enter the merchant/currency carry ledger. Whole cents of available prior carry may be reserved before a later checkout. Reserved carry becomes SETTLED only if that later payment also becomes PROTECTED; if payment succeeds but the required Builtegrity fee is not confirmed and the transaction remains `FEE_EXCEPTION`, the reservation remains releasable.

A later payment that settles prior carry is collecting prior entitlement; it is not earning a new extra fee for the later transaction. Exact transaction entitlement and whole-cent processor cash are therefore separate accounting facts.

See `ops/system-contract.json` and `docs/pricing-engine.md`.

## Authoritative database schema

The production schema is **only** the ordered set of files in:

`migrations/*.sql`

Apply them in lexical order through Wrangler/D1 migration tooling. A standalone `transaction-engine/schema.sql` snapshot is intentionally forbidden because it inevitably becomes stale and creates a competing schema authority.

Historical migrations through the frozen baseline must not be renamed, deleted, or edited. Corrections are additive migrations. `npm run db:lineage` enforces that rule and also rejects future duplicate/gapped migration numbers.

`transaction-engine/seed-tx-0001.sql` is test/demo seed data only.

## Canonical cross-system contract

`ops/system-contract.json` is the machine-readable cross-system contract for product role, state vocabularies, pricing candidate, legal/protection requirements, fee/carry semantics, financial-safety thresholds, canonical sources, and commercial owner-lock status.

Run:

- `npm run system:coherence` for structural consistency;
- `npm run system:gate` for structural + owner-independence checks;
- `npm run system:gate:live` before live-money release.

The LIVE gate intentionally fails while a required commercial decision, legal approval, provider setup, source-control proof, or owner-control proof is still pending.

## Legal authority

“Counsel” in this system means an actual qualified outside lawyer/law firm retained by Builtegrity under an active engagement. It does not mean ChatGPT, Atlas, an automated classifier, or a placeholder database record.

Until standing counsel is engaged and verified, the legal-response program remains non-live and the release gate must fail closed.

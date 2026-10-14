# Builtegrity transaction-integrity engine

The original Builtegrity roofing-lead concept is retired. Builtegrity is currently the launch shell for a transaction-integrity product whose working promise is:

> Every payment accounted for.

Builtegrity does not process card data itself. Stripe remains the processor. The V1 engine connects commercial context, customer consent, legal/compliance evidence, and Stripe payment/fee/payout facts into one normalized transaction-integrity record.

## Read this first — ownership foundation

Before changing architecture, deploying live money, or adding a new provider, read `docs/owner-independence-and-disaster-recovery.md` and `ops/system-contract.json`.

Builtegrity's foundational rule is that the company must remain operable, diagnosable, recoverable, migratable, pausable, and terminable by its owner even if ChatGPT/Atlas, Work, a contractor, an employee, or any single vendor disappears.

The machine-readable owner-control inventory is `ops/owner-control-manifest.json`. The cross-system contract is `ops/system-contract.json`.

Before LIVE:

- `npm run system:gate:live` must pass;
- `npm run owner:gate:live` must pass;
- the runtime/D1 production-readiness controls must independently allow LIVE;
- all applicable legal, processor, security, tax, financial, provider, source-control, and owner-control evidence must be current.

A technically working deployment is not permission to process live money.

## V1 stack

- GitHub — canonical source for code, migrations, CI, technical docs, and infrastructure configuration.
- Cloudflare Workers + Static Assets — production application frontend/site hosting, API runtime, Stripe webhooks, and transaction processing logic.
- Cloudflare D1 — operational relational database for partners, merchants, users/relationships, customers, purchases, transactions, events, exceptions, processor references, and watchdog state.
- Cloudflare R2 — private durable transaction PDFs and immutable monthly statement artifacts.
- Stripe Connect — Processor Adapter #1, merchant connection, Checkout/direct-charge flow, application fees, processor financial records, and payout data.
- Clerk — primary application identity/session layer for owner/staff and future merchant users. Builtegrity retains authorization/tenant relationships in its own database.
- Resend — transactional email delivery such as payment confirmations, exception alerts, monthly statements, and merchant notifications; separately, the planned legal receiving route uses verified inbound email handling.
- Cloudflare Turnstile — abuse/bot protection on appropriate public entry points.
- Google Drive/Sheets — company strategy, planning, economics, pilot pipeline, compliance planning, and human-readable specifications only; never the live transaction system.

GitHub Pages may publish compatibility/legal mirror files from the repository, but it is not the production transaction runtime. Production application behavior lives in the Worker/Static Assets path.

Optional/future adapters such as Cloudflare Access, Queues, Square, and partner APIs may be added without changing the core transaction model.

## V1 data model

`Partner -> Merchant -> merchant-scoped Customer -> Purchase -> Transaction -> Events / Exceptions`

`PARTNER-0001` is the internal house channel for direct merchants. Customers are deliberately merchant-scoped. Purchases and transactions are separate because one purchase can have multiple payments. Transaction events are append-only.

Identity is intentionally separate from tenancy. Clerk proves who a user is; Builtegrity decides which merchant(s), roles, and records that identity may access.

## Transaction state model: three separate axes

Never collapse these into one status.

### Lifecycle

`CREATED -> CONSENTED -> PAYMENT_PENDING -> PAID -> PAYOUT_PENDING -> COMPLETE`

Lifecycle answers: **where is the transaction operationally?**

### Integrity

- `INCOMPLETE`
- `ACCOUNTED`
- `NEEDS_ATTENTION`

Integrity answers: **is the transaction sufficiently reconciled/accounted for under the integrity model?**

`ACCOUNTED` is not fraud protection, chargeback insurance, a legal-enforceability guarantee, or independent verification of bank receipt.

### Record / revenue classification

- `PENDING_PROTECTED`
- `PROTECTED`
- `OBSERVED`
- `IMPORTED`
- `FEE_EXCEPTION`

Merchant-facing source classes are `PROTECTED`, `OBSERVED`, and `IMPORTED`.

`PROTECTED` is a record/revenue classification. It requires all of these facts to agree:

- the Builtegrity-controlled protected route;
- required customer jurisdiction attestation;
- required pre-checkout legal-gate evidence;
- successful processor payment history; and
- processor-confirmed gross Builtegrity application-fee evidence matching the locked current-transaction whole-cent fee plus any valid prior carry reserved on that payment.

Real Stripe payment/fee truth is always preserved. If the processor proves that money moved but a protection/legal prerequisite is missing, Builtegrity records the processor facts, blocks PROTECTED promotion, and routes the transaction to review. It does not discard Stripe truth to make the state look clean.

`ACCOUNTED` and `PROTECTED` are different axes. A record can be accounted/reconciled without being PROTECTED.

Only `PROTECTED` transactions can create Builtegrity transaction-fee entitlement/revenue. `OBSERVED` and `IMPORTED` records can be documented/reconciled but do not create the protected transaction fee.

## Pricing, carry, and fee semantics

The implemented pre-launch candidate is `BG_STANDARD_V1`, but implementation does not equal owner approval or legal approval. `ops/system-contract.json` records those states separately.

Exact fee calculation can exist before payment, but **economic entitlement is created only when the transaction becomes PROTECTED**.

Stripe application-fee collection occurs in whole smallest-currency units. Sub-cent precision stays internal in micros.

The carry lifecycle is:

`AVAILABLE -> RESERVED before Checkout -> SETTLED only at PROTECTED`

A PROTECTED transaction's fractional residual can enter the merchant/currency carry ledger. When available carry reaches a whole cent, that prior entitlement can be reserved before a later checkout. If checkout is abandoned, the reservation can be released. If payment succeeds but the required Builtegrity fee is missing or mismatched, the transaction remains non-PROTECTED and the reservation remains releasable. Reserved carry is not SETTLED until the later payment itself becomes PROTECTED.

Keep these economic facts separate:

- exact fee entitlement attributable to the current PROTECTED transaction;
- current transaction whole-cent processor fee;
- residual generated by the current PROTECTED transaction;
- prior carry reserved/settled on the current payment;
- gross processor application-fee cash, which can include prior carry;
- current retained fee cash after later fee refunds/credits.

Prior carry settled later is collection of prior entitlement, not new fee entitlement earned by the later transaction. Cash-basis books may reconcile processor cash without re-attributing that prior entitlement to the later transaction.

## Database migration lineage

The authoritative schema is the ordered set of `migrations/*.sql` files.

Historical D1 migrations through `0060` are frozen against the post-PR-#33 system baseline. They must never be renamed, deleted, or edited after the fact. Corrections are made with new additive migrations.

Two legacy duplicate numeric prefixes (`0038` and `0053`) are grandfathered by exact filename. Future migration version numbers must be unique and contiguous. The post-baseline corrective lineage begins with `0061`.

Run `npm run db:lineage` to verify migration history. `npm run system:coherence` includes that check.

## Runtime

The current implementation targets:

- Cloudflare Worker
- Cloudflare D1
- Cloudflare R2 for private durable record/statement artifacts
- Worker Static Assets for the internal console and customer payment pages
- Clerk JWT verification at the application edge
- Stripe Connect direct charges for compatible existing Stripe merchants
- Stripe-hosted Checkout
- Connect application fees as the first fee-collection rail
- Resend/Turnstile configuration hooks
- scheduled runtime watchdogs with self-healing transaction checks
- automated monthly statement generation/delivery reconciliation
- independent scheduled GitHub CI validation

The code also keeps `integration_mode`, authentication adapters, and `fee_collection_method` separate so Stripe Apps, partner APIs, Square, replacement identity providers, or other future adapters do not require rebuilding the transaction model.

## Watchdog model

Builtegrity is designed for exception-only operations:

- lightweight Worker watchdog every 15 minutes;
- daily deep dependency probe;
- D1-backed deduplicated alert ledger and run history;
- safe automatic repair of integrity state and known exception records;
- Resend escalation only for ERROR/CRITICAL findings, with reminder suppression;
- `/api/health/ready` readiness endpoint for external checks;
- authenticated `/api/watchdogs/status` and `/api/watchdogs/run` operator endpoints;
- GitHub CI on every change plus scheduled independent validation.

See `docs/watchdog-operations.md` for operating rules and failure boundaries.

## TX-0001

The seeded proving transaction is:

- `PARTNER-0001` — Builtegrity Direct
- `MER-0001` — ABC Cabinetry
- `CUST-0001` — John Smith
- `PUR-0001` — JOB-1048, $4,000 custom cabinetry project
- `TX-0001` — $1,200 deposit
- legacy test transaction-integrity fee — $0.25, seed/test only; production pricing is governed separately by the pricing engine

It starts at `CREATED / INCOMPLETE` and can be exercised through the development simulator before Stripe is connected. TX-0001 is test/demo evidence, not an exception to the production protection/legal invariants.

## Important paths

- `/login/` — application sign-in handoff to Clerk
- `/console/` — internal transaction console
- `/pay/?token=...` — customer transaction/terms page
- `/api/health/ready` — public readiness endpoint with no secret values
- `/api/watchdogs/status` — authenticated watchdog status/alert history
- `/api/watchdogs/run` — authenticated manual deep watchdog run
- `/api/webhooks/stripe` — signed Stripe webhook endpoint
- `/api/records/resend-statement-webhook` — signed Resend monthly-statement delivery event endpoint
- `migrations/` — immutable/additive D1 migration lineage
- `transaction-engine/seed-tx-0001.sql` — fake proving transaction
- `ops/system-contract.json` — cross-system architecture/commercial/release contract
- `ops/owner-control-manifest.json` — owner-control/recovery verification state
- `docs/owner-independence-and-disaster-recovery.md` — cornerstone ownership/recovery policy
- `docs/transaction-engine-runbook.md` — setup and operating runbook
- `docs/watchdog-operations.md` — exception-only operations/watchdog rules
- `docs/monthly-statements.md` — automated statement operating contract
- `docs/production-readiness-gate.md` — hard gate before any live payment
- `docs/provider-independence.md` — provider/ownership boundary

## Status

The engine is still pre-production. No live merchant payment should move through it until the Production Readiness Gate is satisfied, `npm run system:gate:live` passes, and the exact Stripe account/platform configuration is confirmed in test mode first.

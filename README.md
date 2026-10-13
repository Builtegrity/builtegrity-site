# Builtegrity transaction-integrity engine

The original Builtegrity roofing-lead concept is retired. Builtegrity is currently the launch shell for a transaction-integrity product whose working promise is:

> Every payment accounted for.

Builtegrity does not process card data itself. Stripe remains the processor. The V1 engine connects commercial context and customer consent to Stripe payment, fee, balance-transaction, payout, refund, dispute, and exception records.

## Read this first — ownership foundation

Before changing architecture, deploying live money, or adding a new provider, read `docs/owner-independence-and-disaster-recovery.md`.

Builtegrity's foundational rule is that the company must remain operable, diagnosable, recoverable, migratable, pausable, and terminable by its owner even if ChatGPT/Atlas, Work, a contractor, an employee, or any single vendor disappears.

The machine-readable control inventory is `ops/owner-control-manifest.json`. The live owner-control gate is `npm run owner:gate:live`. It must pass before `TX-LIVE-0001`.

## Locked V1 stack

- GitHub — canonical source for code, migrations, CI, technical docs, and infrastructure configuration.
- Cloudflare Workers + Static Assets — frontend/site hosting, API runtime, Stripe webhooks, and transaction processing logic. Pages is not a separate dependency.
- Cloudflare D1 — operational relational database for partners, merchants, users/relationships, customers, purchases, transactions, events, exceptions, processor references, and watchdog state.
- Cloudflare R2 — private durable transaction PDFs and immutable monthly statement artifacts.
- Stripe Connect — Processor Adapter #1, merchant connection, Checkout/direct-charge flow, application fees, processor financial records, and payout data.
- Clerk — primary application identity/session layer for owner/staff and future merchant users. Builtegrity retains authorization/tenant relationships in its own database.
- Resend — transactional email delivery such as payment confirmations, exception alerts, monthly statements, and merchant notifications.
- Cloudflare Turnstile — abuse/bot protection on appropriate public entry points.
- Google Drive/Sheets — company strategy, planning, economics, pilot pipeline, compliance planning, and human-readable specifications only; never the live transaction system.

Optional/future adapters such as Cloudflare Access, Queues, Square, and partner APIs may be added without changing the core transaction model.

## V1 data model

`Partner -> Merchant -> merchant-scoped Customer -> Purchase -> Transaction -> Events / Exceptions`

`PARTNER-0001` is the internal house channel for direct merchants. Customers are deliberately merchant-scoped. Purchases and transactions are separate because one purchase can have multiple payments. Transaction events are append-only.

Identity is intentionally separate from tenancy. Clerk proves who a user is; Builtegrity decides which merchant(s), roles, and records that identity may access.

## V1 lifecycle

`CREATED -> CONSENTED -> PAYMENT_PENDING -> PAID -> PAYOUT_PENDING -> COMPLETE`

Current integrity state is separate:

- `INCOMPLETE`
- `ACCOUNTED`
- `NEEDS_ATTENTION`

`ACCOUNTED` is intentionally narrower than “protected.” It means the required transaction context, consent, processor records, economics, and automatic-payout trail have been captured with no unresolved exception. It is not fraud protection, chargeback insurance, a legal-enforceability guarantee, or independent verification of bank receipt.

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

It starts at `CREATED / INCOMPLETE` and can be exercised through the development simulator before Stripe is connected.

## Important paths

- `/login/` — application sign-in handoff to Clerk
- `/console/` — internal transaction console
- `/pay/?token=...` — customer transaction/terms page
- `/api/health/ready` — public readiness endpoint with no secret values
- `/api/watchdogs/status` — authenticated watchdog status/alert history
- `/api/watchdogs/run` — authenticated manual deep watchdog run
- `/api/webhooks/stripe` — signed Stripe webhook endpoint
- `/api/records/resend-statement-webhook` — signed Resend monthly-statement delivery event endpoint
- `migrations/` — D1 migrations
- `transaction-engine/seed-tx-0001.sql` — fake proving transaction
- `ops/owner-control-manifest.json` — owner-control/recovery verification state
- `docs/owner-independence-and-disaster-recovery.md` — cornerstone ownership/recovery policy
- `docs/transaction-engine-runbook.md` — setup and operating runbook
- `docs/watchdog-operations.md` — exception-only operations/watchdog rules
- `docs/monthly-statements.md` — automated statement operating contract
- `docs/production-readiness-gate.md` — hard gate before any live payment
- `docs/provider-independence.md` — provider/ownership boundary

## Status

The engine is still pre-production. No live merchant payment should move through it until the Production Readiness Gate is satisfied, `npm run owner:gate:live` passes, and the exact Stripe account/platform configuration is confirmed in test mode first.

# Builtegrity transaction-integrity engine

The original Builtegrity roofing-lead concept is retired. Builtegrity is currently the launch shell for a transaction-integrity product whose working promise is:

> Every payment accounted for.

Builtegrity does not process card data itself. Stripe remains the processor. The V1 engine connects commercial context and customer consent to Stripe payment, fee, balance-transaction, payout, refund, dispute, and exception records.

## V1 data model

`Partner -> Merchant -> merchant-scoped Customer -> Purchase -> Transaction -> Events / Exceptions`

`PARTNER-0001` is the internal house channel for direct merchants. Customers are deliberately merchant-scoped. Purchases and transactions are separate because one purchase can have multiple payments. Transaction events are append-only.

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
- static Worker assets for the internal console and customer payment pages
- Stripe Connect direct charges for compatible existing Stripe merchants
- Stripe-hosted Checkout
- Connect application fees as the first fee-collection rail

The code also keeps `integration_mode` and `fee_collection_method` separate so Stripe Apps, partner APIs, Square, or other future adapters do not require rebuilding the transaction model.

## TX-0001

The seeded proving transaction is:

- `PARTNER-0001` — Builtegrity Direct
- `MER-0001` — ABC Cabinetry
- `CUST-0001` — John Smith
- `PUR-0001` — JOB-1048, $4,000 custom cabinetry project
- `TX-0001` — $1,200 deposit
- test transaction-integrity fee — $0.25, test only

It starts at `CREATED / INCOMPLETE` and can be exercised through the development simulator before Stripe is connected.

## Important paths

- `/console/` — internal transaction console
- `/pay/?token=...` — customer transaction/terms page
- `/api/webhooks/stripe` — signed Stripe webhook endpoint
- `migrations/` — D1 migrations
- `transaction-engine/seed-tx-0001.sql` — fake proving transaction
- `docs/transaction-engine-runbook.md` — setup and operating runbook
- `docs/production-readiness-gate.md` — hard gate before any live payment

## Status

The engine is still pre-production. No live merchant payment should move through it until the Production Readiness Gate is satisfied and the exact Stripe account/platform configuration is confirmed in test mode first.

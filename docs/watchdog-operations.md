# Builtegrity Watchdog Operations

## Objective

Builtegrity should operate as an exception-only system. Routine transaction processing, reconciliation, health checks, and recoverable state corrections should occur without owner involvement. Human attention is reserved for conditions the software cannot safely repair on its own.

The operating rule is:

> Repair first. Escalate second. Never hide financial uncertainty.

The watchdog layer reduces routine maintenance; it does not make provider accounts, legal obligations, security ownership, billing, domains, or payment-platform responsibilities disappear.

## Monitoring layers

### Runtime fast sweep — every 15 minutes

The Worker checks:

- Stripe webhook receipts that failed or stayed `PROCESSING` too long;
- transactions that remain `PAYMENT_PENDING` unusually long;
- successful payments missing required Stripe processor records;
- transactions marked `COMPLETE` that do not satisfy `ACCOUNTED` invariants;
- integrity-fee shortfalls;
- failed payouts;
- automatic payouts that have not reconciled inside the tolerance window;
- active Stripe merchants missing a connected account identifier;
- configuration required for the current watchdog stage.

### Daily deep probe

The Worker additionally checks external dependencies that should not be contacted every fifteen minutes:

- Clerk verification/JWKS availability;
- the public Builtegrity health route;
- active connected Stripe merchant capability state, including charges, payouts, and automatic-payout compatibility.

### Independent repository watchdog

GitHub Actions validates the source and schema on every push and pull request and on a six-hour schedule. It checks JavaScript syntax, provider/authentication guardrails, the complete migration chain, TX-0001 hierarchy, append-only transaction events, watchdog schema/deduplication, and watchdog detection-query validity.

This layer remains useful even if the production Worker is unavailable.

## Safe self-healing

The watchdog may automatically repair state only when the correction can be derived from existing authoritative records without guessing.

Current safe repairs include:

- recomputing transaction integrity from stored transaction and exception facts;
- ensuring a failed payout has a `PAYOUT_FAILED` exception;
- ensuring an overdue expected payout has an `EXPECTED_PAYOUT_NOT_FOUND` exception;
- resolving that overdue-payout exception when the payout is later accounted for as paid;
- ensuring an integrity-fee shortfall has an `UNEXPECTED_FEE` exception;
- resolving the fee exception when the expected fee is later fully recorded;
- resolving watchdog alerts automatically when the underlying condition clears.

The watchdog must not fabricate processor IDs, invent consent, mark a payment successful from a browser redirect, mark an unknown payout paid, erase transaction history, or silently downgrade a real financial exception.

## Alert behavior

All findings are written to the D1 `system_alerts` ledger with a stable `alert_key` so repeated checks update one alert rather than generating a new row every fifteen minutes.

- `INFO`: record only.
- `WARN`: record only; designed for conditions worth observing but not waking the owner.
- `ERROR`: email when Resend is configured.
- `CRITICAL`: email when Resend is configured and cause the scheduled Worker run to fail visibly.

Email alerts are deduplicated. The first/new/reopened `ERROR` or `CRITICAL` condition may send immediately; an unresolved alert is reminded at most once every 24 hours.

If Resend is unavailable, the financial/runtime truth remains in D1 and the watchdog continues operating. Notification delivery is never allowed to control transaction state.

## Watchdog stages

`WATCHDOG_STAGE` prevents the system from treating deliberately unfinished setup as an outage.

### PREVIEW

Use before Cloudflare/Stripe/Clerk provider configuration exists. Runtime checks can be developed without alerting on missing credentials.

### TEST

Use once the Cloudflare Worker/D1 deployment, Stripe test configuration, and Clerk test application are installed. Missing required test configuration is an error.

### PILOT

Use before merchant pilots. Turnstile, Resend alert delivery, and pilot-facing dependencies become required.

### LIVE

Use before live commercial payment processing. All required runtime URLs, identity, payment, abuse-protection, alerting, and secret configuration must be present.

Never advance a stage simply to silence alerts. Resolve the missing dependency first.

## Operator endpoints

Public readiness:

`GET /api/health/ready`

This returns readiness state, database availability, stage/config completeness, and the latest watchdog result without exposing secrets. It returns HTTP 503 when the runtime is not ready.

Authenticated status:

`GET /api/watchdogs/status`

Returns current open alerts and recent watchdog-run history.

Authenticated deep run:

`POST /api/watchdogs/run`

Runs the watchdog immediately with the deep/manual checks. This is for diagnosis and launch testing; normal operations rely on schedules.

## Recovery and durable records

The D1 database remains the operational source of truth. Once the production D1 database exists, provider-native point-in-time recovery should be part of the recovery procedure, and a restoration must be tested before public commercial reliance.

A database restore is not the same as transaction reconciliation. After an outage or restoration, Builtegrity must reconcile processor activity so Stripe events that occurred while the application was unavailable are reflected in the transaction record.

## Required failure drills before live money

Before `TX-LIVE-0001`, intentionally exercise at least:

- failed payment;
- abandoned Checkout / stale payment-pending state;
- duplicate webhook;
- failed webhook processing;
- delayed/out-of-order event behavior;
- missing application-fee observation;
- payout not found on time;
- payout failure;
- dispute open/close;
- refund behavior;
- Worker/runtime outage;
- database restore and post-restore reconciliation;
- alert creation, deduplication, resolution, and Resend delivery;
- Clerk/session failure;
- connected Stripe merchant becoming incompatible.

The production-readiness gate, not the watchdog itself, determines whether live money is permitted.

## Low-maintenance merchant operating model

The end-state merchant workflow should be:

1. Sale is made.
2. Merchant creates/signs into its Builtegrity account.
3. Merchant connects Stripe.
4. Automated eligibility checks determine whether the merchant fits the supported integration path.
5. Required merchant/business settings are captured once.
6. Builtegrity creates and monitors transaction records automatically.
7. Routine successful transactions require no owner action.
8. The owner is contacted only for a deduplicated exception the system cannot safely resolve.

This is the operating target for the product. The first pilot may deliberately involve more manual observation so unknown edge cases are discovered before self-service onboarding is opened broadly.

## What still cannot be zero-maintenance

Even a highly automated payment-adjacent business retains occasional owner responsibilities. Examples include provider billing/account verification, domain renewals, changes to Stripe/Clerk/Cloudflare policies or APIs, security incidents, tax/accounting obligations, legal/compliance updates, chargeback/refund policy decisions, and unusual merchant support cases.

The architecture goal is therefore **near-zero routine maintenance**, not an unsupported promise that the business can never require attention.

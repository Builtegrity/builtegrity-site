# Builtegrity Transaction Engine — V1 Runbook

## Current architecture

Builtegrity V1 is a Cloudflare Worker with Static Assets and a D1 database. Stripe remains the payment processor. Clerk is the application identity/session provider. Cloudflare Turnstile protects the public consent boundary in protected stages. Resend is the outbound notification adapter.

Builtegrity stores transaction context, consent, normalized Stripe references, append-only event history, exceptions, economics, and automatic-payout reconciliation in D1.

Core hierarchy:

`Partner -> Merchant -> merchant-scoped Customer -> Purchase -> Transaction -> Events / Exceptions`

`PARTNER-0001` is the system-owned house channel for direct merchants.

Identity and authorization are deliberately separate: Clerk proves who the user is; Builtegrity/D1 decides which merchant, role, and records that identity may access. `CLERK_ADMIN_USER_IDS` is only the temporary owner/operator allowlist; real merchant multi-tenancy requires D1-backed memberships and roles before launch.

## Runtime stages

`WATCHDOG_STAGE` is also a payment-safety boundary and must be one of:

- `PREVIEW` — protected payment mutations are disabled.
- `TEST` — Stripe test-mode transaction flow is allowed; Turnstile is not required.
- `PILOT` — payment flow is allowed and Turnstile/configuration requirements are enforced.
- `LIVE` — same fail-closed production requirements as PILOT, using approved live credentials/configuration.

An unknown or misspelled stage fails closed. Do not use stage names outside this list.

## Local setup

1. Copy `wrangler.toml.example` to `wrangler.toml`.
2. Create a Cloudflare D1 database named `builtegrity-v1` and replace `REPLACE_AFTER_D1_CREATION` with its database ID.
3. Copy `.dev.vars.example` to `.dev.vars`.
4. Add Stripe **test-mode** values only:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_CONNECT_CLIENT_ID`
   - `STRIPE_API_VERSION`
5. Add the Clerk development/test values:
   - `CLERK_JWT_KEY`
   - `CLERK_ISSUER`
   - `CLERK_PUBLISHABLE_KEY`
   - `CLERK_AUTHORIZED_PARTIES`
   - `CLERK_ADMIN_USER_IDS`
   - `CLERK_SIGN_IN_URL`
   - `CLERK_USER_URL` when required by the stage
6. Add Turnstile and Resend values before entering PILOT/LIVE. Never commit secrets.
7. Run `npm install`.
8. Run `npm run db:migrate:local`.
9. Run `npm run db:seed:local`.
10. Run `npm run dev`.
11. Open `/console/` for the local internal console.
12. Open `/pay/?token=test-tx-0001-token` for the local fake customer payment page.

There is intentionally no npm command that remotely seeds TX-0001. Production/test-cloud data must never be populated with the local fake seed by convenience command.

No persistent `INTERNAL_ADMIN_TOKEN` is configured in the deployed application. The authenticated runtime creates a one-request in-memory bridge value only after application authentication succeeds.

## Database migrations

Apply every migration in order before considering the runtime ready:

`0001` through `0012`.

The later integrity migrations are not optional. They include:

- runtime/payment-control fields;
- public payment-token and Checkout-resume fields;
- Stripe OAuth state storage;
- watchdog ledger/alerts;
- unique Stripe-object constraints;
- transaction-creation idempotency;
- immutable accepted-agreement protections;
- atomic consent/Checkout audit evidence;
- one connected Stripe account per Builtegrity merchant relationship;
- request fingerprints for idempotent transaction creation;
- one OPEN exception per transaction/exception type.

Readiness fails closed if required current columns, audit triggers, or concurrency-critical indexes are missing.

## Application authentication

Primary V1 provider: Clerk.

- `/login/` hands interactive sign-in to the configured Clerk Account Portal.
- The Worker verifies the Clerk JWT signature, issuer, authorized party where configured, expiration, and Clerk session semantics (`sid`).
- Clerk-signed custom JWTs without session semantics are not accepted as application sessions.
- `CLERK_ADMIN_USER_IDS` is temporary owner/operator authorization only.
- Merchant membership and role authorization must move into D1 before real multi-tenant merchant access.

Cloudflare Access remains optional defense in depth for infrastructure/internal surfaces; it is not the product identity system.

## Stripe Connect onboarding

V1 is designed for an existing U.S. Stripe merchant whose account is available for a read/write Connect OAuth relationship.

The console calls:

`POST /api/merchants/:merchant_id/stripe/connect-url`

The Worker creates a one-time OAuth state with a real expiration timestamp and returns the Stripe authorization URL. Stripe returns to:

`/api/stripe/oauth/callback`

The callback exchanges the code for the merchant's `stripe_user_id` (`acct_...`). The database enforces that a connected Stripe account cannot be attached to two Builtegrity merchant records.

After connection, call:

`POST /api/merchants/:merchant_id/stripe/verify`

V1 verification requires the supported merchant profile, including U.S. country, charges enabled, payouts enabled, details submitted, and automatic payout scheduling. Manual payouts are not compatible with the current transaction-to-payout promise.

## Transaction creation and idempotency

Internal endpoint:

`POST /api/transactions`

Outside local DEV, creation requires an `Idempotency-Key`.

Builtegrity stores both the merchant-scoped idempotency key and a normalized request fingerprint:

- same merchant + same key + same normalized request => replay the original transaction;
- same merchant + same key + different normalized request => conflict, never silently reuse the old transaction.

A transaction receives:

- permanent `TX-...` ID;
- unguessable public payment token;
- exact terms snapshot plus SHA-256 evidence once consent is accepted;
- fee-earned value separate from fee-collection method;
- initial `TX_CREATED` event.

Optional payment-link expiry must parse as a valid future timestamp. Invalid or already-expired input is rejected.

## Customer payment flow

1. Customer opens `/pay/?token=...`.
2. Builtegrity displays merchant, purchase context, amount, and exact transaction terms.
3. Customer explicitly accepts the terms.
4. In PILOT/LIVE, the consent request must also pass server-side Cloudflare Turnstile verification for action `payment_consent` and an approved Builtegrity hostname.
5. The Worker stores acceptance time, method, and SHA-256 hash of the exact terms snapshot.
6. Builtegrity creates Stripe Checkout on the merchant's connected account.
7. Card data is entered only in Stripe-hosted Checkout.
8. Browser return never marks payment successful; Stripe server-side events do.

Checkout creation uses deterministic Stripe idempotency keys. If Stripe succeeds but D1 persistence is interrupted, a retry reuses the same Stripe Checkout Session rather than creating an accidental duplicate. Stored sessions are checked before reuse; expired sessions are replaced intentionally.

## Stripe webhook boundary and event handling

Webhook endpoint:

`POST /api/webhooks/stripe`

The raw request is verified against `Stripe-Signature` and `STRIPE_WEBHOOK_SECRET`. Clerk and Turnstile must never sit in front of this route.

For transaction-direct Checkout/PaymentIntent events, the production webhook entrypoint also verifies that the event's connected Stripe account matches the Builtegrity merchant that owns the referenced transaction. A transaction ID in Stripe metadata is not sufficient by itself.

Important V1 events include:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `application_fee.created`
- `application_fee.refunded`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.closed`
- `payout.reconciliation_completed`
- `payout.paid`
- `payout.failed`
- `payout.canceled`

Webhook receipts are idempotent. A duplicate event that arrives while the first copy is still PROCESSING receives a retryable non-success response rather than falsely acknowledging completion. Stale processing claims can later be reclaimed. Transaction events are append-only.

Payout reconciliation can recover when payout events arrive before the transaction was linked to that payout by using Stripe payout balance transactions and charge correlation.

## Lifecycle and integrity

Lifecycle:

`CREATED -> CONSENTED -> PAYMENT_PENDING -> PAID -> PAYOUT_PENDING -> COMPLETE`

Lifecycle is historical and monotonic. Later refunds, disputes, canceled/failed payouts, or application-fee refunds do not erase the fact that an earlier lifecycle step occurred. They change current integrity through first-class exceptions and post-settlement review.

Integrity states:

- `INCOMPLETE`
- `ACCOUNTED`
- `NEEDS_ATTENTION`

`ACCOUNTED` requires all of the following, not merely a successful charge:

- lifecycle is `COMPLETE`;
- consent exists and the accepted terms hash matches the exact stored terms snapshot;
- payment status is successful;
- recorded customer-paid amount equals the transaction amount;
- expected integrity application fee was collected when applicable;
- expected merchant net equals actual merchant net;
- required Stripe PaymentIntent, Charge, Balance Transaction, and Payout IDs are present;
- the transaction is linked/accounted to a Stripe payout and that payout is `paid`;
- no unresolved exception exists;
- no adverse post-settlement condition currently requires review.

Refunds and application-fee refunds deliberately fail closed into review until explicit economics/reconciliation policy is defined. Lost or unclassified dispute outcomes require review. For a given Stripe dispute, the latest closure is authoritative; `won` and `warning_closed` are treated as favorable, while another distinct lost dispute still keeps the transaction under review.

Only one OPEN exception of a given type may exist for a transaction. The D1 uniqueness rule is the final concurrency guard, and application code converges on the canonical row if simultaneous Workers race to create the same exception.

## Runtime error behavior

Expected client/auth errors may return useful 4xx messages. Unexpected server/database/provider failures are logged internally but public/API callers receive a generic 5xx `Internal error` response so backend implementation details are not exposed.

Async route handlers are awaited inside the runtime error boundary so rejected promises cannot bypass this sanitization.

## Watchdogs and readiness

The watchdog/readiness system uses one shared stage-requirement definition. Unknown stages fail closed.

Readiness requires, as appropriate for the current stage:

- D1 reachable;
- current schema/migrations and required triggers/indexes present;
- required Stripe, Clerk, Turnstile, Resend, domain and stage configuration present;
- a recent healthy watchdog run.

Watchdogs cover failed/stuck webhook receipts, payout reconciliation conditions, merchant Stripe capability state, expected/unexpected fee conditions, and operational alerting. A later successful watchdog run resolves the prior watchdog-runner failure alert instead of leaving a permanent false critical.

## Development simulator

With `DEV_MODE=true`, the internal console can simulate consent, Checkout, payment success/failure, payout success/failure, and dispute open/close without contacting Stripe or moving money.

The dispute simulator emits production-shaped dispute IDs and statuses so integrity tests do not validate a materially different model from production.

## Hard V1 boundaries

Do not represent these as supported without a new design review:

- merchant Stripe accounts already controlled by another incompatible read/write Connect platform;
- manual payouts when transaction-to-specific-payout reconciliation is promised;
- subscriptions;
- marketplaces;
- international rollout;
- currencies other than USD;
- raw card handling by Builtegrity;
- claims of fraud protection, chargeback protection, insurance, legal enforceability, or independently verified bank receipt.

## TEST -> PILOT -> LIVE deployment gate

A successful code deployment is not permission to process live customer money.

Before the first cloud TEST transaction:

- create/bind the Cloudflare Worker and production-shaped D1 database;
- apply migrations `0001` through `0012`;
- configure `builtegrity.com` and `admin.builtegrity.com` Worker routes/DNS as intended;
- configure Stripe **test-mode** Connect app, redirect URI, webhook endpoint/event subscriptions, pinned API version, and test credentials;
- configure Clerk test/production-shaped app, authorized parties/origins, and temporary operator allowlist;
- configure required Worker secrets;
- run the readiness endpoint and watchdogs;
- execute TX-0001-equivalent end to end using Stripe test mode: creation -> consent -> Checkout -> payment -> balance -> payout/reconciliation -> `ACCOUNTED`, plus failure/refund/dispute tests.

Before PILOT:

- set `WATCHDOG_STAGE=PILOT`;
- configure Turnstile site/secret and approved Builtegrity hostname(s);
- configure Resend sending domain/API key and alert addresses;
- replace owner-only authorization with D1-backed merchant membership/roles before multiple independent merchants are admitted;
- establish backup/export and outage-recovery procedures;
- review merchant agreement, Privacy Notice, Terms, fee disclosure, refund-fee treatment, and the exact customer-facing definition of transaction integrity/`ACCOUNTED`.

Before LIVE:

- complete a controlled pilot with real operational reconciliation;
- switch to approved live Stripe credentials/configuration only after all readiness checks pass;
- verify external provider dashboards and webhook delivery in the live environment;
- verify monitoring/alert delivery actually reaches an operator;
- perform a final live-mode low-risk transaction/reconciliation check under approved operating/legal procedures.

## External provisioning still requiring direct verification

The repository audit cannot prove the following control-plane state by itself and they remain deployment blockers until checked in the actual provider accounts:

- Cloudflare Worker deployment, D1 binding/database ID, DNS/routes, secrets, cron triggers and production migration state;
- Stripe Connect application settings, redirect URI, webhook endpoint/event subscriptions and live/test credentials;
- Clerk production application and authorized origins/parties;
- Turnstile site/secret and hostname configuration;
- Resend domain verification, API key and alert delivery;
- backups/exports and outage-recovery procedure;
- end-to-end TEST/PILOT runtime behavior after deployment.

Do not mark Builtegrity live-ready solely because GitHub CI is green.

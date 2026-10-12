# Builtegrity Transaction Engine — V1 Runbook

## Current architecture

The V1 runtime is a Cloudflare Worker with static assets plus a D1 database. Stripe remains the payment processor. Builtegrity stores transaction context, consent, normalized Stripe references, event history, exceptions, economics, and automatic-payout reconciliation.

Core hierarchy:

`Partner -> Merchant -> merchant-scoped Customer -> Purchase -> Transaction -> Events / Exceptions`

`PARTNER-0001` is the system-owned house channel for direct merchants.

## Local setup

1. Copy `wrangler.toml.example` to `wrangler.toml`.
2. Create a Cloudflare D1 database named `builtegrity-v1` and replace `REPLACE_AFTER_D1_CREATION` with its database ID.
3. Copy `.dev.vars.example` to `.dev.vars`.
4. Add Stripe **test-mode** values only:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_CONNECT_CLIENT_ID`
   - `INTERNAL_ADMIN_TOKEN`
5. Run `npm install`.
6. Run `npm run db:migrate:local`.
7. Run `npm run db:seed:local`.
8. Run `npm run dev`.
9. Open `/console/` for the internal console.
10. Open `/pay/?token=test-tx-0001-token` for the fake customer payment page.

## Stripe Connect onboarding

The V1 first-merchant path is for an existing Stripe merchant whose account is available for a read/write Connect OAuth connection.

The console calls:

`POST /api/merchants/:merchant_id/stripe/connect-url`

The Worker creates a one-time OAuth state token and returns the Stripe authorization URL. Stripe returns to:

`/api/stripe/oauth/callback`

The callback exchanges the code for the merchant's `stripe_user_id`, stores that `acct_...` ID on the merchant, and does **not** persist deprecated OAuth access tokens.

After connection, call:

`POST /api/merchants/:merchant_id/stripe/verify`

The verification response checks whether charges and payouts are enabled and whether Stripe exposes an automatic payout schedule. A merchant that uses manual payouts is not V1-compatible for transaction-to-payout reconciliation.

## Transaction creation

Internal endpoint:

`POST /api/transactions`

A transaction receives:

- a permanent internal `TX-....` ID;
- an unguessable public payment token;
- an immutable terms snapshot hash;
- a fee-earned value separate from the fee-collection method;
- an initial `TX_CREATED` event.

Public payment URLs use only the random token, never a guessable TX ID.

## Customer flow

1. Customer opens `/pay/?token=...`.
2. Builtegrity displays merchant, purchase context, amount, and the exact transaction terms.
3. Customer explicitly accepts the terms.
4. The Worker stores acceptance time, method, and SHA-256 hash of the exact terms snapshot.
5. Builtegrity creates Stripe Checkout on the connected account.
6. Card data is entered only into Stripe-hosted Checkout.
7. Browser return does not mark the payment successful; Stripe server-side events do.

## Stripe event handling

The webhook endpoint is:

`POST /api/webhooks/stripe`

It verifies the raw Stripe payload against `Stripe-Signature` and `STRIPE_WEBHOOK_SECRET` before processing.

Important events handled in V1:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `application_fee.created`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.closed`
- `payout.reconciliation_completed`
- `payout.paid`
- `payout.failed`

Webhook receipts are idempotent, and transaction events are append-only.

## Lifecycle

`CREATED -> CONSENTED -> PAYMENT_PENDING -> PAID -> PAYOUT_PENDING -> COMPLETE`

Lifecycle is historical and monotonic. A later dispute or payout failure does not rewrite the fact that the original payment previously completed. Instead, the current integrity state changes through first-class exceptions.

Integrity states:

- `INCOMPLETE`
- `ACCOUNTED`
- `NEEDS_ATTENTION`

`ACCOUNTED` currently requires consent, successful Stripe payment records, balance transaction, automatic-payout match, Stripe payout status `paid`, and zero unresolved exceptions.

## Development simulator

When `DEV_MODE=true`, the internal console can simulate:

- consent;
- Checkout creation;
- payment success;
- payout success;
- payment failure;
- dispute open/close;
- payout failure.

The simulator does not contact Stripe or move money. It is only for validating database behavior and UI states.

## Hard V1 boundaries

Do not treat these as supported without a new design review:

- merchants whose Stripe account is already controlled by another read/write Connect platform;
- manual Stripe payouts if transaction-to-specific-payout reconciliation is promised;
- subscriptions;
- marketplaces;
- international rollout;
- currencies other than USD;
- raw card handling by Builtegrity;
- claims of fraud protection, chargeback protection, insurance, legal enforceability, or independently verified bank receipt.

## Required production configuration

Before the first live payment:

- deploy the Worker under an HTTPS Builtegrity domain;
- create the production D1 database and apply migrations;
- set `DEV_MODE=false`;
- replace temporary internal-token access with production authentication before outside users receive console access;
- configure the Stripe Connect redirect URI exactly;
- configure the Stripe Connect webhook endpoint;
- use live-mode Stripe keys only after the production readiness gate is passed;
- establish backup/export and outage-recovery procedures;
- review merchant agreement, Privacy Notice, Terms, fee disclosure, refund-fee treatment, and the exact definition of `ACCOUNTED`.

No live customer payment should be processed merely because the code deploys successfully.

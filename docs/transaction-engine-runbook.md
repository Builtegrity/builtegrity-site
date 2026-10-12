# Builtegrity Transaction Engine — V1 Runbook

## Current architecture

The V1 runtime is a Cloudflare Worker with Static Assets plus a D1 database. The same Worker is the frontend/site and backend runtime; Cloudflare Pages is not a separate dependency. Stripe remains the payment processor. Clerk is the application identity/session provider. Resend is the transactional-email adapter, and Cloudflare Turnstile is the public-route abuse-protection adapter.

Builtegrity stores transaction context, consent, normalized Stripe references, event history, exceptions, economics, and automatic-payout reconciliation in D1.

Core hierarchy:

`Partner -> Merchant -> merchant-scoped Customer -> Purchase -> Transaction -> Events / Exceptions`

`PARTNER-0001` is the system-owned house channel for direct merchants.

Identity and authorization are deliberately separate: Clerk proves who the user is; Builtegrity/D1 decides which merchant, role, and records that identity can access.

## Local setup

1. Copy `wrangler.toml.example` to `wrangler.toml`.
2. Create a Cloudflare D1 database named `builtegrity-v1` and replace `REPLACE_AFTER_D1_CREATION` with its database ID.
3. Copy `.dev.vars.example` to `.dev.vars`.
4. Add Stripe **test-mode** values only:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_CONNECT_CLIENT_ID`
5. Add the Clerk development/test application values from the owner-controlled Clerk application:
   - `CLERK_JWT_KEY`
   - `CLERK_ISSUER`
   - `CLERK_PUBLISHABLE_KEY`
   - `CLERK_AUTHORIZED_PARTIES`
   - `CLERK_ADMIN_USER_IDS`
   - `CLERK_SIGN_IN_URL`
   - `CLERK_USER_URL`
6. Resend and Turnstile values are optional until their pilot integration pass; never commit their secrets.
7. Run `npm install`.
8. Run `npm run db:migrate:local`.
9. Run `npm run db:seed:local`.
10. Run `npm run dev`.
11. Open `/console/` for the internal console.
12. Open `/pay/?token=test-tx-0001-token` for the fake customer payment page.

No persistent `INTERNAL_ADMIN_TOKEN` is configured. The runtime creates a one-request in-memory bridge value only after application authentication succeeds.

## Application authentication

Primary V1 provider: Clerk.

- `/login/` hands interactive sign-in to the configured Clerk Account Portal.
- the Worker verifies the Clerk JWT/session signature and issuer before allowing authenticated application access;
- `CLERK_AUTHORIZED_PARTIES` restricts approved application origins/parties where applicable;
- `CLERK_ADMIN_USER_IDS` is the temporary pre-multi-tenant owner/operator allowlist;
- merchant membership and role authorization must move into D1 before real merchant multi-tenancy.

Cloudflare Access remains an optional defense-in-depth adapter for infrastructure/internal surfaces. It is not the primary product identity system.

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

Turnstile may be added to appropriate public pre-payment or abuse-sensitive actions. It must never replace customer consent, authentication, or Stripe webhook verification.

## Stripe event handling

The webhook endpoint is:

`POST /api/webhooks/stripe`

It verifies the raw Stripe payload against `Stripe-Signature` and `STRIPE_WEBHOOK_SECRET` before processing. Turnstile and Clerk must not sit in front of the Stripe webhook route.

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

## Transactional email

Resend is an outbound notification adapter only. A failed confirmation/alert email must never rewrite or block payment truth, transaction lifecycle, or payout reconciliation.

Initial intended messages:

- customer payment/transaction confirmation;
- merchant payment confirmation;
- exception / needs-attention alert;
- selected operational notifications.

Use a Builtegrity-owned Resend setup and sending domain. Store `RESEND_API_KEY` only in the Cloudflare Worker secret store.

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

- deploy the Worker + Static Assets under HTTPS Builtegrity domain(s);
- create the production D1 database and apply migrations;
- set `DEV_MODE=false`;
- configure Clerk production application/authorized origins and D1-backed tenant authorization before merchant multi-tenancy;
- configure the Stripe Connect redirect URI exactly;
- configure the Stripe Connect webhook endpoint;
- store Stripe, Resend, Turnstile and other secrets only in Cloudflare/provider secret stores;
- configure a Builtegrity-owned Resend sending domain before depending on transactional email;
- add Turnstile only to appropriate public surfaces;
- use live-mode Stripe keys only after the production readiness gate is passed;
- establish backup/export and outage-recovery procedures;
- review merchant agreement, Privacy Notice, Terms, fee disclosure, refund-fee treatment, and the exact definition of `ACCOUNTED`.

No live customer payment should be processed merely because the code deploys successfully.

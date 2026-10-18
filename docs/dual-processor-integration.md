
# Dual processor integration (Stripe + Square) — preview / not live-authorized

Builtegrity has a single merchant → customer → purchase → transaction → immutable events model.
A merchant may authorize both processors. Each transaction selects `transaction.processor` (STRIPE or SQUARE) **once**, at creation. It must never be rerouted after checkout.
Existing Stripe Connect flows and financial responsibility checks are preserved.

## Square setup

1. Create a Square developer app (Sandbox first). Register the OAuth callback URL `https://builtegrity.com/api/square/oauth/callback`.
2. Set `SQUARE_ENV=sandbox`, `SQUARE_APP_ID`, `SQUARE_APP_SECRET`, and 32-byte `SQUARE_TOKEN_ENCRYPTION_KEY_B64` as documented in .dev.vars.example. Secrets belong in Worker secret storage.
3. Register `https://builtegrity.com/api/webhooks/square` as the webhook notification URL, subscribe to `payment.created`, `payment.updated`, `payout.paid`, `payout.failed`, `payout.sent`, `refund.created` and `refund.updated`, and store the subscription signature key as `SQUARE_WEBHOOK_SIGNATURE_KEY`. Set `SQUARE_WEBHOOK_NOTIFICATION_URL` to the **exact** registered URL (including scheme/path) for cryptographic validation.
4. Apply D1 migrations 0063 and 0064 in test. Authenticate as operator to call `POST /api/merchants/MER-xxxx/square/connect-url`, visit returned OAuth URL, and after callback invoke `POST /api/merchants/MER-xxxx/square/verify`.
5. `GET /api/merchants/MER-xxxx/processors` returns public connection metadata (not credentials). Use `POST /api/merchants/MER-xxxx/square/disconnect` to revoke and erase local encrypted tokens.
6. Enable `SQUARE_PAYMENT_LINKS_ENABLED=true` **only for the controlled Sandbox exercises**. Production also requires `SQUARE_LIVE_ENABLED=true`; leave false until real fee reversals, legal controls, cross-provider CI, reconciliation and live authorization are verified. Daily paid-payout recovery is independently gated by `SQUARE_RECONCILIATION_ENABLED=true` and limited to five connected sellers per daily run and at most 60 recent payouts each.
7. A Square-hosted checkout is blocked unless the locked merchant/state refund handler is `PRO_RATA_APP_FEE`, because Square seller-initiated refunds automatically return developer fees pro rata. This is a deliberate release constraint, not a backend error.

## Transaction creation

The authenticated transaction creation route accepts `transaction.processor='SQUARE'`, or defaults to the merchant's existing provider selection. A Square connection must exist. The existing customer-facing `/pay/?token=...` route records agreement and jurisdiction before creating a **Square-hosted checkout** containing the amount and `checkout_options.app_fee_money`. The Square checkout request carries a stable transaction-based idempotency key. The alternative Stripe route continues to use direct charges and `application_fee_amount`.

The stored fee method for Square is `OTHER` as a transitional legacy schema enum, disambiguated by `processor='SQUARE'`. Migration 0064 extends the existing Stripe-only protection/revenue trigger to support Square: a payment may reach `PROTECTED` only after matching the processor-reported gross application fee, locked checkout amount and original legal evidence. The shared entitlement/carry/actual-cash ledger is triggered only after that match. Square refunds update current collected cash without rewriting the immutable original gross fee.

The Square webhook verifies the HMAC over exact registered URL + raw body, stores idempotent delivery receipts, retrieves payment facts from Square, and matches payment orders only to merchant-scoped Builtegrity checkouts. Payouts are only marked accounted after individual CHARGE payout entries are linked to known payments. Unmatched or absent payout entries must remain incomplete.

## Mandatory release gaps before accepting Square live money

- The shared protection classifier and cash ledger now recognize verified Square application fees in migration 0064; full accounting/tax/statement model review using real Square Sandbox fee samples remains mandatory.
- Square seller-initiated refunds automatically return developer fees proportionally. The runtime blocks incompatible locked refund handlers before checkout; verified completed refunds are recorded by immutable per-refund ID, reconciled against that proportional rule, and exceptions raised for mismatches. Provider/bank fee reversals must still be tested with real Sandbox data.
- Confirm `type_charge_details.payment_id`, `net_amount_money` and paginated payout entry handling against real Square Sandbox responses. Durable payout-entry facts replay when the matching payment arrives later. The scheduled daily DEEP watchdog also supports bounded paid-payout recovery, but it remains disabled until sandbox validation.
- Audit Stripe legacy processor defaults and all financial watchdog/tax/statement reports for mixed-provider merchants.
- Concurrency, chargeback, recurring payments, duplicated webhook, OAuth reconnection and outage tests; audit app fee limits and API permissions.
- Counsel/provider approval and explicit owner go-live approval. Keep `SQUARE_LIVE_ENABLED=false` until the above are completed.

Do not claim a Square payment is universally monitored if it originated outside the Builtegrity checkout flow. Other Square payments can be read with permission but **cannot automatically earn Builtegrity's fee** under the checkout-link model.

Official technical references: https://developer.squareup.com/docs/payments-api/take-payments-and-collect-fees and https://developer.squareup.com/docs/webhooks/step3validate

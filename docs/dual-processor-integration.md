
# Dual processor integration (Stripe + Square) — preview / not live-authorized

Builtegrity has a single merchant → customer → purchase → transaction → immutable events model.
A merchant may authorize both processors. Each transaction selects `transaction.processor` (STRIPE or SQUARE) **once**, at creation. It must never be rerouted after checkout.
Existing Stripe Connect flows and financial responsibility checks are preserved.

## Square setup

1. Create a Square developer app (Sandbox first). Register the OAuth callback URL `https://builtegrity.com/api/square/oauth/callback`.
2. Set `SQUARE_ENV=sandbox`, `SQUARE_APP_ID`, `SQUARE_APP_SECRET`, and 32-byte `SQUARE_TOKEN_ENCRYPTION_KEY_B64` as documented in .dev.vars.example. Secrets belong in Worker secret storage.
3. Register `https://builtegrity.com/api/webhooks/square` as the webhook notification URL, subscribe to `payment.created`, `payment.updated`, `payout.paid`, `payout.failed`, `payout.sent`, `refund.created` and `refund.updated`, and store the subscription signature key as `SQUARE_WEBHOOK_SIGNATURE_KEY`. Set `SQUARE_WEBHOOK_NOTIFICATION_URL` to the **exact** registered URL (including scheme/path) for cryptographic validation.
4. Apply D1 migration 0063 in test. Authenticate as operator to call `POST /api/merchants/MER-xxxx/square/connect-url`, visit returned OAuth URL, and after callback invoke `POST /api/merchants/MER-xxxx/square/verify`.
5. `GET /api/merchants/MER-xxxx/processors` returns public connection metadata (not credentials). Use `POST /api/merchants/MER-xxxx/square/disconnect` to revoke and erase local encrypted tokens.
6. When Sandbox sign-offs pass, explicitly set `SQUARE_PAYMENT_LINKS_ENABLED=true`. Production also requires `SQUARE_LIVE_ENABLED=true`; leave false until fee reversals, legal controls, cross-provider CI, reconciliation and live authorization are verified.

## Transaction creation

The authenticated transaction creation route accepts `transaction.processor='SQUARE'`, or defaults to the merchant's existing provider selection. A Square connection must exist. The existing customer-facing `/pay/?token=...` route records agreement and jurisdiction before creating a **Square-hosted checkout** containing the amount and `checkout_options.app_fee_money`. The Square checkout request carries a stable transaction-based idempotency key. The alternative Stripe route continues to use direct charges and `application_fee_amount`.

The stored fee method for Square is `OTHER` until the existing Stripe-only protection/revenue SQL classifier and financial/tax reports receive an audited generalization. **Square fee money must not be reported as PROTECTED revenue just because Square reported the payment completed.** The adapter stores observed amounts independently in `processor_app_fee_*_cents`.

The Square webhook verifies the HMAC over exact registered URL + raw body, stores idempotent delivery receipts, retrieves payment facts from Square, and matches payment orders only to merchant-scoped Builtegrity checkouts. Payouts are only marked accounted after individual CHARGE payout entries are linked to known payments. Unmatched or absent payout entries must remain incomplete.

## Mandatory release gaps before accepting Square live money

- Generalize SQL protection classifier + ledger revenue recognition (Stripe-only today) to audited Square-specific fee confirmation.
- Implement Square fee refund/reversal automation consistent with locked merchant/state policy; refund webhooks currently create an exception for review and do not refund the application fee automatically.
- Confirm Square payout-entry payment ID field mapping on real Sandbox fixtures and test pagination/error handling.
- Audit Stripe legacy processor defaults and all financial watchdog/tax/statement reports for mixed-provider merchants.
- Concurrency, chargeback, recurring payments, duplicated webhook, OAuth reconnection and outage tests; audit app fee limits and API permissions.
- Counsel/provider approval and explicit owner go-live approval. Keep `SQUARE_LIVE_ENABLED=false` until the above are completed.

Do not claim a Square payment is universally monitored if it originated outside the Builtegrity checkout flow. Other Square payments can be read with permission but **cannot automatically earn Builtegrity's fee** under the checkout-link model.

Official technical references: https://developer.squareup.com/docs/payments-api/take-payments-and-collect-fees and https://developer.squareup.com/docs/webhooks/step3validate

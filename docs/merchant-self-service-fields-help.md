# Builtegrity: merchant self-service field integrations and Help

## The merchant's first three clicks

From `/merchant/` the signed-in merchant can reach:
1. **My transactions** → newest-first live transaction detail → PDF icon in the expanded transaction.
2. **My customers & groups** → set up or view grouped customer/transaction histories.
3. **My connections** → bank setup and custom field source health, with specific self-repair actions.
4. **Help & requests** → plain-English guidance and a request form for unsupported software.

All merchant-facing pages require authenticated Clerk membership for the returned data. Unrecognized identities do not see another merchant's data. The homepage remains a text-first, high-contrast, large-touch-target design; the future black/neon-green theme is intentionally **not** implemented here.

## Defining fields

Customer or transaction fields must be defined by the merchant owner. The owner can set each active field to **Manual** or **Automatic**. An Automatic field must reference one active `WEBHOOK`, `DATABASE_PUSH` or `APP_PUSH` source owned by that merchant. A raw uploaded file is not a live source.

A configured data source can send records to `POST /api/sync/merchant-fields/SYNC-...` with a private Bearer key. The records are linked by merchant-native customer or payment references. All revisions remain append-only. Updates delivered by a source not selected for an Automatic field are rejected. Field values are not allowed to overwrite canonical Stripe/Square financial data.

**Important:** No API can guarantee that an unrelated merchant CRM or database publishes new values at the exact time Stripe/Square publishes new transactions. Builtegrity updates customer/transaction views and PDFs after receiving the merchant's authorized data feed, while independent processor webhooks and integrity checks continue. Customer-level fields already associated with the customer appear on all linked transactions, including a new transaction immediately upon creation of its canonical record. A source that never sends events requires an adapter/relay or manual entry.

### Sender health, and heartbeats

A private source can send `POST /api/sync/merchant-fields/SYNC-.../heartbeat` using the same Bearer key. The source's heartbeat time and last accepted field update time are separate. No new field value should be inferred from a heartbeat.

* No heartbeat or update yet: `AWAITING_FIRST_DELIVERY`.
* Source reachable or data received: `CONNECTED` (not a promise of up-to-the-second data).
* Source revoked/disconnected: `ACTION_REQUIRED`.
* Last delivery failed: `SOURCE_ERROR`.
* Manually managed field: `MANUAL`.

The owner can inspect these states from `/merchant/integrations/` and switch to manual entry or replace the source without asking Builtegrity staff to edit the database.

## Bank reconnection

Bank linking remains opt-in and gated. A signed-in owner can reauthorize through Plaid Link when the bank requires renewed consent. The setup page explains bank timing, pending vs posted bank deposits, and the lack of irreversible-settlement guarantees. Payment processor monitoring remains independent if bank permission expires. Staff never need the merchant's bank login.

## Unsupported connector requests

`/merchant/help/` provides a plain-language setup guide and a merchant owner submission form with software name, request category, field titles and desired workflow. `/api/merchant/help/submit` records a tenant-scoped ticket, rate-limited to five per merchant per day. The portal can show prior tickets. Request forms reject obvious private keys and secrets; **no raw support attachments** are accepted. Raw authorized data belongs in the merchant import mechanism, not the Help mailbox.

The ten-minute scheduled dispatcher can email requests to a verified support inbox using Resend **only when**
`MERCHANT_HELP_EMAILS_ENABLED="true"` and `RESEND_API_KEY`,
`MERCHANT_HELP_EMAIL_FROM`, and `MERCHANT_HELP_EMAIL_TO` are configured. A submission initially shows "saved / email delivery pending"; it must never falsely show email sent before the provider accepts it. Outbound requests use an idempotency key. The owner retains control of email settings. Unsupported third-party connectors may still require bespoke software work; this is the exception, not a routine integration-support dependency.

## Deployment requirements

1. Apply migration `0070_custom_field_auto_sync_and_merchant_help.sql` to the same production D1 as the app after previous migrations.
2. Deploy the Worker including `public/merchant/` assets.
3. Confirm verified Clerk merchant owner membership and authorized merchant TX visibility.
4. Complete sandbox/synthetic flow: source key, webhook event, matching customer/payment reference, field appears in expanded transaction and printable merchant PDF.
5. Leave `CUSTOM_SYNC_ENABLED="false"` until secure sender integration tests and abuse controls are validated. Existing manual imports remain available.
6. Configure verified Resend sender and recipient mailbox only when support delivery is ready, then enable `MERCHANT_HELP_EMAILS_ENABLED="true"`. Until then ticket storage works but email does not transmit.
7. Do not enable optional bank access until Plaid onboarding, consent and bank payout matching have been tested with real provider data.

No change to the site's global color scheme is included in this release.

# Merchant-themed transaction delivery (launch gate)

## Behavior
- Source of truth remains the canonical transaction and refund evidence tables.
- Dashboard theme is the existing `merchant_dashboard_appearance` template.
- Merchant options are independent: light PDF accent, customer transaction email delivery, themed customer email.
- All new options default to OFF and are scoped to the merchant.
- Email is clearly sent on behalf of the merchant from a Builtegrity-controlled, verified sending domain.
- Customer emails supplement processor receipts (not a claim to replace Stripe or Square receipts).
- New customer emails begin only after the merchant opts in, never retroactively.
- Public payment links do not grant authenticated merchant PDF privileges.
- Customer emails do not include merchant access links, private PDF URLs, API keys, card details, or transaction-event raw data.
- Successful refunds are independent notices with stable event references, not replay of initial payment confirmations.

## Deployment order
1. Review and merge PR only after CI succeeds.
2. Apply D1 migration `0076_merchant_delivery_preferences.sql` to the correct production database before deployment.
3. Deploy Worker and public merchant dashboard assets.
4. Verify sender domain ownership and SPF/DKIM in Resend; configure `RESEND_API_KEY` and `CUSTOMER_TRANSACTION_EMAIL_FROM` as secrets/config.
5. Leave `CUSTOMER_TRANSACTION_EMAILS_ENABLED` unset/false until permission, suppression, live data, and test receipt review are complete.
6. With a sandbox/test merchant only: verify off-by-default, cross-merchant access denial, authenticated PDF download, theme changes, historical transaction suppression, payment and refund delivery, retries, deduplication, and opt-out after queued delivery.
7. Enable live sends explicitly with `CUSTOMER_TRANSACTION_EMAILS_ENABLED=true` after the go-live review.

## Additional operational constraints
- A `CLAIMED` delivery left in place after a worker crash is intentionally not automatically retried: examine delivery provider logs before retrying to prevent accidental duplicate sends.
- Validate matching customer email and confirmed processor state server-side before each delivery.
- Protect merchant branding, delivery settings, and account access with Clerk membership and role checks.
- Do not treat these transaction emails as marketing consent or include promotional content.
- Customer support, bounced address handling, suppression list and monitoring must be completed before production enablement.
- Do not use this subsystem as a guarantee of settlement or payment finality.

# Builtegrity company-books automation

## Goal

Builtegrity's transaction ledger knows protected-payment economics, but it is not a complete general ledger. Tax calculation needs the whole business: revenue, refunds, partner shares, operating expenses, payroll, cash, liabilities, assets, equity and owner activity.

The company-books layer therefore uses **QuickBooks Online as the complete accounting source** and keeps the Builtegrity transaction-economics ledger as an independent revenue-integrity source.

The design is intentionally read-only toward QuickBooks in V1. Builtegrity reads accounting data and reports; it does not silently create journal entries, expenses, deposits or sales receipts that could duplicate bank-feed/accountant entries.

## One-time setup

1. Create an Intuit Developer application with QuickBooks Online Accounting access.
2. Register the production redirect URI:
   `https://admin.builtegrity.com/api/accounting/quickbooks/callback`
3. Configure `QUICKBOOKS_CLIENT_ID`.
4. Store `QUICKBOOKS_CLIENT_SECRET` as a Cloudflare Worker secret.
5. Generate 32 random bytes, base64 encode them, and store the value as the Worker secret `ACCOUNTING_TOKEN_ENCRYPTION_KEY_B64`.
6. From the authenticated Builtegrity admin surface, request `/api/accounting/quickbooks/connect-url` and complete the one-time Intuit authorization.
7. After the first account sync, select/map the QuickBooks income account used for Builtegrity transaction/application-fee revenue.
8. Confirm once that all Builtegrity business financial accounts that belong in the books are actually represented in QuickBooks.

No raw QuickBooks OAuth tokens are stored in plaintext. Access and refresh tokens are AES-GCM encrypted in D1. Each refresh persists the newest rotating refresh token.

## Automated cycle

The existing Builtegrity scheduled Worker invokes the tax-workpaper pipeline. That pipeline now invokes company-books synchronization first.

The accounting API is internally throttled; the 15-minute Worker schedule does **not** call QuickBooks every 15 minutes. A successful books sync is reused for up to six hours, while the tax-readiness freshness threshold defaults to 26 hours.

A normal sync:

1. refreshes QuickBooks OAuth if the access token is close to expiry;
2. reads company identity and chart of accounts;
3. reads Profit & Loss and Balance Sheet reports;
4. stores normalized accounting metrics in D1;
5. stores the raw report JSON in R2 when the bucket is available, with a SHA-256 hash;
6. preserves report snapshots as immutable evidence;
7. checks that the balance sheet parses and balances;
8. verifies at least one active bank account exists in the QuickBooks chart;
9. compares Builtegrity's ACTUAL application-fee economics with the mapped QuickBooks fee-income account;
10. updates the company-books readiness state;
11. automatically promotes/demotes the company tax profile's accounting readiness.

## Settlement lag

Cash-basis books can lag transaction activity because processor funds settle and reach a bank later than the customer payment. The current settled YTD health check therefore defaults to a seven-day settlement lag.

The lag is configurable from 0–31 days. It prevents the current books-health check from treating still-settling processor activity as an accounting failure.

Quarterly and yearly tax workpapers still require an exact-period reconciliation. If the accounting recognition timing or categorization causes an exact-period mismatch, Builtegrity fails closed and does not generate a tax-ready workpaper until the mismatch is resolved.

## Books state machine

`NOT_CONNECTED`
: QuickBooks has not been connected or was intentionally disconnected.

`REAUTH_REQUIRED`
: OAuth refresh can no longer continue and the owner must reconnect QuickBooks.

`STALE`
: the latest successful accounting sync is older than the configured freshness window.

`INCOMPLETE`
: required accounting evidence is missing, all business accounts have not been confirmed, a bank account is absent, or reports cannot be validated.

`MAPPING_REQUIRED`
: the Builtegrity fee-income account has not been mapped or cannot be found in the P&L.

`MISMATCH`
: mapped QuickBooks fee income differs from Builtegrity ACTUAL fee economics beyond the configured tolerance.

`COMPLETE_VERIFIED`
: current settled YTD accounting evidence is fresh, structurally complete, all-business-account confirmation exists, the mapped fee income reconciles, and the balance sheet validates.

Only `COMPLETE_VERIFIED` can promote `builtegrity_tax_profile.accounting_data_status` to `COMPLETE_VERIFIED`. Any later books-state degradation immediately demotes the tax profile back to `PARTIAL`.

## Tax workpapers

A Builtegrity quarterly/yearly tax workpaper is not allowed to rely only on the transaction ledger anymore.

When the legal/tax profile and current books are calculation-ready, the workpaper engine obtains an exact-period QuickBooks P&L and Balance Sheet, requires the period reconciliation to pass, and stores:

- QuickBooks P&L snapshot ID;
- QuickBooks Balance Sheet snapshot ID;
- accounting method;
- book net income;
- total income and expenses;
- assets, liabilities and equity;
- Builtegrity transaction-economics revenue/adjustment/partner-share/cost evidence;
- exact accounting reconciliation ID.

**Book net income is the accounting starting point, not final taxable income.** Depreciation, nondeductible items, credits, elections, carryovers, entity-specific adjustments, owner-level income and safe-harbor calculations belong to the tax-calculation/provider layer that follows the books layer.

## Admin endpoints

- `POST /api/accounting/quickbooks/connect-url`
- `GET /api/accounting/quickbooks/callback`
- `POST /api/accounting/quickbooks/disconnect`
- `GET /api/accounting/status`
- `POST /api/accounting/sync`
- `POST /api/accounting/settings`

All endpoints are on the authenticated admin surface. The OAuth callback also uses a short-lived, single-use state token.

## Operational principle

The target is not to make Builtegrity its own unreviewed accountant. The target is to remove routine owner bookkeeping work while preserving independent evidence and fail-closed controls:

**Stripe transaction truth → QuickBooks complete books → Builtegrity reconciliation → tax workpaper → approved tax calculation/filing provider.**

# Transaction economics, identity boundaries, and record PDFs

These are production architecture invariants for the Builtegrity transaction-integrity system.

## 1. Clerk is identity only

Clerk answers **who is this authenticated application user?**

Builtegrity/D1 answers **which merchant, partner, role, permissions, and records may that user access?**

Do not make Clerk Organizations the merchant hierarchy, tenancy store, or authorization source. The existing `merchant_access` and `partner_access` tables are the Builtegrity-owned authorization layer. This keeps merchant count from creating avoidable identity-provider organization costs and keeps the product portable to another identity provider later.

A consumer does not need a Clerk account simply to pay or view their own transaction record. Public transaction access uses an unguessable Builtegrity-owned record token. Never expose internal economics through that public record route.

## 2. The Builtegrity fee is merchant-paid

`transactions.fee_payer` is constrained to `MERCHANT`.

For Stripe Connect V1, the transaction remains a direct charge on the connected merchant account and Builtegrity's revenue is collected through `application_fee_amount`. Do not convert the V1 flow into a consumer surcharge and do not make Builtegrity the merchant's payment processor merely to collect the integrity fee.

The merchant-facing agreement and pricing UI must still disclose the Builtegrity fee clearly. "Merchant-paid" means it is deducted from merchant proceeds, not hidden from contractual disclosure.

## 3. Every transaction has hidden unit economics immediately

`transaction_economics_ledger` is internal-only and supports sub-cent precision using **micros**:

- `$1.00 = 1,000,000 micros`
- estimated fee revenue
- estimated core infrastructure
- estimated transaction-email budget
- estimated lifetime storage
- actual integrity-fee revenue when Stripe records the application fee
- adjustments
- future partner share
- PDF generation/cache-delivery costs
- future actual metered provider costs

Estimated and actual entries must never be mixed or mislabeled. `transaction_economics_summary` exposes estimated and actual contribution separately.

The current conservative cost model is stored in `transaction_cost_models`, not hard-coded into pricing logic. New models can be activated as real production measurements improve.

The migration trigger initializes economics automatically whenever a transaction is inserted, so the cost layer does not depend on a developer remembering to call an application helper.

## 4. PDFs are generated automatically on request

The canonical structured transaction record remains authoritative. PDFs are rendered views of that record.

Customer flow:

1. Customer holds an unguessable record token.
2. `GET /api/records/:token` returns the safe public transaction view.
3. `GET /api/records/:token/pdf` creates or retrieves the PDF automatically.
4. Each request is written to `transaction_pdf_requests`.
5. If `TRANSACTION_RECORDS` R2 is configured, generated PDFs are cached by transaction + record version.
6. A cache miss generates the PDF in the Worker; a cache hit returns the existing version.
7. No owner/operator action is required.

Operator flow:

`GET /api/transactions/:txId/pdf` requires application authentication and generates the same transaction-record PDF automatically.

The public PDF must not expose the hidden economics ledger.

## 5. Security boundaries

- Public payment/record tokens are high-entropy and unguessable.
- Clerk sessions are not required for consumer record access.
- Clerk identity does not determine Stripe webhook authenticity.
- D1 owns tenancy/authorization.
- Stripe webhooks remain signature-authenticated.
- Internal transaction economics are available only through authenticated internal transaction APIs/console surfaces.
- PDF generation is deterministic from the canonical record and does not permit arbitrary HTML/URL rendering.

## 6. Cost measurement rule

The economics layer should get more accurate over time, not merely more optimistic.

Provider invoices/usage should eventually feed actual cost entries for:

- Worker request/CPU usage
- D1 reads/writes/storage
- R2 operations/storage
- Resend messages
- PDF cache/storage operations
- authentication expense allocation
- monitoring/observability
- refunds/credits
- partner revenue share
- support expense allocation where useful

Until an amount is supported by actual metering or an invoice allocation, store it as `ESTIMATED`.

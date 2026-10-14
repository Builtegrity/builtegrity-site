# Transaction economics, identity boundaries, and record PDFs

These are production architecture invariants for the Builtegrity transaction-integrity system.

## 1. Clerk is identity only

Clerk answers **who is this authenticated application user?**

Builtegrity/D1 answers **which merchant, partner, role, permissions, and records may that user access?**

Do not make Clerk Organizations the merchant hierarchy, tenancy store, or authorization source. Builtegrity-owned access tables remain the authorization layer so the product can scale without unnecessary identity-provider organization coupling and can later replace the identity provider without replacing business records.

A consumer does not need a Clerk account merely to pay or view their own safe transaction record. Public record access uses an unguessable Builtegrity-owned token and never exposes internal economics.

## 2. The Builtegrity Platform Fee is merchant-side economics

`transactions.fee_payer` is constrained to `MERCHANT`.

For Stripe Connect V1, the customer purchase remains a direct charge on the connected merchant account. Builtegrity collects the disclosed Platform Fee using the application-fee mechanism. Do not turn V1 into a consumer surcharge and do not make Builtegrity the merchant's processor merely to collect the Platform Fee.

Merchant-side economics still require clear contractual disclosure/acceptance.

## 3. Protection and accounting are different axes

`PROTECTED` is the record/revenue classification that can create Builtegrity transaction-fee revenue. `ACCOUNTED` is an integrity/completeness state.

`OBSERVED` and `IMPORTED` can be accounted/reconciled without becoming PROTECTED and without creating protected transaction-fee revenue.

Economics, statements, books, and tax workpapers must use record classification—not payment success or ACCOUNTED status—to decide whether a transaction belongs to protected revenue/volume.

## 4. Exact fee entitlement, cash, and carry are separate facts

Never collapse these into one field or one label:

1. **Exact transaction-fee entitlement** — the fee attributable to this transaction, represented in micros (`integrity_fee_earned_micros` / locked pricing evidence).
2. **Gross application-fee cash** — the processor-confirmed whole-cent application fee attached to the payment. It may include prior carry.
3. **Current retained fee cash** — gross application-fee cash less later application-fee refunds/credits.
4. **Current residual generated** — the sub-cent part of this transaction's exact entitlement.
5. **Prior carry settled** — whole cents of previously accrued residual collected on this later successful protected payment.

A later payment that settles prior carry is collecting prior entitlement. It must not create a second entitlement entry or be described as though the later transaction earned that extra amount.

The merchant carry ledger is a settlement bridge between exact internal entitlement and processor whole-cent collection. It is not a separate subscription/billing system.

## 5. Transaction economics ledger

`transaction_economics_ledger` is internal-only and supports sub-cent precision using micros:

- `$1.00 = 1,000,000 micros`;
- estimated fee revenue/economic target;
- estimated infrastructure/email/storage/support cost;
- actual application-fee cash revenue when processor evidence is recorded;
- actual adjustments/refunds/credits;
- future partner share;
- future actual metered provider costs.

Estimated and actual entries must never be mixed or mislabeled. Actual books reconciliation follows the ACTUAL economics/adjustment evidence rather than re-deriving revenue from a statement label.

The current conservative cost model lives in `transaction_cost_models` and financial-safety policy. It is not hidden inside merchant pricing logic and must be refreshed as provider invoices/usage become known.

## 6. Revenue timing and fractional entitlement

The exact fee target can exist before processor settlement, but LIVE reporting must be explicit about the basis:

- **entitlement/attribution basis** — exact fee assigned to the protected service event;
- **cash/processor basis** — whole-cent application-fee cash actually processor-confirmed;
- **adjustment basis** — later fee refund/credit or other approved correction.

Fractional residuals can accrue in the carry ledger after the relevant successful payment event. They do not become a second transaction's entitlement when later settled.

Company books and external accounting integrations should use actual cash/adjustment evidence according to the approved accounting policy. Product analytics may also show exact entitlement, but must label it as such.

## 7. Record PDFs

The canonical structured transaction record remains authoritative. PDFs are rendered views.

Customer flow:

1. customer holds a high-entropy record token;
2. `GET /api/records/:token` returns the safe public view;
3. `GET /api/records/:token/pdf` creates/retrieves the PDF automatically;
4. requests are audited;
5. R2 caches durable rendered artifacts by transaction/record version;
6. cache misses render in the Worker;
7. no routine owner action is required.

Operator PDF access remains authenticated. Public PDFs must not expose the hidden economics ledger, partner economics, legal-response secrets, provider secrets, or other internal-only data.

## 8. Security boundaries

- Public payment/record tokens are high entropy.
- Clerk session identity is independent of webhook authenticity.
- D1 owns tenant authorization.
- Stripe webhooks are signature-authenticated.
- Internal economics are available only through authorized internal surfaces.
- PDF generation is deterministic from canonical records rather than arbitrary HTML/URL rendering.
- Immutable/append-oriented evidence is corrected through later events/adjustments, not silent rewrites.

## 9. Cost measurement rule

The economics layer should become more accurate over time, not merely more optimistic.

Provider invoices/usage should eventually feed actual cost entries/allocations for Worker CPU/requests, D1, R2, email, authentication, observability, refunds/credits, partner share, and support burden.

Until a number is supported by actual metering/invoice allocation, store it as `ESTIMATED`.

## 10. Canonical consistency rule

`ops/system-contract.json`, pricing/protection migrations, runtime economics, statements, financial safety, books, tax summaries, and merchant-facing legal disclosures must describe compatible facts.

`npm run system:coherence` exists specifically to stop drift between those layers before it reaches LIVE.

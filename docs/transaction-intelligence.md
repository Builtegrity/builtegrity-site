# Builtegrity Transaction Intelligence

## Core rule

Builtegrity is transaction infrastructure, not a configurable accounting spreadsheet and not a feature-tier SaaS product.

Every merchant uses the same canonical transaction spine. Merchant preferences may change presentation, alerting, and materiality thresholds. They may **not** disable fact capture, reconciliation, retention, or historical truth.

> Capture everything available. Understand what it means. Let the merchant choose what they want to see.

## Canonical graph

A protected transaction is more than a payment amount. Builtegrity models the relationship among:

- merchant / location / customer
- purchase or order
- line items
- payment
- taxes
- tips and gratuities
- discounts and credits
- merchant-added charges
- processor fees
- platform / marketplace / delivery fees
- Builtegrity fee
- partner economics
- refunds
- disputes and recoveries
- reserves and holds
- financing
- fulfillment
- payout contribution
- receipt and other evidence
- processor/provider objects such as PaymentIntent, Charge, Payout, Order or future Square/Toast/Clover equivalents

Provider objects are normalized independently and linked many-to-many to transactions. A single payout can therefore account for many transactions without duplicating the payout itself.

## Merchant Transaction Profile

Each merchant automatically receives one `merchant_transaction_profiles` record.

Connected sources are registered in `merchant_transaction_sources`. Examples include Stripe, Square, POS systems, marketplaces, e-commerce platforms, accounting systems and fulfillment systems.

As transaction facts arrive, Builtegrity automatically activates the relevant modules and component types for that merchant. The merchant does not construct a custom schema manually.

Profiles move through:

- `LEARNING` — no connected transaction source has been established yet.
- `ACTIVE` — normal discovery is operating.
- `REVIEW_REQUIRED` — at least one unknown recurring component requires classification.

When the last unresolved classification is confirmed, the profile automatically returns to `ACTIVE`.

## Modules

Modules are infrastructure capabilities, not subscription plans. They include:

- Core payment
- Order itemization
- Tax
- Gratuity
- Discounts
- Merchant-added charges
- Processor economics
- Platform economics
- Builtegrity economics
- Partner economics
- Refunds
- Disputes
- Payouts
- Currency / FX
- Reserves / holds
- Government obligations
- Labor obligations
- Franchise obligations
- Fulfillment
- Stored value
- Financing
- Adjustments
- Evidence
- Merchant-specific components
- Unknown components

Core payment, Builtegrity economics and payout modules are mandatory. Other modules activate automatically when Builtegrity observes relevant facts.

A merchant can set a module or component to `SHOW`, `SUMMARY`, or `HIDE`, and can tune alert behavior. Hiding a component only affects the merchant-facing stream. The canonical component remains stored and available to reconciliation.

## Universal transaction components

`transaction_components` is the append-only financial/contextual fact stream.

Each component contains a standard type plus enough metadata to remain processor-independent:

- transaction and purchase
- merchant
- component type
- parent component when applicable
- scope: order / transaction / payment / payout / fulfillment / merchant
- basis: expected / actual / observed
- direction: inflow / outflow / neutral
- beneficiary
- amount / currency
- quantity / unit amount / rate when available
- original source label
- source system and source reference
- classification confidence
- status
- metadata
- observed timestamp

Components are append-only. Corrections are new facts, not silent edits to history.

The seeded registry covers common sale values, taxes, gratuities, discounts, merchant fees, processing fees, marketplace fees, Builtegrity fees, partner shares, refunds, disputes, FX, reserves, statutory obligations, employee commissions, franchise fees, fulfillment costs, gift cards/store credit, financing and reconciliation adjustments.

The registry is intentionally extensible. The system does not claim that a finite seed list can anticipate every fee humans will invent.

## Unknown-component rule

Unknown does not mean discard.

If an adapter encounters a component that is not explicitly mapped and does not match a high-confidence learned rule or heuristic:

1. Builtegrity records it as `UNKNOWN_OTHER`.
2. The merchant profile becomes `REVIEW_REQUIRED`.
3. A `merchant_component_rules` record is created with `NEEDS_REVIEW`.
4. The raw provider label and amount remain attached to the transaction.
5. A merchant/operator classifies the recurring source key once.
6. Future occurrences automatically inherit the confirmed classification.
7. The historical unknown record remains unchanged, preserving the actual history of what Builtegrity knew at that time.

This creates discovery-driven infrastructure without allowing arbitrary merchant schemas to fragment the platform.

## Evidence and receipts

`transaction_artifacts` links receipts and other evidence directly to the transaction and purchase.

Supported evidence categories include receipt, order, invoice, contract, terms, fulfillment, proof of delivery, refund receipt, dispute evidence, payout statement, tax document and other.

Artifacts are append-only. Builtegrity should prefer structured canonical facts over storing a PDF/image for every transaction. When a provider supplies a hosted receipt URL or stable source reference, Builtegrity can link it. When a document must be preserved, R2/object storage and hashes can be used by the adapter/evidence layer.

Receipt discovery automatically activates the merchant's Evidence module.

### Coffee-shop example

A POS adapter can emit:

- `SALE_LINE_ITEM`: Large latte, quantity 1, $5.25
- `SALE_LINE_ITEM`: Blueberry muffin, quantity 1, $4.00
- `ORDER_SUBTOTAL`: $9.25
- `SALES_TAX`: $0.74
- `EMPLOYEE_TIP`: $2.00
- `GROSS_PAYMENT`: $11.99
- `PROCESSOR_FEE`: provider-reported fee
- `MERCHANT_PAYOUT`: transaction contribution to payout
- `RECEIPT` artifact: provider receipt reference/URL

The cashier does nothing differently. The adapter translates POS/provider events into the common Builtegrity graph.

### Contractor example

The same graph can emit:

- line item/service description
- deposit payment
- taxes where applicable
- financing fee where applicable
- Builtegrity Integrity Fee
- contract/terms artifact
- customer consent event
- balance payment
- processor fee
- merchant payout

Same infrastructure, different observed facts.

## Provider adapter contract

Every future adapter should do only four things:

1. Register the connected source and its capabilities.
2. Convert provider-native financial facts into `observeTransactionComponent()` calls.
3. Convert provider-native documents/receipts into `linkTransactionArtifact()` calls.
4. Link provider-native objects through `recordTransactionSourceObject()`.

Stripe is the first adapter projection. Future Square, Toast, Clover, Shopify or other integrations should reuse the same functions rather than create processor-specific transaction schemas.

## Stripe projection

After the existing Stripe webhook processor updates canonical transaction state, `stripe-intelligence.js` projects provider events into the graph.

It links Checkout Sessions, PaymentIntents, Charges, Balance Transactions, Application Fees, Disputes and Payouts. Provider-hosted receipts are attached as `RECEIPT` artifacts when available. Refund deltas and dispute principal/recovery facts become transaction components.

Projection failures do not intentionally fail an otherwise successfully processed payment webhook. Projection is designed to be idempotent and replayable so transaction movement is never held hostage by an auxiliary intelligence write.

## API surface

Authenticated internal/operator routes currently expose the model until the merchant portal consumes the same service layer:

- `GET /api/merchants/:merchant/transaction-profile`
- `POST /api/merchants/:merchant/transaction-profile/preferences`
- `POST /api/merchants/:merchant/transaction-profile/rules/:rule/confirm`
- `GET /api/transactions/:transaction/graph`
- `POST /api/transactions/:transaction/components`
- `POST /api/transactions/:transaction/artifacts`
- `POST /api/transactions/:transaction/source-objects`

Merchant-facing authorization should later route through the existing D1 tenancy/membership model. It must not weaken the invariant that preferences are presentation-only.

## Permanent invariants

1. The canonical component stream cannot be disabled per merchant.
2. Historical components, artifacts and provider-object links are append-only.
3. Merchant display preferences never alter accounting truth.
4. Unknown provider facts are captured before classification.
5. A recurring unknown can be taught once and learned for future transactions.
6. Provider-native objects do not become Builtegrity's data model; adapters normalize them.
7. A provider object can relate to multiple transactions.
8. Structured facts are canonical; generated documents are views/evidence, not the primary database.
9. The economics ledger and transaction-component graph are different layers: the economics ledger measures Builtegrity's own unit economics; transaction components describe the merchant/customer money flow and obligations.
10. The goal is automatic discovery after connection, with merchant review only when the machine genuinely cannot determine meaning safely.

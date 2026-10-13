# Tax-Season Readiness

## Product position

Builtegrity should make January easier without becoming the merchant's tax preparer or tax-form filer.

The merchant-facing artifact is the **Year-End Payment Activity Summary**. It is an informational reconciliation record generated from Builtegrity's canonical transaction history and Stripe processor truth. It is **not** a tax return, Form 1099, determination of taxable income, or tax advice.

V1 protected-payment merchants are deliberately restricted to the Stripe Standard connected-account lane. The product assumption is that Stripe remains the expected 1099-K filer for eligible Standard accounts. Express, Custom, Unified/other, or unknown configurations require review and must not silently enter the protected-payment lane.

## Permanent accounting rules

1. **Gross stays gross.** Gross payment volume is the full customer payment amount. Do not subtract Stripe fees, Builtegrity fees, refunds, disputes, or other adjustments from the gross line.
2. **Tax-year placement follows processor availability.** Stripe `balance_transaction.available_on`, not Checkout creation time, invoice date, payment-link date, or payout date, determines the Stripe-style tax-year reconciliation bucket.
3. **Refunds are separate facts.** A later customer refund never rewrites the original successful charge. Refunds are stored as append-only financial adjustments.
4. **Builtegrity fee refunds are separate facts.** `application_fee_gross_confirmed_cents` preserves the fee that existed when protection was confirmed. `integrity_fee_collected_cents` reflects current retained fee cash after later fee refunds.
5. **PROTECTED is historical truth.** Once a payment is validly confirmed PROTECTED, a later refund does not turn it into OBSERVED, IMPORTED, or FEE_EXCEPTION.
6. **No invented reconciliation.** Missing `available_on`, unknown fee composition, unresolved payout accounting, or unresolved exceptions cause the year-end summary to be marked `NEEDS_REVIEW` rather than silently estimated.
7. **No raw tax IDs for this feature.** Builtegrity does not collect or store merchant SSNs, EINs, or TINs in the transaction database merely to generate the Year-End Payment Activity Summary. Stripe remains the tax-identity system of record unless a future reviewed legal obligation changes this design.
8. **Tax thresholds are advisory metadata.** Federal reference thresholds are versioned in `tax_rule_versions`; state thresholds and special filer rules may differ and are never inferred from a federal row.

## 2026 reference rules captured in the database

The 2026 federal TPSO Form 1099-K reference is stored as greater than $20,000 in gross payments **and** more than 200 transactions. This reference is informational only and does not drive filing automation.

A separate 2026 $2,000 general 1099-NEC/MISC reference is stored only as a future warning for partner/vendor compensation design. Before Builtegrity pays partner revenue shares at scale, partner identity, compensation accruals, actual payments, reversals, and tax treatment need a dedicated reviewed ledger.

## Transaction facts preserved for year-end reconciliation

For each supported Stripe transaction Builtegrity preserves, when available:

- transaction ID and record classification
- successful-payment timestamp
- Stripe Balance Transaction ID
- Stripe `available_on` timestamp
- gross customer payment
- Stripe processor-fee detail and its provenance
- gross Builtegrity application fee confirmed by Stripe
- current retained Builtegrity application-fee cash
- cumulative customer refunds
- cumulative Builtegrity application-fee refunds
- payout linkage and reconciliation status
- append-only refund and financial-adjustment events

## Merchant year-end summary

Each generated summary is versioned and immutable. A corrected summary is a new version, never an overwrite.

The summary includes:

- successful charge count
- gross payment volume
- protected / observed / imported counts
- customer refunds shown separately
- processor fees shown separately
- Builtegrity gross transaction fees shown separately
- Builtegrity fee refunds shown separately
- observed merchant net proceeds
- payout-reconciliation exceptions
- missing Available-On records
- fee-breakdown uncertainty
- open transaction exceptions
- Stripe account type and tax-form responsibility snapshot

The generated artifact must say plainly that it is a payment-activity/reconciliation summary and not a tax return or 1099.

## Builtegrity's own books

Builtegrity's company revenue is not merchant gross payment volume. Year-end company revenue is derived from ACTUAL entries in `transaction_economics_ledger`:

- actual Builtegrity application-fee revenue
- actual fee reversals/adjustments
- actual partner-share expense when that system exists
- actual company costs when recorded

This keeps merchant tax reconciliation and Builtegrity's own accounting separate.

## Partner compensation before launch

Partners are never billed by Builtegrity. If Builtegrity later pays partners a share of transaction economics, add an append-only partner-compensation ledger before activating payouts. It should snapshot at minimum:

- partner ID and legal-payee reference
- source transaction(s)
- amount accrued
- amount actually paid
- payment date and payment rail
- reversals/chargebacks/adjustments
- tax-form responsibility status

Do not infer that a partner needs a specific tax form solely from an amount threshold. Entity type, payment method, exemptions, federal rules, and state rules require reviewed tax logic.

## Future enhancements

Before calling the tax-season experience complete:

1. import/refetch Stripe balance transactions for year-end reconciliation, including refund/dispute balance-transaction timing;
2. compare Builtegrity's annual summary against Stripe's downloadable tax/reconciliation reports and flag mismatches;
3. render the Year-End Payment Activity Summary to merchant-facing PDF/CSV;
4. automatically generate the prior year's summary in January only after the reconciliation health checks pass;
5. add state-specific advisory metadata only from reviewed, versioned authoritative sources;
6. add partner compensation reporting only after the partner payout ledger and tax-responsibility model are implemented and reviewed.

## Design intent

Tax season is a retention feature, not a compliance land grab. The value proposition is that a merchant who used Builtegrity all year should reach January with a clean, transaction-by-transaction record of what was paid, what was refunded, what Stripe charged, what Builtegrity charged, and how each payment reconciled — without Builtegrity pretending to replace Stripe, the merchant's accountant, or tax authorities.

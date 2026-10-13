# Transaction protection classification

This document defines the production record-classification contract for Builtegrity transactions.

## Product invariant

Builtegrity does not separately bill merchants or partners. There are no setup fees, subscriptions, monthly platform bills, usage invoices, or partner charges in the protected-payment model.

Builtegrity earns transaction revenue only from a successful payment routed through the Builtegrity protected-payment flow when the exact Builtegrity application fee is confirmed by the processor.

The transaction record and the Builtegrity transaction fee are therefore linked pieces of processor truth. A record may exist without revenue, but revenue may not be recognized unless the record qualifies as `PROTECTED`.

## Merchant-facing record classes

### PROTECTED

A transaction is `PROTECTED` only when all of the following are true:

1. The payment was created/routed through the Builtegrity protected-payment flow.
2. The processor reports the payment as `succeeded`.
3. The transaction uses `STRIPE_APPLICATION_FEE` as its Builtegrity fee collection method.
4. Stripe exposes an application-fee ID for the charge.
5. The collected Builtegrity fee is greater than zero.
6. The collected Builtegrity fee exactly equals the server-locked fee calculated when the transaction was created.

Only after all six conditions are true may the system:

- classify the record as `PROTECTED`;
- populate `bg_fee_earned_cents`;
- set `protection_confirmed_at`;
- recognize actual Builtegrity integrity-fee revenue in the economics ledger.

Payment success by itself is not enough.

### OBSERVED

`OBSERVED` means Builtegrity detected or monitored a processor transaction but did not create/control its payment flow and did not collect a Builtegrity application fee from that payment.

Observed records may still contain processor facts, customer/payment context, events, reconciliation data, and other useful documentation. They do not create Builtegrity transaction revenue and `bg_fee_earned_cents` must remain zero.

A Stripe Marketplace/account-observation feature may create or enrich `OBSERVED` records without implying that the underlying payment was Builtegrity-protected.

### IMPORTED

`IMPORTED` means historical or externally supplied transaction data was brought into Builtegrity after the fact.

Imported records are archival/reference records. They may be useful for history, analysis, merchant reporting, or migration into the Builtegrity record system, but they are not retroactively protected and do not create Builtegrity transaction revenue. `bg_fee_earned_cents` must remain zero.

## Internal operational states

### PENDING_PROTECTED

A newly created Builtegrity payment begins as `PENDING_PROTECTED`.

This means Builtegrity intends to create a protected transaction and has locked the expected fee, but processor truth has not yet confirmed both payment success and exact fee collection.

`PENDING_PROTECTED` is internal operational state, not a merchant-facing claim that the transaction is already protected.

### FEE_EXCEPTION

A transaction becomes `FEE_EXCEPTION` when the payment succeeded but the required Builtegrity fee truth is missing or inconsistent, including:

- no Stripe application-fee ID on a successful protected-flow payment; or
- a positive collected application fee that does not equal the server-locked Builtegrity fee.

A `FEE_EXCEPTION` transaction must never be silently presented as `PROTECTED` and must not recognize Builtegrity transaction revenue. `bg_fee_earned_cents` remains zero until processor truth is corrected and all protection requirements are satisfied.

The internal console may surface `FEE_EXCEPTION` directly even though merchant-facing record classes remain `PROTECTED`, `OBSERVED`, and `IMPORTED`.

## Fee fields and their meanings

- `integrity_fee_earned_cents`: compatibility name for the server-calculated/locked Builtegrity fee expected on the transaction. Treat this as the planned fee, not recognized revenue.
- `integrity_fee_collected_cents`: processor cash truth for the application fee recorded by Stripe.
- `bg_fee_earned_cents`: recognized Builtegrity transaction revenue. This is zero unless the transaction is `PROTECTED`.
- `stripe_application_fee_id`: processor evidence tying the collected fee to Stripe's application-fee object.
- `protection_confirmed_at`: timestamp when the system had enough processor truth to confirm `PROTECTED`.
- `protection_failure_reason`: machine-readable/operator-readable reason a would-be protected payment did not qualify.

## State flow

Normal protected transaction:

`PENDING_PROTECTED -> payment succeeds -> application fee confirmed exactly -> PROTECTED`

Failed payment:

`PENDING_PROTECTED -> payment fails -> no Builtegrity revenue`

Fee failure:

`PENDING_PROTECTED -> payment succeeds -> fee missing/mismatched -> FEE_EXCEPTION`

If later processor truth confirms the exact required application fee:

`FEE_EXCEPTION -> PROTECTED`

Processor-observed payment:

`OBSERVED -> remains non-revenue unless a future, separately created payment goes through the protected flow`

Historical/external record:

`IMPORTED -> remains archival/non-revenue`

Do not mutate an `OBSERVED` or `IMPORTED` historical record into `PROTECTED` merely because Builtegrity later begins protecting future payments for the same merchant/customer/purchase.

## Revenue recognition rule

Actual Builtegrity transaction revenue is recorded only when the record is `PROTECTED` and `bg_fee_earned_cents` is positive.

The economics ledger must not treat raw `integrity_fee_collected_cents` movement as revenue on its own. Processor cash truth and product protection truth must agree first.

This prevents:

- successful payments without a Builtegrity fee from being counted as Builtegrity revenue;
- observed/imported transactions from inflating revenue;
- mismatched fees from being silently accepted;
- application-fee webhook timing from causing premature revenue recognition.

Negative processor fee adjustments remain economics adjustments rather than new revenue.

## Separate billing prohibition

Protected-flow states (`PENDING_PROTECTED`, `PROTECTED`, and `FEE_EXCEPTION`) must use `STRIPE_APPLICATION_FEE` in V1.

`AUTOMATIC_USAGE`, `PARTNER_SETTLEMENT`, or another after-the-fact billing mechanism may not be substituted as a way to recover a missed Builtegrity fee from a merchant or partner.

If Builtegrity cannot attach and confirm the fee inside the supported payment flow, the transaction cannot qualify as a revenue-producing protected transaction.

## Reporting rules

Merchant and partner reporting must keep the classes separate. At minimum reports should be able to distinguish:

- protected transaction count and protected payment volume;
- observed transaction count and observed payment volume;
- imported transaction count and imported historical volume;
- fee-exception count;
- actual Builtegrity fee revenue from `bg_fee_earned_cents` / actual economics entries.

A merchant may receive value from observed/imported records, but those records must never be represented as paid Builtegrity protection.

## Database enforcement

Migration `0025_transaction_protection_classification.sql` enforces the contract at the D1 layer. Application code and future processor integrations should treat those database constraints as product invariants rather than UI conventions.

Future processors may use a processor-specific equivalent of Stripe application fees, but they must preserve the same semantic rule: successful protected payment plus confirmed in-transaction Builtegrity fee before `PROTECTED` or recognized Builtegrity transaction revenue.

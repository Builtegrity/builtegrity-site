# Transaction Integrity Engine — V1 Draft

This directory is the first implementation skeleton for the transaction-integrity product being developed under the temporary Builtegrity launch shell.

It intentionally does **not** replace the existing public roofing site yet.

## Core hierarchy

Every merchant has exactly one parent Partner record.

- `PARTNER-0001` = Builtegrity Direct / house channel
- External referral or distribution partners receive their own Partner IDs
- A customer is scoped to one merchant; there is no global cross-merchant customer identity
- A customer can have many purchases
- A purchase can have many transactions
- Each transaction is the center of its own integrity record
- Each transaction can have many immutable events
- Each transaction can have zero or many exceptions

```text
Partner
  -> Merchant
      -> Customer
          -> Purchase
              -> Transaction
                  -> Transaction Events
                  -> Transaction Exceptions
                  -> Processor / consent / economics / payout fields
```

## Seed transaction

`seed-tx-0001.sql` creates the agreed first fake test hierarchy:

```text
PARTNER-0001 — Builtegrity Direct
  MER-0001 — ABC Cabinetry
    CUST-0001 — John Smith
      PUR-0001 — JOB-1048 / $4,000 custom kitchen cabinetry
        TX-0001 — $1,200 deposit
```

TX-0001 begins as:

- lifecycle: `CREATED`
- integrity: `INCOMPLETE`
- exception status: `NONE`
- test integrity fee earned: 25 cents
- fee collection method: `STRIPE_APPLICATION_FEE`
- customer consent: not yet accepted
- Stripe financial identifiers: not yet populated

## Deliberate V1 boundaries

The schema separates concepts that must not be conflated:

1. Lifecycle state is separate from integrity state.
2. Exceptions are separate records, not replacement lifecycle states.
3. Fee earned is separate from fee collection method.
4. Processor records are attached to a Builtegrity transaction rather than defining the transaction itself.
5. Transaction events are append-only so the historical story cannot be silently rewritten.
6. `COMPLETE` is a current lifecycle state, not a guarantee that a later refund, dispute, adjustment, or payout failure cannot occur.
7. `ACCOUNTED` replaces the earlier `PROTECTED` language. It describes record completeness, not insurance, fraud protection, chargeback protection, or legal enforceability.

## Files

- `schema.sql` — relational schema designed to be compatible with SQLite / Cloudflare D1
- `seed-tx-0001.sql` — seed data for the first fake transaction
- `definitions.json` — shared lifecycle, integrity, integration, fee and event vocabulary

## Next implementation step

The next milestone is an internal transaction console that reads these records and renders TX-0001 as one complete transaction story. After that, Stripe test mode is connected so TX-0001 can advance automatically from `CREATED` through payment and payout events.

# Builtegrity Internal Case Engine

## Principle

Humans may operate the machine. Humans may not become part of the normal transaction workflow.

The escalation order is fixed:

1. Normal transaction path.
2. Known exception detected.
3. Automatic repair/reconciliation.
4. If the merchant can safely resolve it, route it back to the merchant and wait for processor state to confirm the fix.
5. Only Builtegrity-owned failures become an `internal_case`.
6. Every internal case exposes at most three human actions.
7. After an operator action, the watchdog re-runs and the machine verifies whether the condition actually cleared.
8. Unknown exceptions are engineering defects: fix once, then add a permanent typed rule and regression test.

## Three layers

- `transaction_exceptions`: abnormal state on a transaction.
- `system_alerts`: machine-detected operational condition.
- `internal_cases`: automation has exhausted safe recovery and the remaining action belongs to Builtegrity, not the merchant.

`system_alerts.resolution_owner` is one of `SYSTEM`, `MERCHANT`, or `INTERNAL`.

## Merchant-owned conditions

These must not create ordinary Builtegrity support work:

- Stripe KYC/requirements remediation.
- Stripe connection reauthorization.
- Merchant payout/bank remediation.
- Normal payout delay where merchant/Stripe action is required.

`account.updated` and `account.application.deauthorized` are processed at the runtime webhook boundary. Merchant Stripe readiness is written to D1 and merchant action alerts are created with `merchant_action_code` such as `RESOLVE_WITH_STRIPE` or `RECONNECT_STRIPE`.

A merchant in `PAUSED` state is never automatically reactivated by an account update; this preserves an operator/security pause. A merchant in `TEST` can automatically return to `ACTIVE` when Stripe confirms charges, payouts, and automatic payout scheduling are compatible.

## Internal case catalog

V1 contains a finite catalog:

- `WEBHOOK_IRRECOVERABLE`
- `PROCESSOR_RECORD_MISMATCH`
- `FEE_RECONCILIATION_FAILURE`
- `PLATFORM_FINANCIAL_MISMATCH`
- `SECURITY_INCIDENT`
- `DATA_INTEGRITY_FAILURE`
- `EVIDENCE_RECOVERY_FAILURE`
- `PLATFORM_PROVIDER_ACTION_REQUIRED`
- `LEGAL_REGULATORY_REQUEST`
- `MERCHANT_OWNERSHIP_DISPUTE`
- `FRAUD_ABUSE_REVIEW`
- `UNKNOWN_EXCEPTION`
- `CATASTROPHIC_INCIDENT`

The database rejects a fourth enabled human action for any case type.

## Case action audit

`internal_case_action_runs` records:

- case and action
- operator identity
- success/failure
- bounded input/output
- measured human seconds
- start/finish timestamps

A finished action run is append-only.

The console measures approximate handling time from opening a case until an operator presses an action. This feeds the economics layer without pretending that technical compute cost is the whole cost of a transaction.

## Catastrophic controls

`platform_controls` owns three global switches:

- transaction creation
- payment creation
- merchant onboarding

A `CATASTROPHIC_INCIDENT` can turn all three off through the audited `ACTIVATE_KILL_SWITCH` action. Runtime enforces the controls before new transactions, Stripe Checkout creation, or Connect onboarding proceeds.

Resume is a separate audited action: `RESUME_AFTER_VERIFY`.

## Legal holds

`record_holds` allows an authorized internal case to place a preservation hold on a transaction, merchant, or other subject. Future deletion/retention jobs must refuse to destroy data with an active hold.

## Core operational metrics

`internal_operations_metrics` exposes:

- total transactions
- human-touched transactions
- human touch rate
- total human seconds
- human minutes per 1,000 transactions
- unknown-exception count

Target direction:

- human touch rate trends toward `<0.01%`
- unknown exceptions trend toward zero
- human minutes per 1,000 TX trends downward as runbooks become automated

These metrics are internal and must never be exposed to customers.

## Required Stripe webhook events

Production Stripe webhook configuration must include the transaction events already used by the transaction engine plus:

- `account.updated`
- `account.application.deauthorized`

Those account-level events are required to keep merchant remediation out of the internal human queue.

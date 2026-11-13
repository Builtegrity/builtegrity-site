# Builtegrity Impact — launch-gated merchant benefit

Status: infrastructure only; no payments or provider integration is enabled.

## Objective
Merchants may voluntarily set a percentage (basis points) or a flat amount per
successful transaction for a cause: reforestation, carbon removal or community
relief. Builtegrity's existing transaction fee model, price engine, checkout,
application fees, billing records and revenue recognition remain unchanged.

Impact contributions are **not Builtegrity revenue**. No donation fee, platform
take rate or new merchant charge exists here.

## Safe activation
1. Review the separate Impact migration 0076 and the approved charitable
   promotion / commercial co-venture terms with counsel as appropriate.
2. Deploy the feature branch through normal PR review and required CI.
3. Apply D1 migrations before enabling Impact reconciliation.
4. Set IMPACT_RECONCILIATION_ENABLED="true" only once the migration is applied.
5. Review permission tests, idempotency, refund semantics and staging traffic.
6. Do **not** claim any tree planted / contribution donated until provider
   integration is authorized and an external receipt has been verified.

Merchant API is Clerk-authenticated and tenant-scoped:
- GET /api/merchant/impact/merchants — active memberships only.
- GET /api/merchant/impact?merchant_id=MER-... — VIEWER or higher.
- PUT /api/merchant/impact — ADMIN/OWNER; same-origin; explicitly enabled bool.
- GET /api/merchant/impact/ledger?merchant_id=MER-... — VIEWER or higher.

Merchant page: /merchant/impact/. The initial setting is OFF.
Changes start a new immutable policy period, so past payments are not opted in.
Refund snapshots are append-only and uniquely keyed by transaction plus the
processor's cumulative refunded cents. The largest cumulative-refund snapshot
is authoritative; an old replay cannot inflate a contribution estimate.

Reconciliation reads paid USD transactions after the effective policy timestamp,
requires actual customer-paid confirmation and records non-billable estimates in
separate Impact tables. Funding receipts are a future provider-only pathway;
there is deliberately no merchant endpoint that can mark a donation funded.
The dashboard must clearly distinguish tracked commitments from verified
external funding.

## Limitations and required next phase
- No customer round-up or customer checkout donation handling.
- No automatic debits, merchant payout deductions or third-party API charges.
- No public "verified impact" badge until provider receipt validation is built.
- Processor chargeback/dispute adjustments require an additional reviewed
  policy before funds can be remitted.
- Reconciler is bounded and cron-driven, not synchronous with checkout events.
- Provider onboarding, fund custody, tax receipting, disbursement and
  jurisdictional marketing requirements are separate launch gates.

Run test suite with: node --test tests/merchant-impact.test.mjs

# Financial Safety Covenant

Builtegrity must never continue expanding through a known or measurable financial danger state without the machine applying a brake and making the condition explicit.

This is stronger than a profitability dashboard. Financial safety is part of transaction authorization.

No software can guarantee that a company can never fail. Unknown litigation, fraud, tax exposure, regulatory action, contractual liabilities, banking failure, or other external events can create losses outside the transaction engine. The covenant is therefore precise:

> **Builtegrity must not silently scale, onboard merchants, create new protected transactions, or create processor payments while its own available evidence says doing so is financially unsafe. Unknown or stale financial evidence is not treated as green.**

## Independent safety layers

The system protects against four different failure classes so one blind spot cannot silently sink the business.

### 1. Unit economics

PRICE-V1 already carries conservative planning reserves. The financial safety engine consumes `pricing_floor_health` and requires the lowest-fee transaction to remain contribution-positive with at least a 50% planning margin under the configured reserves.

If the floor contribution reaches zero or its planning margin falls below the safety threshold, the state is RED and onboarding, new transaction creation, and new payment creation are blocked.

Human operations are also bounded. A human-touch rate at or above 0.15% is ORANGE; at or above 0.20% it is RED. These thresholds are deliberately below the modeled five-cent floor break-even rate.

### 2. Processor responsibility and processor cash exposure

Stripe Connect merchants are not allowed to become ACTIVE unless Stripe confirms both:

- processing-fee payer = `stripe`
- payment-loss liability = `stripe`

If either responsibility moves to `application`, the merchant is PAUSED. Unknown responsibility leaves the merchant in TEST. Transaction creation and checkout independently re-check the stored responsibility state, and database triggers reject an ACTIVE Stripe Connect merchant with unsafe responsibility.

The platform also records Stripe platform-balance snapshots from the Balance API:

- available balance
- pending balance
- Connect reserved balance

A negative platform available balance is RED and blocks onboarding, new transactions, and new payment creation. A non-zero Connect reserve is at least YELLOW so reserve pressure cannot remain invisible.

### 3. Company cash, commitments, and reserve runway

Until a bank/accounting connection supplies this information automatically, an authorized operator records an append-only complete financial-position snapshot. The snapshot explicitly includes:

- unrestricted cash
- restricted cash
- monthly fixed commitments
- liabilities due within 30 days
- statutory reserve requirement
- contingency reserve requirement
- interest-bearing debt
- personal-guarantee exposure
- overdue critical obligations

A manual snapshot must explicitly attest that those categories are complete. It expires after seven days. Missing or stale data becomes UNKNOWN and freezes new onboarding and new transaction creation.

The default operating reserve target is three months after near-term liabilities and required reserves:

`safe runway = (unrestricted cash - 30-day liabilities - statutory reserve - contingency reserve) / monthly fixed commitments`

Default states:

- 3+ months: GREEN if all other controls are healthy
- 2–3 months: YELLOW
- 1–2 months: ORANGE; freeze new merchant onboarding
- under 1 month or near-term liabilities exceed unrestricted cash: RED; freeze onboarding and new transaction creation

Low runway does not automatically kill an already-created profitable customer payment. If unit economics, processor telemetry, and processor responsibility remain safe, completing an existing payment can improve cash rather than worsen it. Hard-stop processor or unit-economic conditions still block payment creation.

### 4. Unknown and stale telemetry

`UNKNOWN` is not a softer version of GREEN.

The machine requires:

- a complete company financial-position snapshot no older than seven days
- a Stripe platform-balance snapshot no older than two hours
- a pricing/cost/provider responsibility review no older than 90 days
- a current financial-safety decision no older than 30 minutes during PILOT/LIVE

If the monitor itself stops running, the last GREEN decision expires. Production activity does not get unlimited permission from stale evidence.

## Debt and personal guarantees

The default policy forbids interest-bearing debt and personal guarantees. Either recorded exposure makes financial safety RED for new growth.

This is intentionally conservative. If the company ever decides to use leverage, changing that policy should be an explicit architecture/governance decision rather than an accidental operating condition.

## Machine states and brakes

| State | Meaning | Default machine response |
| --- | --- | --- |
| GREEN | Required data is fresh and all safety thresholds pass | Operate normally |
| YELLOW | Safety cushion is degrading but no immediate loss boundary is near | Continue, create warning, email operator |
| ORANGE | Growth would increase risk | Freeze specified growth actions; open internal finance case; email operator |
| RED | Known financial safety boundary breached | Apply hard brakes according to reason; open critical finance case; email operator |
| UNKNOWN | Required evidence is missing or stale | Fail closed for affected growth/payment actions; open finance case; email operator |

Every evaluation is stored in append-only `financial_safety_evaluations`. Current authorization state is kept in `financial_safety_state`.

## Non-silent alerting

`worker/src/financial-safety-monitor.js` converts machine state into persistent `system_alerts`:

- YELLOW -> `finance:solvency-warning`
- ORANGE / UNKNOWN / RED -> `finance:solvency-brake`

The brake alert routes to `FINANCIAL_SOLVENCY_RISK`, which has only three operator actions. The system also sends an out-of-band Resend email with state, reason codes, runway, reserve surplus, Stripe platform balance, unit margin, and observed human-touch rate. Alerts are deduplicated so an unresolved state can remind without flooding.

The correct resolution path is never “override the warning.” Correct the underlying financial input/economics, run a new evaluation, and allow the machine to clear the brake.

## Financial model expiry

Provider prices and processor responsibility semantics are not permanent facts. `financial_model_reviews` require both provider pricing and processor responsibility assumptions to be re-reviewed at least every 90 days. An expired review becomes UNKNOWN and freezes growth.

This prevents a vendor price increase or processor-policy change from remaining embedded forever in an old cost model.

## Production activation rule

Financial safety enforcement begins at PILOT by default. PILOT/LIVE require an enforced, fresh financial-safety evaluation before merchant onboarding, new transaction creation, or payment creation can proceed.

The repository implementation does not become production protection until migration `0018_financial_safety_engine.sql` and the corresponding Worker code are deployed to the production Cloudflare D1/Worker environment.

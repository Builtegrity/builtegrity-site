# Financial Safety Covenant

Builtegrity must never continue expanding through a known or measurable financial danger state without applying a machine brake and making the condition explicit.

No software can guarantee that a company can never fail. Unknown litigation, fraud, tax exposure, regulatory action, contractual liabilities, banking failure, or other external events can create losses outside the transaction engine. The enforceable covenant is:

> **Builtegrity must not silently scale, onboard merchants, create new protected transactions, or create processor payments while its own available evidence says doing so is financially unsafe. Unknown or stale financial evidence is not green.**

## Canonical thresholds

The current runtime guardrails, mirrored in `ops/system-contract.json`, are:

- minimum floor planning margin: **80%**;
- human-touch operating target: **0.01%** (100 ppm);
- mature target: **0.005%** (50 ppm);
- warning/orange threshold: **0.02%** (200 ppm);
- critical/red threshold: **0.05%** (500 ppm);
- Platform Fee reversal/credit reserve: **0.5%** (5,000 ppm);
- low-ticket effective-rate watch: **1.50%** (150 bps).

These are deliberately conservative. A documentation edit cannot relax them; runtime policy is authoritative and the system coherence gate checks that the documentation still reflects it.

## 1. Unit economics

`BG_STANDARD_V1` carries conservative planning reserves. The financial-safety engine consumes `pricing_floor_health` and requires the lowest-fee lane to remain contribution-positive with at least the configured 80% planning margin after technical cost, human-case reserve, and fee-reversal/credit reserve.

If the floor contribution reaches zero or its planning margin falls below the safety threshold, the state is RED and onboarding, new transaction creation, and new payment creation are blocked.

Human-touch pressure is intentionally constrained far below one percent because support labor is one of the easiest ways for a micro-fee infrastructure business to destroy its economics. At or above 0.02% the system enters the configured warning/orange region; at or above 0.05% it reaches the critical/red boundary.

## 2. Processor responsibility and cash exposure

Stripe Connect merchants may not become ACTIVE unless Stripe confirms the V1 processor-responsibility configuration required by the current runtime policy. If processing-fee payer or payment-loss liability moves into an unsafe platform-responsibility state, the merchant is paused or remains TEST according to the applicable gate.

The platform records Stripe platform-balance snapshots including available, pending, and Connect-reserved balances. A negative platform available balance is RED. Non-zero reserve pressure is at least a warning state so it cannot remain invisible.

Processor facts are never inferred from marketing copy or old assumptions. They are provider evidence with freshness requirements.

## 3. Company cash, commitments, and runway

During PILOT, until a bank/accounting connection supplies the required information automatically, an authorized operator can record an append-only complete financial-position snapshot covering unrestricted/restricted cash, monthly fixed commitments, near-term liabilities, required reserves, debt, guarantees, and overdue critical obligations.

A manual snapshot expires after seven days. Missing or stale information becomes UNKNOWN and freezes affected new growth.

**LIVE cannot rely on a manual or test financial snapshot.** LIVE requires a current `BANK`, `ACCOUNTING`, or `COMPOSITE` source under the financial-safety policy.

Default operating reserve target:

`safe runway = (unrestricted cash - 30-day liabilities - statutory reserve - contingency reserve) / monthly fixed commitments`

Default interpretation:

- 3+ months: GREEN if all other controls are healthy;
- 2–3 months: YELLOW;
- 1–2 months: ORANGE and freeze specified growth actions;
- under 1 month or near-term liabilities exceed unrestricted cash: RED.

Low runway does not automatically destroy an already-created profitable customer payment when completing it reduces rather than increases exposure. Hard processor, legal, security, compliance, or unit-economic stops still win.

## 4. Unknown and stale telemetry

`UNKNOWN` is not a softer version of GREEN.

Required freshness includes the configured company financial-position window, Stripe platform-balance window, pricing/provider-responsibility review window, and financial-safety decision window. In PILOT/LIVE, stale evidence expires authorization rather than granting indefinite permission from an old green state.

Before LIVE, an external observer must monitor readiness so a stopped Worker/cron cannot fail silently.

## Debt and personal guarantees

The default policy forbids interest-bearing debt and personal guarantees. Recorded exposure makes financial safety RED for new growth unless a future versioned governance decision explicitly changes that policy.

Leverage must never enter the system accidentally through an undocumented operational workaround.

## Machine states and brakes

| State | Meaning | Default machine response |
| --- | --- | --- |
| GREEN | Required evidence is fresh and thresholds pass | Operate normally |
| YELLOW | Cushion is degrading | Continue within policy, alert and monitor |
| ORANGE | Growth would materially increase risk | Freeze specified growth actions and route a finance case |
| RED | Known safety boundary breached | Apply hard brakes and route a critical finance case |
| UNKNOWN | Required evidence is missing/stale | Fail closed for affected actions and route a finance case |

Every evaluation is append-recorded in `financial_safety_evaluations`; current authorization lives in `financial_safety_state`.

## Non-silent resolution

Financial alerts are persistent and deduplicated. The correct path is not “override the warning.” Correct the underlying economics/evidence, run a fresh evaluation, and allow the machine to clear the brake.

Human escalation is an exception path, not a substitute for the machine fixing or containing the underlying condition.

## Provider/model expiry

Provider prices and processor-responsibility semantics are not permanent facts. Financial-model reviews expire and must be refreshed. Vendor or processor changes therefore cannot remain embedded forever in an old cost model.

## Cross-system rule

Financial safety does not stand alone. Legal/compliance, security, pricing, processor, books/tax, and owner-independence gates can independently stop an action even when financial safety is GREEN.

Conversely, a legally/compliance-ready transaction is not allowed to proceed if current financial evidence says the machine should brake.

## Production activation

Financial-safety enforcement begins at PILOT under the configured policy. LIVE additionally requires automated financial telemetry, externally monitored readiness, owner/provider independence, and the whole-system live gate:

`npm run system:gate:live`

Repository code becomes production protection only after the ordered D1 migrations and matching Worker code are deployed and verified in the production environment.

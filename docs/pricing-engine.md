# Builtegrity Pricing Engine

Builtegrity is transaction infrastructure, not a subscription-plan product. Pricing is therefore one deterministic infrastructure rule applied across merchants rather than Starter/Growth/Enterprise packages or manually negotiated per-account fee fields.

## PRICE-2026-10-V1

For USD protected payments:

- Percentage: **0.15% (15 basis points)**
- Minimum: **$0.05 per successful protected payment**
- Maximum: **$10.00 per successful protected payment**
- Setup fee: **$0**
- Monthly subscription: **$0**
- Failed payment: **no collected Builtegrity transaction fee**
- Fee payer: **merchant only**

Formula, in cents:

`fee = min(payment amount, $10.00 cap, max(5-cent floor, rounded 0.15% fee))`

Percentage calculations use half-up cent rounding. Examples:

| Payment | PRICE-V1 fee | Effective rate |
| ---: | ---: | ---: |
| $3 | $0.05 | 1.667% |
| $5 | $0.05 | 1.000% |
| $11 | $0.05 | 0.455% |
| $20 | $0.05 | 0.250% |
| $40 | $0.06 | 0.150% |
| $50 | $0.08 | 0.160% because 7.5 cents rounds half-up |
| $100 | $0.15 | 0.150% |
| $500 | $0.75 | 0.150% |
| $1,000 | $1.50 | 0.150% |
| $5,000 | $7.50 | 0.150% |
| $10,000 | $10.00 | 0.100% because of the cap |

The 5-cent floor is primarily relevant to transaction-dense, low-ticket commerce such as cafés and quick-service merchants. Higher-ticket merchants naturally price from the 15-basis-point rule until the $10 cap is reached.

## Why PRICE-V1 does not increase the minimum for high-volume merchants

A progressive 5/6/7/8-cent minimum at 25k / 100k / 500k monthly transaction thresholds was pressure-tested. It is intentionally **not active** in V1.

The arithmetic is profitable, but increasing the unit floor as a merchant becomes larger creates the wrong infrastructure incentive. A large, transaction-dense merchant is more likely to scrutinize basis points, and high-volume infrastructure buyers generally expect scale to improve or at least preserve their unit economics rather than make each unit more expensive.

The schema retains generic density-band capability for a future global pricing version, but PRICE-V1 uses `density_mode = FLAT` and has no active density bands.

Builtegrity still computes a **shadow** 5/6/7/8-cent density model from actual successful transactions. This lets the company learn what the abandoned schedule would have earned and what effective rate it would have created without charging merchants under that schedule. A density model should only become real through a new immutable global pricing version after observed merchant retention and willingness-to-pay evidence supports it.

## Server-owned pricing

Callers may not send or override:

- `integrity_fee_earned_cents`
- `fee_collection_method`
- pricing version
- percentage
- minimum
- maximum
- density band
- calculated fee
- pricing lock timestamp

`worker/src/pricing.js` loads the active global pricing version and calculates the fee. The transaction is inserted with the complete pricing snapshot. For Stripe Connect, the core engine selects `STRIPE_APPLICATION_FEE` itself.

This closes the prior architecture hole where a caller could submit its own Builtegrity fee amount.

## Immutable transaction pricing

Pricing is locked when the transaction is created, before a processor checkout is created. This is required because Stripe application fees must be known when the Builtegrity-created payment is created.

Every versioned transaction stores:

- `pricing_version_id`
- `pricing_percentage_bps`
- `pricing_minimum_cents`
- `pricing_maximum_cents`
- `pricing_density_band_id` when a future version uses one
- `pricing_calculated_cents`
- `pricing_locked_at`

Once locked, these fields and `integrity_fee_earned_cents` are immutable. A future PRICE-V2 therefore cannot silently reprice a transaction already created under PRICE-V1.

Historical transactions created before versioned pricing are labeled `PRICE-LEGACY-UNVERSIONED` without changing their original recorded fee.

## Longevity pressure test

The system carries a deliberately conservative planning reserve rather than relying only on the repository's much smaller observed/estimated technical COGS model.

PRICE-V1 guardrails are:

- Technical lifecycle reserve: **$0.00617 per transaction**
- Outsourced human case reserve: **$15 per human-touched case**
- Planning human-touch rate: **0.05% (500 ppm)**
- Mature human-touch target: **0.01% (100 ppm)**
- Fee reversal/economic anomaly reserve: **2% of Builtegrity fee revenue**
- Human-touch warning: **0.10%**
- Human-touch critical: **0.15%**
- Merchant effective-rate watch threshold: **1.00% of protected volume**

At the lowest possible standard PRICE-V1 fee of five cents:

- Revenue: **$0.05000**
- Technical reserve: **$0.00617**
- Human reserve at 0.05% × $15: **$0.00750**
- 2% fee-reversal reserve: **$0.00100**
- Planning contribution: **$0.03533**
- Planning variable margin: **70.66%**

The five-cent floor therefore remains economically positive under the conservative operating target rather than only under a best-case automation assumption.

At a $15 outsourced-case cost, the theoretical human-touch break-even rate at the five-cent floor is about 0.286% before fixed/company overhead. At a harsher $20 case cost it is about 0.214%. Both are materially above the 0.05% planning target and the <0.01% mature target. The warning and critical thresholds are intentionally set below that economic cliff.

## Low-ticket commercial guardrail

Economic profitability alone is not enough. Five cents on a very small ticket can become a noticeable percentage of the merchant's sale. `merchant_pricing_monthly_summary` therefore measures each merchant's:

- successful protected transaction count
- protected volume
- earned and collected Builtegrity fees
- average ticket
- effective Builtegrity fee in basis points

The initial watch threshold is 100 bps (1.00%). This does not automatically create a special merchant price or plan. It is an evidence signal: if a material merchant segment consistently experiences an excessive effective rate, a future global pricing version can be redesigned from data instead of guesswork.

## Density pricing and concurrency

A future density-based price must not use an ad-hoc `COUNT(*)` at checkout. During payment bursts, simultaneous requests could otherwise receive the same ordinal or cross a threshold inconsistently.

The pricing code therefore refuses `BANDS` pricing unless it is given an explicit deterministic monthly ordinal. PRICE-V1 avoids this concurrency problem entirely because its floor is flat. A future global version must define and atomically allocate the usage metric before band pricing can be activated.

## Economics versus profit

The pricing guardrails are transaction-level planning economics, not net-profit claims. Company overhead remains separate, including sales/acquisition, legal, accounting, insurance, security/compliance, taxes, contractors, and other corporate costs.

The system should increasingly replace planning reserves with observed costs while retaining safety buffers. The goal is for Builtegrity to know the actual cost and contribution of its transaction infrastructure rather than rely on static assumptions forever.

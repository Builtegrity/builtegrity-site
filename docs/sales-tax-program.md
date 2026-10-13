# Builtegrity Sales-Tax / State Nexus Program

Status: PRE-LAUNCH — Rhode Island platform-fee tax method is a hard blocker.

## Rhode Island launch rule
Builtegrity is Rhode Island-based. Before live taxable Builtegrity fees are charged, the responsible tax/legal review must determine and document:

1. required RI sales-tax registration/permit;
2. taxability of Builtegrity's actual V1 platform/application-fee service;
3. sourcing/location rule used for the merchant/customer relationship;
4. whether the customer-facing/merchant-facing fee is tax-exclusive or tax-inclusive;
5. Stripe/application-fee mechanics used to collect any tax without confusing processor fee, Builtegrity revenue and tax liability;
6. bookkeeping accounts for taxable base, collected tax, credits/refunds and remittance;
7. return/payment cadence and evidence retention.

Current Rhode Island source: https://tax.ri.gov/tax-sections/sales-excise-taxes/sales-use-tax

Current RI guidance/rulings indicate vendor-hosted software can be taxable and transaction fees related to a software/platform service can be part of the taxable charge. Therefore production must not assume the application fee is entirely Builtegrity revenue.

## Accounting invariant
A tax amount collected for a taxing authority is not Builtegrity platform revenue. The production economics ledger must separately represent:
- Builtegrity pre-tax service/application fee;
- sales/use tax collected;
- tax refunds/credits;
- tax payable/remitted;
- Stripe/processor fee if relevant to tax treatment;
- net Builtegrity revenue.

Do not hide tax inside a processor fee or market it as a Stripe charge.

## State expansion monitor
For every state, maintain current values for:
- physical-presence nexus;
- economic-sales threshold and measurement period;
- whether SaaS/vendor-hosted software/platform services are taxable;
- sourcing rules;
- local tax complexity;
- registration requirement/date;
- filing frequency;
- marketplace rules if architecture ever changes;
- exemption certificate handling if applicable.

Reference starting point: https://www.streamlinedsalestax.org/for-businesses/remote-seller-faqs/remote-seller-state-guidance

## Other state taxes
Sales tax is not the only state exposure. Separately monitor:
- income/franchise/gross-receipts nexus;
- foreign qualification/entity registration;
- payroll/employment taxes;
- business licenses/local registrations.

## Automation design
V1 launch remains blocked until `ri_sales_tax_permit_status` and `platform_fee_tax_method_status` are cleared. Later implementation should maintain a jurisdiction table and monthly threshold monitor rather than hard-coding thresholds into pricing logic. Threshold changes require source verification/effective dating.

## Refunds/disputes
Tax treatment for refunds, partial refunds, application-fee refunds, disputed/charged-back sales and bad debt must be handled using the jurisdiction's current rules and recorded separately from transaction-protection classification. A refund never rewrites historical PROTECTED status; it creates financial/tax adjustments.

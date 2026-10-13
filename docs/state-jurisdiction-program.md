# Builtegrity U.S. State Jurisdiction Program

Status: PRE-LAUNCH / FAIL-CLOSED

Builtegrity does not treat “U.S.-only” as automatic permission to launch in every state. Merchant onboarding is state-gated through `state_jurisdiction_support`. A merchant cannot become ACTIVE unless the merchant's state pack is READY and current.

## Required state pack
For every merchant state, document and implement:

1. **Payments / money-transmission classification** — determine whether the exact Stripe direct-charge/application-fee architecture requires a money-transmitter/currency-transmission/payment-services license, exemption, exclusion, or other registration. Federal FinCEN treatment is not substituted for state law.
2. **Sales/use tax** — taxability of Builtegrity's platform/application fee, sourcing, registration threshold/status, local tax issues, filing cadence, refunds/credits and records.
3. **Privacy** — comprehensive privacy law thresholds/roles, website notice, rights, sensitive-data restrictions, opt-outs/universal signals and processor-contract duties.
4. **Security / breach** — generally applicable information-security duties plus breach definitions, timing, regulator/credit-bureau notice and content requirements.
5. **Entity / licensing nexus** — foreign qualification, registered agent, local/state business licenses or special registrations triggered by Builtegrity's activities.
6. **Income/franchise/gross-receipts tax nexus** — filing/registration obligations and thresholds.
7. **Electronic records / signatures** — UETA or state-specific electronic-transaction rules and exceptions.
8. **Employment/contractor rules** — if workers are located in the state.
9. **Unclaimed property** — if Builtegrity ever holds stale credits/payables/property subject to state escheat rules.
10. **Marketing communications** — state telemarketing/text/email rules where Builtegrity uses those channels.

## Rhode Island launch pack
Rhode Island is the initial state and remains `COUNSEL_REVIEW` until evidence clears all fields.

Primary current sources include:
- Currency transmission definition/license: R.I. Gen. Laws §§ 19-14-1, 19-14-2 and Chapter 19-14.3.
- General data-security law: R.I. Gen. Laws Chapter 11-49.3.
- Data Transparency and Privacy Protection Act: R.I. Gen. Laws Chapter 6-48.1 (effective January 1, 2026).
- Uniform Electronic Transactions Act: R.I. Gen. Laws Chapter 42-127.1.
- Sales/use tax: Rhode Island Division of Taxation; current rulings treat vendor-hosted software as taxable in RI on applicable facts.
- Entity good standing: Rhode Island Department of State annual report + registered agent/office.

## Activation rule
An RI merchant may become ACTIVE only when all of the following are true in the state record:
- `merchant_onboarding_status='READY'`
- money-transmission status is `CLEARED_NON_LICENSED` or `LICENSE_ACTIVE`
- sales-tax status is cleared/registered/not-applicable
- privacy and breach reviews are cleared
- entity nexus is cleared/registered
- income tax is cleared/registered/not-applicable
- electronic-transactions review is cleared
- the review date has not expired

This state gate is in addition to platform-wide and merchant-specific legal/compliance gates.

## Expansion
A new state is not enabled by adding its abbreviation alone. The state row must be created, sourced, reviewed, and deliberately moved through BLOCKED/COUNSEL_REVIEW to READY. A later material law change or expired review can suspend the state and automatically pause affected merchants.

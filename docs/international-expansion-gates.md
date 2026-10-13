# Builtegrity International Expansion Gates

V1 policy: **INTERNATIONAL DISABLED**. Supported legal/product scope is U.S. merchant + U.S. customer transaction + USD.

Stripe availability in a country is not sufficient legal clearance for Builtegrity. A country can be enabled only after its jurisdiction pack is approved and implemented.

## Required country pack
For each proposed country, document and implement:

1. **Payments/funds flow** — local payment-services, money-transmission/payment-institution rules; whether the exact Stripe Connect/direct-charge/application-fee architecture is permitted without Builtegrity licensing.
2. **Stripe/provider capability** — connected account type, fees/loss liability, payouts, supported currency/payment methods, tax reporting and restricted businesses.
3. **Privacy** — controller/processor role, privacy notice requirements, individual rights, security, breach notice, data localization/cross-border transfer mechanism, DPA/subprocessor clauses.
4. **Consumer/e-commerce law** — online contract information, cancellation/cooling-off/refund rights, recurring-payment rules if later relevant, unfair terms, price/tax display, accessibility/language requirements.
5. **Indirect tax** — VAT/GST/sales tax on Builtegrity's own fee, registration thresholds, place-of-supply rules, invoicing, digital-services obligations and filing.
6. **Corporate/direct-tax nexus** — permanent establishment/entity registration/income tax considerations.
7. **Electronic signatures/records** — clickwrap/e-sign enforceability and required consumer-consent/electronic-record rules.
8. **Sanctions/export** — U.S. OFAC obligations plus local sanctions/export restrictions.
9. **Breach/incident response** — regulator/resident notice definitions and timing.
10. **Employment/contractor** — only if local workers/representatives are used.
11. **Data/records retention** — legally required retention/deletion conflicts.
12. **Approved legal documents** — localized platform agreement, privacy/DPA, fees, electronic records, AUP and disclosures.
13. **Engineering gates/tests** — country/currency/payment-method allowlist and CI tests that fail closed.

## Candidate sequence
If international expansion later becomes commercially worthwhile, research one country at a time. Canada, the United Kingdom and Australia can be evaluated first because Stripe/e-commerce infrastructure is mature and English-language operations may reduce operational complexity; none is considered “easy” or pre-approved. Each still adds privacy, tax, consumer and payments-law obligations.

The EEA/EU should be treated as a larger separate expansion because GDPR/ePrivacy, VAT and payment-services/consumer-law requirements materially expand the compliance surface.

## Enablement rule
A country stays technically blocked until:
- counsel/tax review is recorded;
- all REQUIRED jurisdiction obligations are satisfied;
- localized legal documents are APPROVED;
- tax registration/method is operational;
- privacy transfer mechanism is operational;
- provider capability is verified;
- regression tests enforce the country/currency boundaries.

International support must never be enabled merely by deleting a U.S.-only database CHECK constraint.

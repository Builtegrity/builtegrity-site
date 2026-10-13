# Builtegrity Legal & Compliance Program — U.S. V1

Status: **PRE-LAUNCH / FAIL-CLOSED**  
Last legal research refresh: 2026-10-13  
Scope: U.S. merchants, U.S. customer transactions, USD, Stripe direct charges, automatic payouts, one-time payments.

This program is an engineering/compliance control set, not legal advice and not a representation that regulatory risk can be eliminated. Items requiring legal interpretation remain blocked until approved by licensed counsel or the responsible qualified provider.

## 1. V1 legal perimeter

The production architecture must preserve all of the following:

- Stripe is the payment processor and the connected merchant is the seller/merchant of record.
- Builtegrity does not accept, hold, pool, escrow, store, or transmit customer funds.
- Protected payments are direct charges created on the connected merchant's Stripe account; Builtegrity receives only the disclosed Stripe application/platform fee.
- No platform transfers, destination-charge marketplace routing, stored value, wallets, escrow, manual payouts, subscriptions, international merchants, international customer transactions, or non-USD transactions.
- No raw PAN/card number, CVC/CVV, PIN, Social Security number, bank credentials, password, or medical-record collection.
- No automated marketing SMS/robocall capability in V1.

Any proposed change to these boundaries requires a new legal review, threat/risk review, migration, test coverage, and approval before activation.

## 2. Hard launch blockers

The platform cannot legally/operationally reach LIVE until all are evidenced:

1. Builtegrity legal entity and federal/state tax classification confirmed; EIN/tax identity correct.
2. Payments counsel confirms the actual V1 funds flow does not require money-transmitter/MSB licensing; review is reopened before any funds-flow expansion.
3. Stripe Platform Provider/merchant agreement package approved, with clear application fee disclosure and Stripe/Builtegrity/merchant roles.
4. Privacy Notice, DPA, Acceptable Use Policy, Fee Schedule, Electronic Records Consent, Security Summary, and Subprocessor List approved and versioned.
5. Rhode Island sales-tax permit active (or documented tax-law determination that no permit is required) and Builtegrity-fee sales-tax accounting implemented.
6. Applicable PCI DSS validation completed for the Stripe-hosted checkout architecture, including applicable SAQ/ASV obligations.
7. Written information-security program approved and vendor security/contract reviews complete for service providers that receive personal/financial data.
8. Incident response and all-state breach notification process operational.
9. Restricted-business and sanctions screening workflow operational; every merchant cleared before ACTIVE.
10. Merchant clickwrap/electronic acceptance captures approved document versions and immutable evidence.
11. All REQUIRED rows in `compliance_obligations` are SATISFIED or validly NOT_APPLICABLE and not past review date.
12. All personal/financial-data service providers have APPROVED contract/security/subprocessor reviews.

The D1 activation trigger independently enforces these requirements. A runtime defect cannot make a merchant ACTIVE while the database-level gate is unsatisfied.

## 3. Federal payments classification

Primary sources:
- FinCEN money transmitter/MSB guidance: https://www.fincen.gov/resources/statutes-regulations/administrative-rulings/determination-money-services-business-status
- FinCEN integral-transaction guidance and administrative rulings: https://www.fincen.gov/

Control: Builtegrity stays outside the flow of merchant/customer principal funds. “Security” or “transaction integrity” branding never changes the underlying funds-flow analysis. If Builtegrity begins accepting/transmitting funds, controlling payouts, escrow, stored value, marketplace splitting, or wallet balances, the legal classification must be reopened before code is enabled.

## 4. Stripe contractual/payment controls

Primary sources:
- Connected Account Agreement: https://stripe.com/legal/connect-account
- Restricted Businesses: https://stripe.com/legal/restricted-businesses
- Stripe legal terms: https://stripe.com/legal

Controls:
- Compatible connected account required.
- Stripe fees/payment-loss responsibility must remain in the approved V1 lane.
- Automatic payouts required.
- Platform/application fee clearly disclosed in the approved Fee Schedule/Platform Agreement.
- Prohibited/restricted categories screened before ACTIVE.
- Stripe KYC/risk controls supplement but do not replace Builtegrity's own contractual/compliance responsibilities.

## 5. Consumer protection and product claims

Federal Trade Commission Act: https://www.ftc.gov/legal-library/browse/statutes/federal-trade-commission-act

Controls:
- Never call Builtegrity a bank, insurer, payment processor, escrow service, guarantee, chargeback guarantee, or payout guarantee unless the legal/product facts later support that claim.
- “PROTECTED” means the locked Builtegrity record classification only: routed through the protected flow, successful payment, confirmed Builtegrity fee.
- Public/customer pages explain that the merchant is the seller, Stripe processes payment, and Builtegrity records/monitors the transaction.
- Material limitations and fees are disclosed before acceptance/use.

## 6. Electronic contracts and records

Federal E-SIGN: https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title15-section7001

Controls:
- Affirmative clickwrap/e-sign acceptance.
- Store exact document type/version, acceptance timestamp, authenticated user, and salted hashes of network/user-agent evidence; do not retain raw IP/user-agent solely as legal evidence.
- Preserve final records in an accurate, accessible and reproducible form.
- General electronic-record consent does not substitute for enhanced E-SIGN consent when a separate statute requires a consumer writing.
- Material legal-document updates require a new version and reacceptance where legally required.

## 7. Data privacy — national high-water baseline

Builtegrity will use a conservative U.S. baseline even where a particular state threshold is not yet met:

- no sale of personal data;
- no cross-context behavioral advertising sharing;
- no targeted advertising/profiling in V1;
- data minimization and purpose limitation;
- nationwide intake for access/correction/deletion/portability/opt-out/appeal requests;
- identity verification and legal-hold exceptions;
- processor/service-provider contracts and subprocessor governance;
- state-law/GPC support before any future sale/share/targeted-ad functionality can be enabled;
- prohibited-sensitive-data guardrails.

Reference: NCSL consumer privacy legislation database: https://www.ncsl.org/technology-and-communication/consumer-privacy-legislation-database

### Rhode Island

- Information-security requirements: R.I. Gen. Laws § 11-49.3-2, https://webserver.rilegislature.gov/Statutes/TITLE11/11-49.3/11-49.3-2.HTM
- Breach notification: § 11-49.3-4, https://webserver.rilegislature.gov/Statutes/TITLE11/11-49.3/11-49.3-4.HTM
- Data Transparency & Privacy Protection Act: Title 6 Chapter 48.1, https://webserver.rilegislature.gov/Statutes/TITLE6/6-48.1/INDEX.htm

Builtegrity will maintain the RI-required risk-based security program/retention/provider-contract controls regardless of large-business privacy thresholds.

## 8. Security and PCI

FTC security guidance: https://www.ftc.gov/business-guidance/resources/start-security-guide-business  
PCI SSC: https://www.pcisecuritystandards.org/

Controls:
- Stripe-hosted checkout only; Builtegrity does not create card-entry fields.
- Applicable PCI SAQ/ASV evidence is required before LIVE and renewed on schedule.
- Least privilege, authentication, authorization, webhook verification, secrets management, encrypted provider tokens, immutable evidence, monitoring, patching, recovery and incident response.
- Vendors that receive personal/financial data require contract/security review and periodic re-review.

## 9. Sanctions

OFAC: https://ofac.treasury.gov/sanctions-list-search-tool

Controls:
- Merchant sanctions status starts UNREVIEWED.
- Potential matches block activation and require approved disposition.
- Screening is repeated on material merchant identity changes and according to the approved list-refresh/screening-provider procedure.
- Country-only screening is insufficient; blocked persons can be located anywhere.

## 10. Marketing communications

CAN-SPAM: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business

If Builtegrity sends commercial email, it must use accurate headers/subjects, required identification/address disclosures, functional opt-out, suppression and timely honoring of opt-outs, including monitoring vendors sending on Builtegrity's behalf.

Automated marketing SMS/robocalls are disabled in V1. Any future enablement requires a TCPA/FCC consent/revocation review before deployment.

## 11. Children

COPPA guidance: https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions

V1 is not child-directed. Merchants are contractually prohibited from intentionally using Builtegrity to collect information directly from children under 13. A product change that becomes child-directed or creates actual knowledge of under-13 collection requires a separate COPPA program before deployment.

## 12. Rhode Island entity/tax standing

Rhode Island Department of State: https://www.sos.ri.gov/divisions/business-services/ri-business/maintain-your-business  
Rhode Island Division of Taxation: https://tax.ri.gov/

Once entity form is confirmed, maintain registered agent/office, annual report, applicable RI business tax return/fee, and good standing.

Domestic U.S.-created companies are currently exempt from federal BOI reporting under FinCEN's 2026 rule; monitor rule changes rather than filing an inapplicable report: https://www.fincen.gov/boi

## 13. Builtegrity service sales tax

Rhode Island sales/use tax: https://tax.ri.gov/tax-sections/sales-excise-taxes/sales-use-tax

V1 treats RI platform-fee tax as unresolved and blocks LIVE until:
- RI registration/permit issue is resolved;
- Builtegrity service/application-fee taxability is confirmed;
- pricing/payment accounting separately tracks base platform revenue vs sales-tax liability;
- filing/payment calendar and records are operational.

Do not silently absorb or disguise tax as a processor fee.

Across states, monitor physical/economic nexus and service taxability before collection/registration. Reference: https://www.streamlinedsalestax.org/for-businesses/remote-seller-faqs/remote-seller-state-guidance

## 14. State business/income nexus

Monitor revenue, employees, contractors, offices/property, travel/activity, and other state contacts for:
- foreign qualification/registered-agent requirements;
- income/franchise/gross-receipts tax nexus;
- sales-tax nexus;
- employment registrations;
- state privacy thresholds.

A merchant/customer being located in another state does not automatically answer every nexus question; the monitor must use the state's current rules.

## 15. Vendors/contractors/employees

Conditional controls:
- W-9 and applicable information-return workflow for qualifying payees;
- worker-classification review;
- I-9/payroll withholding/employment-tax process for employees;
- Rhode Island employer registration/workers compensation/labor requirements when triggered;
- written confidentiality/security/access agreements before workers receive production access.

## 16. Incident response

Every suspected incident is logged. A confirmed breach triggers resident-state determination and state-specific notice analysis. RI timing/threshold calculations are stored, but the all-state matrix must be checked before notices are finalized. No automated notice is sent solely from a database flag without legal/incident review because statutory definitions and exceptions are fact-specific.

## 17. Governance cadence

- Continuous: architecture hard gates, restricted data blocks, merchant activation gates.
- At onboarding: legal acceptance, restricted-business review, sanctions clearance, Stripe compatibility.
- Daily/automated: system monitoring and unresolved critical compliance state visibility.
- Monthly: open obligation/vendor/privacy/incident queue review.
- Quarterly: privacy/security/vendor/claims/tax-nexus review.
- Annually: PCI validation, incident exercise, retention-policy review, entity/tax calendar, vendor re-review, legal-document review, payments-law classification confirmation.
- Event-driven: law/provider/pricing/funds-flow/product/jurisdiction changes trigger immediate re-review.

## 18. International expansion

International support is disabled. A country may be enabled only after a signed-off jurisdiction pack covering payment/funds-flow regulation, privacy/data transfers, consumer law/e-commerce disclosures, indirect taxes, sanctions/export restrictions, company/tax nexus, electronic contracting, breach notice, and provider availability. See `docs/international-expansion-gates.md`.

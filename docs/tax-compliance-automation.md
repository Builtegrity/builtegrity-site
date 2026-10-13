# Builtegrity tax-compliance automation

## Purpose

Builtegrity keeps transaction records tax-season ready without pretending that payment volume is taxable income or that every business has the same filing cadence.

The system has two independent tracks:

1. **Merchant documentation** — monthly, quarterly and annual payment-activity records generated from Builtegrity's canonical transaction data.
2. **Builtegrity company compliance** — quarterly/year-end workpapers, versioned federal/Rhode Island rules, obligation tracking and future provider-assisted filing/payment execution.

Neither track stores raw SSNs/EINs/TINs merely to generate transaction documentation.

## Merchant documentation cadence

Every merchant with tax documentation enabled gets:

- **Monthly:** existing Builtegrity transaction statement.
- **Quarterly:** Quarterly Payment Activity Summary, intended to reconcile the completed quarter and support any estimated-tax work applicable to the business or its owners.
- **Annual:** Year-End Payment Activity Summary, intended to reconcile the processor tax year and support the annual return/accountant workflow.

The quarterly/annual documents separately present gross payment volume, refunds, processor fees, Builtegrity fees, transaction classifications and reconciliation exceptions. They never label net payment activity as taxable income and never call themselves a tax return, 1040-ES, 1120-W, payroll return or 1099.

### Classification-specific purpose

The same transaction facts are useful for different tax workflows:

- **Sole proprietor / disregarded SMLLC:** quarterly packet supports owner estimated-tax work; annual packet supports owner return/Schedule C reconciliation.
- **Partnership:** quarterly packet supports partner estimated-tax work; annual packet supports partnership/K-1 reconciliation.
- **S corporation:** quarterly packet supports shareholder estimated-tax work and any separately applicable entity-level tax analysis; annual packet supports S-corp/shareholder reconciliation.
- **C corporation:** quarterly packet supports corporate estimated-tax work; annual packet supports corporate-return reconciliation.
- **Unknown/other:** packets remain general accounting/tax-preparation records. Builtegrity makes no filing assertion until the tax profile is known.

Payroll obligations are separate. Payment-activity documents do not replace payroll reports, payroll tax deposits, Forms 941/940, state withholding reports, W-2s or payroll-provider records.

## Hardcoded 2026 federal rule pack

Rules are stored as versioned advisory records so a later tax-year rule update does not rewrite historical assumptions.

- Individuals including sole proprietors, partners and S-corp shareholders generally make federal estimated payments when expected tax due reaches **$1,000**. Calendar-year 2026 installment dates are April 15, June 15, September 15 and January 15, 2027.
- C corporations generally make federal estimates when expected corporate tax reaches **$500**. Calendar-year installment dates are April 15, June 15, September 15 and December 15.
- S corporations can have entity-level estimated payments for specified taxes such as built-in-gains tax; ordinary operating income generally passes through to shareholders.
- Most employers file **Form 941 quarterly**, unless the IRS has specifically authorized Form 944 or another exception.
- Payroll tax deposits are **not simply quarterly**. Federal deposit frequency can be monthly or semiweekly and the $100,000 next-day rule can accelerate a deposit.
- Form 940 is annual, while FUTA deposits can become due after a quarter when accumulated undeposited FUTA liability exceeds $500.
- The general 2026 Form 1099-NEC reporting threshold is **$2,000** of qualifying nonemployee compensation, subject to recipient/payment-method exceptions.

Authoritative rule URLs are stored with each rule in `tax_compliance_rule_versions`.

## Hardcoded 2026 Rhode Island rule pack

The initial state-specific pack is Rhode Island because Builtegrity's home state is Rhode Island.

- Rhode Island individuals generally make estimated payments when expected RI income tax after credits reaches **$250**. Calendar-year installment dates are April 15, June 15, September 15 and January 15 of the following year.
- Rhode Island corporations generally make estimated payments when expected entity tax exceeds **$500**, normally in four installments.
- RI C corporations generally file **RI-1120C** and are subject to 7% of RI net income or the $400 minimum tax, whichever is greater.
- RI S corporations generally file **RI-1120S** and are subject to at least the $400 minimum tax.
- RI LLCs not taxed as corporations, including disregarded SMLLCs, generally file **RI-1065**; entities other than general partnerships are generally subject to the $400 annual charge.
- Rhode Island employer withholding uses quarterly **RI-941** reconciliation, but withholding payment frequency can be weekly, monthly or quarterly.

A merchant outside Rhode Island still receives monthly/quarterly/annual Builtegrity documents, but Builtegrity does not invent that state's tax rules. Additional state rule packs must be added and versioned before state-specific filing guidance is displayed.

## Builtegrity's own tax machine

`builtegrity_tax_profile` intentionally starts with:

- legal entity: `UNCONFIRMED`
- federal tax classification: `UNKNOWN`
- home state: `RI`
- accounting data: `PARTIAL`
- prior-year tax data: `MISSING`
- filing authorization: `NOT_CONFIGURED`
- direct autonomous filing: permanently false in the schema

This is deliberate. The repository does not contain authoritative proof that Builtegrity has been formed/elected as a sole proprietorship, disregarded SMLLC, partnership, S corporation or C corporation. Those classifications lead to different federal and Rhode Island returns.

### Automation states

The machine fails closed through these states:

1. `BLOCKED_PROFILE_UNKNOWN` — legal/tax classification is not confirmed.
2. `BLOCKED_BOOKS_INCOMPLETE` — entity is known but the complete books are not verified.
3. `BLOCKED_PRIOR_YEAR_DATA_MISSING` — current books are verified but prior-year tax inputs needed for safe-harbor/estimated-tax work are missing.
4. `READY_FOR_CALCULATION` — sufficient data exists to calculate through a reviewed tax calculation layer.
5. `READY_FOR_PROVIDER_REVIEW` — an e-file provider is configured and filing authorization is present.

The transaction-economics ledger automatically feeds quarterly/year-end workpapers with actual Builtegrity revenue, adjustments, partner shares and tracked costs. The workpaper intentionally leaves `estimated_tax_amount_micros` null until a tax calculation layer has complete books and entity/prior-year inputs.

## What can be automated safely

### Fully automatic now

- transaction capture and processor reconciliation
- monthly merchant statements
- quarterly merchant payment-activity summaries
- annual merchant payment-activity summaries
- PDF generation, hashing, durable storage and email delivery
- federal/RI obligation rule lookup after classification
- Builtegrity quarterly/year-end workpaper generation
- deadlines/obligation registry
- fail-closed alerts/readiness when profile or accounting data is incomplete

### Can be highly automated after provider setup

- federal/state estimated-tax calculation once complete accounting and prior-year inputs are connected
- scheduling estimated payments through appropriate IRS/Rhode Island payment channels
- payroll deposits and payroll returns through a payroll provider
- annual and information-return preparation through approved tax/e-file software

### Must not be silently self-filed by the transaction engine

A return/payment may not be marked confirmed without external provider/portal confirmation evidence. Annual return preparation can be automated heavily, but the final e-file step should run through an authorized/approved filing channel with the legally required signer authorization.

This boundary keeps Builtegrity from becoming an unreviewed homemade tax-preparation/e-file system while still allowing the owner-facing tax workflow to approach zero routine bookkeeping work.

## Annual maintenance

Tax thresholds, forms, due-date rules and state requirements change. Every hardcoded tax rule has a tax year, source URL and verification date. A new rule pack must be reviewed before each tax year; old rule rows remain historical evidence and are not mutated.

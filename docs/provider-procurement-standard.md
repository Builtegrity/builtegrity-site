# Builtegrity Provider Procurement & Automation Standard

**Policy ID:** PROVIDER-PROCUREMENT-V1

This document defines what Builtegrity is buying when it engages outside providers and how a provider is allowed to enter an automation funnel.

The goal is not to accumulate vendors or staff. The goal is to place every external provider into a bounded role with explicit authority, cost, intake method, service level, data boundary, proof-of-completion rule, and fallback path.

## Provider lifecycle

Every provider follows this lifecycle:

`CANDIDATE -> QUOTED -> CONTRACTED -> VERIFIED -> AUTOMATION_ENABLED`

No provider may receive automated production work merely because an account exists or a contract was signed.

`AUTOMATION_ENABLED` requires:

- the provider role is explicitly authorized;
- contract/terms are understood;
- pricing and spending limits are known;
- intake and escalation paths are tested;
- data/access boundaries are approved;
- the required security/confidentiality/DPA controls are in place;
- the machine can verify completion or route an unresolved result back to review;
- a fallback/replacement path exists where practical.

## Universal quote checklist

Collect and record for every provider:

- exact role/problem classes the provider may handle;
- setup cost;
- recurring minimums;
- hourly/project/per-ticket/per-seat pricing as applicable;
- emergency/off-hours pricing;
- renewal terms and price-escalation terms;
- intake method: API, webhook, email, portal, phone, account manager;
- response SLA and service hours;
- emergency escalation path;
- cancellation/termination terms and minimum commitments;
- data/access scope;
- confidentiality/DPA/security obligations;
- subprocessors/subcontractors where material;
- whether automated work-order intake is contractually allowed;
- spending caps/fixed-price options;
- authoritative proof of completion;
- fallback provider or internal fallback path;
- relevant experience/references;
- any success-rate claim with its actual denominator/source rather than unsupported marketing language.

Never choose solely on lowest price. Score:

1. exact role fit;
2. total cost of ownership;
3. automation compatibility;
4. SLA and availability;
5. data/security boundary;
6. flexibility/termination;
7. relevant experience;
8. machine-verifiability;
9. portability to a fallback provider.

## Standing counsel

“Counsel” means an actual qualified outside attorney or law firm retained by Builtegrity under an active engagement. AI is never counsel or legal authority.

Desired attributes:

- fintech/payments/SaaS experience;
- Stripe Connect/platform-fee economics familiarity;
- technology/commercial contracts;
- privacy/security and incident-response capability;
- regulatory/legal-notice response;
- Rhode Island capability or a coordinated RI local-counsel path;
- ability to accept structured intake and return structured decisions/clearances;
- clear conflict process and response SLA.

Preferred initial commercial structure: obtain a fixed-fee pre-launch architecture/contracts/refund-policy review before committing to a large recurring retainer unless the quote economics justify otherwise.

Automation funnel:

`preserve evidence -> counsel intake -> counsel verifies classification/deadline/action -> structured counsel response -> machine monitors -> owner only for nondelegable corporate-authority decisions`

The machine must not make admissions, settlements, waivers, legal interpretations, or release legal holds on its own.

## Registered agent

Purpose: dependable receipt of formal service/process and rapid forwarding into the legal-response system.

This is not legal advice.

Quote for:

- annual cost;
- Rhode Island coverage;
- forwarding SLA;
- digital scan/attachment fidelity;
- escalation procedure;
- change-of-contact procedure;
- ability to forward directly into the legal-response intake path;
- replacement/termination process.

Automation funnel:

`formal service -> registered agent receipt -> digital forwarding -> legal intake verification -> evidence preservation -> counsel`

## Cyber / Technology E&O insurance

Purpose: transfer defined financial risk and gain insurer/claims-response resources; not replace security controls.

Compare:

- cyber liability and Tech E&O coverage;
- limits;
- deductible/retention;
- exclusions;
- defense costs and whether inside/outside limits;
- incident-response resources;
- breach coach / panel counsel requirements;
- notice deadlines and claims-made requirements;
- claims intake method;
- consent-to-settle language;
- prior-acts/retroactive date;
- renewal terms;
- processor/funds-transfer/social-engineering exclusions where relevant.

Automation funnel:

`incident/legal matter -> counsel or approved coverage rule determines notice requirement -> carrier notice through required channel -> receipt preserved -> deadline/claim state monitored`

## Outsourced technical / operations provider

Purpose: bounded exception work after self-repair and playbooks fail; not an unmanaged extension of owner access.

Prefer:

- fixed-price or capped work orders;
- automation-friendly API/email intake;
- relevant Cloudflare/Stripe/Clerk/Resend/GitHub experience;
- least-privilege time-bounded access;
- confidentiality and secure credential handling;
- explicit acceptance tests;
- no authority to change legal policy, pricing policy, vendor approvals, major security policy, or revenue write-offs.

Automation funnel:

`self-repair -> playbook -> bounded work order -> approved provider -> machine verification -> close only when verified`

A provider saying “done” is not authoritative proof. The underlying system state must be checked.

## Managed customer support

Purpose: handle unresolved eligible support work after self-service and machine playbooks; not create a large permanent support organization before volume proves the need.

Compare:

- minimum monthly commitment;
- hourly/per-ticket/per-seat pricing;
- channels and service hours;
- escalation SLA;
- QA process;
- playbook discipline;
- privacy/security controls;
- access model;
- API/email ingestion;
- language coverage if later needed;
- contract exit terms.

Automation funnel:

`self-service -> automated resolution playbook -> eligible unresolved support case -> bounded support queue -> machine verifies resulting system state`

## Compliance / security evidence automation

Purpose: collect evidence, monitor controls, and reduce manual compliance work. It is not a substitute for counsel, an auditor, or required professional judgment.

Compare:

- supported frameworks;
- provider integrations;
- implementation/setup fee;
- annual platform cost;
- audit-partner cost;
- renewal terms;
- data scope/access;
- API/export capabilities;
- evidence retention;
- portability if the platform is replaced.

## Authority boundaries

The following remain non-outsourceable by default unless a future approved governance rule explicitly changes the boundary:

- legal judgment reserved to qualified counsel;
- global pricing/economic policy approval;
- provider/vendor approval itself;
- material security-policy decisions;
- revenue write-offs outside a pre-authorized deterministic rule;
- major corporate commitments;
- settlement/admission/waiver authority requiring company authorization;
- sale/licensing/control of the company or core IP.

## Required system behavior

For an automation-enabled provider, Builtegrity should know:

- provider ID/name;
- approved work categories;
- active contract/effective dates;
- cost model and spending ceilings;
- SLA;
- intake method;
- data/access scope;
- credential location by name only, never secret value;
- verification method;
- escalation path;
- fallback provider;
- last review date and next review date;
- automation state.

If any required provider evidence expires, the affected automatic-dispatch path must fail closed rather than silently continue under stale authority.

## Owner reminder rule

When the owner later asks to source, quote, contract, or activate any outside provider, begin by restating the role semantics and buying criteria in this standard before recommending names or enabling automation.

This prevents procurement from degrading into “pick a vendor” when the actual objective is to install a bounded, machine-routable capability into Builtegrity.

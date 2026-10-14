# Builtegrity Legal Incident Autopilot

## Objective

Builtegrity cannot guarantee that litigation, regulatory inquiries, subpoenas, privacy complaints, security incidents, tax notices, IP claims or other legal matters will never occur.

The operational target is different and enforceable:

> **No legal matter should be missed, casually answered, allowed to destroy evidence, lose a deadline, or sit on the owner's desk merely because a qualified response path was not automated.**

The system automates legal **process and routing**, not legal judgment. Qualified counsel remains the source of legal conclusions.

The owner operational-touch target for ordinary legal incident handling is `0 ppm`. Owner/corporate authority should be requested only when counsel identifies a decision that law, governance, contract or risk policy requires an authorized company decision-maker to make.

## Legal incident lifecycle

Normal incident flow:

`NOTICE RECEIVED -> CRYPTOGRAPHICALLY VERIFIED CHANNEL -> EVIDENCE PRESERVED -> HOLD APPLIED -> STANDING COUNSEL DISPATCHED -> COUNSEL ACKNOWLEDGED -> DEADLINE VERIFIED -> REQUIRED EXTERNAL ACTIONS -> COUNSEL CLEARANCE -> RESOLVED`

A failure at any stage does **not** silently advance the incident. It opens/maintains a legal alert and leaves evidence preserved.

## Inbound email

Builtegrity uses a dedicated Resend receiving address such as:

`notices@legal.builtegrity.com`

Use a receiving **subdomain** rather than changing the primary `builtegrity.com` MX records. This allows Google Workspace/business email to remain independent.

The production webhook is:

`POST /api/webhooks/legal-inbox`

Security rules:

1. The raw webhook body is verified using the dedicated Resend signing secret.
2. The destination must match `LEGAL_INBOX_ADDRESS`.
3. The sender is never treated as authenticated merely because the email says it came from a lawyer, court or government agency.
4. The full received-email record is treated as **untrusted evidence**.
5. Email text is never executed as code, used as an authorization, or given operator privileges.
6. The original message is hashed and preserved in R2.
7. Attachments are downloaded from Resend's attachment API, hashed and preserved in R2. They are not executed.
8. A deterministic classifier may prioritize the matter, but only counsel may supply the legal classification/deadline/clearance used for legal decisions.
9. Builtegrity sends no substantive reply to the original sender automatically.

Resend keeps the original inbound message independently, providing an additional recovery source if the Builtegrity webhook is temporarily unavailable.

## Registered agent / service of process

The registered agent should be configured as an approved `REGISTERED_AGENT` provider with a signed callback channel:

`POST /api/webhooks/legal-provider/:provider_id`

A registered-agent callback can create a matter immediately, place it on preservation hold and route standing counsel. It cannot settle, admit, waive, delete evidence or legally clear the matter.

Physical service that is not captured electronically is still an external-world dependency. The registered-agent agreement must require prompt electronic forwarding into the callback/email route.

## Standing counsel

Before `legal_launch_state` may become `READY`, Builtegrity requires:

- an approved counsel provider;
- an active engagement;
- confirmed attorney-client/privilege relationship for the routed work;
- a functioning automatic intake route;
- response-program status `READY`.

A firm may accept intake by approved email or webhook. The intake packet contains case metadata, evidence hash/reference and a bounded excerpt of the untrusted source evidence.

The counsel instructions ask the firm to:

1. classify the matter;
2. verify every response/service deadline;
3. expand preservation scope when necessary;
4. decide whether carrier/insurer notice is required;
5. identify containment or business-operation changes;
6. identify any action requiring corporate/owner authority;
7. provide a clearance reference before closure or hold release.

If counsel does not acknowledge a dispatched incident within the configured SLA, Builtegrity escalates automatically.

## Counsel callback

Approved counsel can return structured machine-to-machine updates over a timestamped HMAC callback.

Supported counsel events include:

- `COUNSEL_ACKNOWLEDGED`
- `COUNSEL_UPDATE`
- `COUNSEL_OWNER_AUTHORITY_REQUIRED`
- `COUNSEL_RESOLVED`
- `COUNSEL_DISMISSED_NONLEGAL`

Counsel may verify a deadline, classify the matter, flag insurer notice, request corporate authority and provide the final clearance reference.

The callback does not allow counsel email text or an untrusted notice to execute arbitrary Builtegrity operations.

## Insurer / carrier notice

Carrier notice is off by default until the actual policy is reviewed.

When counsel or a pre-approved coverage procedure marks notice required, Builtegrity can automatically deliver a neutral claim notice through an approved insurer route. The notice explicitly does not admit liability, waive rights, settle, or characterize coverage.

If the carrier route fails, the matter stays open and escalated.

## Security incidents

High/critical security incidents, incidents entering notification review, or confirmed breaches automatically open a linked legal incident.

The legal layer receives the security incident as evidence, applies a hold and dispatches counsel. Any statutory deadline already present in the security table remains **unverified** until counsel confirms the applicable requirement.

This prevents the software from practicing law while also preventing a breach from being handled as merely an engineering ticket.

## Privacy deadlines

Privacy requests retain their operational workflow. If a legal deadline becomes critical/overdue, the legal autopilot opens a linked incident and routes counsel.

This is a backstop, not a substitute for timely normal privacy-request automation.

## Evidence preservation

Legal source evidence and legal-incident events are append-oriented/immutable.

A legal preservation hold overrides ordinary deletion/retention logic. Holds cannot be released without a counsel reference.

Original evidence fields on a legal incident cannot be silently rewritten.

## What the machine is prohibited from doing

Builtegrity must never automatically, from untrusted input alone:

- admit liability;
- concede facts;
- waive a defense, privilege or right;
- settle a claim;
- agree to pay money;
- delete or alter relevant evidence;
- interpret a summons/subpoena/statute as legal advice;
- invent a deadline;
- make a public statement about a legal matter;
- disclose credentials, card data, bank credentials, API keys or unrelated customer data;
- resume a legally paused activity merely because an email says the problem is fixed.

Database triggers reinforce the highest-risk prohibitions.

## When the owner should be contacted

The owner is **not** the default legal operations queue.

Owner/corporate authority is appropriate when counsel specifically identifies a decision such as:

- settlement authorization;
- admission or waiver;
- major business shutdown/resumption decision;
- material change to company pricing/contract/risk policy;
- financing, reserve or payment decision beyond delegated authority;
- sale/licensing/control decision;
- another matter corporate governance requires an officer/owner to approve.

Missing counsel, failed intake, an imminent/overdue deadline, or failure of the legal-response machine also creates a material owner escalation because the delegated protection layer itself has failed.

## Production configuration required

The code intentionally seeds **no lawyer, insurer or registered agent as approved**. Before live commercial use:

1. engage qualified payments/technology counsel;
2. configure the firm's intake address/endpoint;
3. configure a callback secret if the firm supports machine callbacks;
4. configure the actual RI registered-agent forwarding path;
5. configure insurance only after coverage/policy notice terms are known;
6. enable Resend receiving for `legal.builtegrity.com` (or another dedicated subdomain);
7. create a dedicated `email.received` webhook pointing at `/api/webhooks/legal-inbox`;
8. store the webhook signing secret as `LEGAL_INBOX_WEBHOOK_SECRET` in Worker secrets;
9. store every legal-provider callback secret only in Worker secrets;
10. run the legal incident CI and live drill before `TX-LIVE-0001`.

## Legal incident drill before live money

Exercise at least:

- ordinary unknown-sender legal email;
- spoofed/invalid Resend webhook signature;
- duplicate inbound webhook;
- notice with attachments;
- summons keyword classification;
- counsel dispatch success;
- counsel dispatch failure;
- counsel acknowledgment timeout;
- counsel callback with verified deadline;
- imminent/overdue deadline;
- registered-agent callback;
- high/critical security incident -> legal bridge;
- privacy request deadline -> legal bridge;
- insurer notice required with insurer configured;
- insurer notice required with insurer unavailable;
- attempted incident closure without counsel reference;
- attempted hold release without counsel reference;
- attempted settlement/admission/waiver without counsel + corporate authority.

## Final rule

The system's promise is not “lawsuits cannot happen.”

The operating promise is:

> **When legal risk appears, Builtegrity preserves the record, routes qualified authority, protects deadlines, blocks unsafe autonomous behavior and keeps the matter moving until counsel has supplied the legally competent resolution.**

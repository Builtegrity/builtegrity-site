# Builtegrity Owner Independence & Disaster Recovery Standard

**Policy ID:** OWNER-INDEPENDENCE-V1

This document is the ownership foundation under the rest of Builtegrity.

The governing rule is simple:

> Builtegrity must remain operable, diagnosable, recoverable, migratable, pausable, and terminable by its owner even if ChatGPT, Atlas, Work, a contractor, an employee, or any single vendor is completely unavailable.

AI may accelerate the company. AI must never be an organ the company needs in order to survive.

## 1. The control pyramid

From strongest authority to weakest dependency:

1. **Owner / company authority** — account ownership, legal authority, recovery methods, financial control.
2. **Domain and identity roots** — registrar, DNS, owner email, MFA/recovery mechanisms.
3. **Canonical source and records** — GitHub source/migrations/docs plus Builtegrity-owned database/object exports.
4. **Runtime infrastructure** — Worker, D1, R2, schedules and operational configuration.
5. **External adapters** — Stripe, Clerk, Resend and future processor/identity/email providers.
6. **Automation and AI** — watchdogs, ChatGPT, Work, connectors, agents and convenience tooling.

A lower layer may depend on a higher layer. A higher layer must never depend exclusively on a lower layer.

Examples:

- ChatGPT may edit GitHub, but GitHub must remain understandable without ChatGPT.
- Clerk may prove identity, but Clerk does not own Builtegrity authorization or tenant relationships.
- Stripe may move money, but Stripe does not own Builtegrity's normalized transaction history.
- Resend may deliver statements, but email delivery cannot define payment truth.

## 2. What “owner control” means

A critical system is not considered owner-controlled merely because the owner can log in today.

For each critical system, Builtegrity must know and periodically verify:

- who owns the account;
- how the owner regains access if the normal login method fails;
- where MFA recovery material is held;
- what authority the system possesses;
- where its secrets live;
- what durable data it stores;
- how that data can be exported;
- how service can be paused safely;
- how credentials can be rotated or revoked;
- how the provider can be replaced;
- what cannot be migrated perfectly and therefore needs a cutover plan.

The public machine-readable inventory is `ops/owner-control-manifest.json`. It contains no credential values.

## 3. Private Owner Emergency Vault

The owner must maintain a private credential/recovery vault outside GitHub, Google Drive documents, Sheets and ChatGPT.

The vault should contain, as applicable:

- registrar account recovery details;
- Cloudflare account recovery details and MFA recovery codes;
- GitHub account/organization recovery details and MFA recovery codes;
- Stripe platform recovery information;
- Clerk account recovery information;
- Resend account recovery information;
- Google Workspace super-admin recovery information;
- banking/accounting recovery information;
- inventory of production API key names and where each key is installed;
- emergency contacts and vendor support/account identifiers;
- offline or independently protected recovery codes;
- a dated record of the last recovery drill.

**Never put actual passwords, API keys, webhook signing secrets, backup codes, private keys, or bank credentials in this repository.**

The repository documents *where* a secret belongs and how to rotate it. The private vault holds the recovery material needed by the owner.

## 4. No hidden AI dependency

Production must not require ChatGPT or any AI system for:

- login;
- merchant onboarding already supported by the product;
- customer checkout;
- webhook processing;
- transaction lifecycle state;
- pricing calculations;
- fee collection;
- event retention;
- payout reconciliation;
- monthly statement generation;
- database operation;
- artifact storage;
- alert persistence;
- backups/exports;
- deployment/rollback instructions;
- emergency shutdown.

If Atlas is unavailable, the owner or a competent engineer must be able to use the repository, provider dashboards and documented runbooks directly.

## 5. Required control paths by system

### Domain / registrar

This is a root authority. If the application host fails, registrar/DNS control is what allows traffic and email authentication to be moved elsewhere.

Owner must be able to:

- log in without ChatGPT;
- recover the registrar account;
- change nameservers/DNS when necessary;
- transfer the domain to another registrar;
- obtain/rotate transfer authorization when applicable;
- verify that business email remains recoverable independently of the web application.

### GitHub

GitHub is the canonical source for application code, migrations, CI rules, technical documentation and infrastructure configuration.

Owner must be able to:

- administer the repository/organization directly;
- clone the entire repository;
- create a local/off-provider copy;
- review commit history;
- disable compromised credentials;
- move the repository to another Git-compatible host.

A local/off-provider clone must be tested periodically. GitHub availability must not be the only way to possess the source.

### Cloudflare

Cloudflare is the V1 runtime provider for Worker + Static Assets, D1, R2, DNS and Turnstile.

Owner must be able to:

- enter the Cloudflare account directly;
- deploy/rollback the Worker without ChatGPT;
- change routes and DNS;
- rotate Worker secrets;
- pause public routes if necessary;
- export/backup D1 in a restorable form;
- copy durable R2 artifacts outside the bucket/provider when required;
- reproduce schedules and bindings from repository configuration;
- migrate the runtime to another host/database/object store using source + exports.

Cloudflare account loss is a serious incident but must not equal company-data loss.

### Stripe

Stripe is Processor Adapter #1 and remains the processor of money.

Owner must be able to:

- administer the Builtegrity platform account directly;
- distinguish test and live configuration;
- revoke/rotate keys and webhook secrets;
- disable new Builtegrity-created payment routes if integrity is uncertain;
- inspect connected-account/payment/application-fee/payout facts at the processor;
- preserve normalized Builtegrity records even if Stripe is unavailable;
- migrate future transactions to another processor adapter without rewriting historical Stripe facts.

Processor-native balances, disputes, payouts and historical objects may not be perfectly portable to a different processor. Migration therefore means preserving history and cutting future processing to a new adapter, not pretending another processor can inherit Stripe-native objects.

### Clerk

Clerk is an identity provider, not Builtegrity's authorization database.

Owner must be able to:

- administer the Clerk application;
- rotate verification/configuration material;
- export/migrate supported user identity data;
- replace Clerk while preserving Builtegrity tenant/role relationships in D1.

User passwords or provider-specific credentials may not be portable. A provider replacement may require users to reauthenticate or reset credentials. That is acceptable; losing Builtegrity authorization relationships is not.

No permanent emergency authentication backdoor is allowed. Emergency identity replacement happens through controlled deployment/configuration, not a secret undocumented bypass.

### Resend

Resend is an outbound delivery adapter.

Owner must be able to:

- administer the sending domain;
- rotate API/webhook credentials;
- disable delivery if a key is compromised;
- inspect provider delivery results;
- switch to another email provider without changing transaction truth.

Loss of Resend must not stop payment/event accounting. Statements remain durable in Builtegrity storage even if delivery is delayed.

### Google Workspace

Google Workspace is a business communications/control surface, not the transaction database.

Owner must be able to:

- recover the super-admin account;
- maintain the monitored Builtegrity mailbox;
- preserve/export important company mail as required;
- change routing/aliases independently of the transaction application;
- recover business communications if another application provider fails.

### Banking / accounting

Financial custody and accounting authority cannot depend on AI.

Owner must maintain direct access and recovery to the accounts used for company funds, tax/accounting records and processor deposits. Provider records and Builtegrity transaction records should reconcile, but neither substitutes for bank/accounting authority.

## 6. Backup and export standard

Backups are not proven until restoration works.

Before live commercial use:

- repository source must exist in at least one owner-controlled off-provider copy;
- D1 must have a documented export method and at least one successful restoration test;
- R2 durable transaction/statement artifacts must have a documented copy/export method and at least one retrieval/hash-verification test;
- critical company/accounting records must have an export/retention path appropriate to their system;
- the date and result of each drill must be recorded outside ephemeral chat.

As the system grows, backup cadence and retention must be set from actual transaction volume and recovery objectives rather than convenience.

## 7. Emergency operating modes

### AI unavailable

Continue using provider dashboards, GitHub, CI, the runbooks and the master blocker/operations records. No production feature should stop merely because AI is unavailable.

### GitHub unavailable

Use the latest verified owner-controlled clone. Do not make blind production changes. Provider dashboards may be used to pause unsafe routes while source availability is restored or migrated.

### Cloudflare unavailable

Stripe remains the processor for already-created processor activity. Freeze creation of new Builtegrity-protected payments if the integrity runtime cannot record them reliably. Recover from source plus database/artifact exports onto restored or replacement infrastructure.

### Stripe unavailable or unsafe

Stop creation of new Stripe-routed protected payments. Preserve Builtegrity history. Do not fabricate payout/payment state. Resume only after processor truth is available or a replacement processor adapter is deliberately activated for future transactions.

### Identity provider unavailable

Do not bypass tenant authorization. Pause privileged user operations as necessary and restore/replace identity verification through controlled deployment.

### Email provider unavailable

Continue transaction accounting. Queue/preserve statement and alert state. Restore delivery or switch providers separately.

### Suspected credential compromise

1. contain affected surface;
2. pause risky public/payment paths if necessary;
3. rotate/revoke compromised credential from the provider account;
4. update runtime secret store;
5. verify webhooks and account authority;
6. review audit/provider logs;
7. reconcile transactions during the incident window;
8. document the incident and recovery.

## 8. Owner Zero-AI Drill

Before the first live commercial payment, the owner must complete a drill without using ChatGPT to perform the steps.

The drill must prove the owner can locate or cause a competent engineer to locate:

1. the canonical repository;
2. the production deployment and rollback controls;
3. D1 database and migration history;
4. the D1 export/restore procedure;
5. R2 statement/record storage and retrieval procedure;
6. Stripe test/live platform configuration and emergency pause path;
7. Stripe webhook configuration;
8. Clerk application and identity replacement documentation;
9. Resend domain/API/webhook configuration;
10. Google Workspace admin/recovery path;
11. registrar/DNS recovery path;
12. private emergency vault;
13. company banking/accounting recovery path;
14. the production-readiness gate and incident runbook.

The drill is a **failure** if any critical credential is known only to a chat, an employee/contractor, an unavailable device, or a single unrecoverable account.

## 9. Verification statuses

The owner-control manifest uses:

- `VERIFIED` — direct owner/recovery/export control has actually been demonstrated.
- `PARTIALLY_VERIFIED` — some authority is proven, but one or more required recovery/admin/export paths remain unproven.
- `UNVERIFIED` — the requirement exists but direct proof has not been recorded.
- `NOT_ACTIVE` — the production system/account has not been activated yet.

`NOT_ACTIVE` is not a failure during development. It is a blocker when that system becomes required for the target launch stage.

## 10. Release rule

A system can be technically working and still fail owner independence.

Before `TX-LIVE-0001`:

- every manifest entry marked `required_for_live: true` must be `VERIFIED`;
- the Owner Zero-AI Drill must pass;
- D1 restoration must have been tested;
- R2 artifact recovery must have been tested;
- an off-provider source copy must exist;
- the private Owner Emergency Vault must exist and have a tested recovery path;
- no production credential may exist only inside ChatGPT, GitHub source, Drive/Sheets, or one person's undocumented memory.

The machine-readable check is:

`npm run owner:gate:live`

That command is intentionally expected to fail while required items are unverified. A green source-code CI build is not permission to override an owner-independence failure.

## 11. Design rule for every future Builtegrity layer

Whenever a new provider, subsystem, feature or employee is added, ask:

1. What authority does this new thing gain?
2. What data can it destroy, strand or make unavailable?
3. Can the owner enter and recover it directly?
4. Can its durable data be exported?
5. Can its credentials be revoked/rotated?
6. Can the provider/person be replaced?
7. What is the safe shutdown state?
8. Does Builtegrity survive if it disappears today?

If question 8 is no, the architecture is incomplete.

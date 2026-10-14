# Automated Monthly Transaction Statements

## Product rule

Monthly statements are a permanent automated output of Builtegrity's canonical transaction record. They are not a manual reporting service and must not depend on an operator remembering to run them.

V1 product cadence is **monthly**. Statement format **V2** is the current pre-launch format. Each run covers the immediately preceding UTC calendar month.

- Every qualifying merchant receives a merchant statement.
- Every qualifying external partner receives a partner statement.
- `PARTNER-0001` / house-channel statements are generated and retained even when no external delivery address is configured.
- Statements are generated from canonical Builtegrity records; the PDF is a rendered view, not the source of truth.

## State semantics

Monthly reporting must preserve the system's three independent transaction axes.

- `PROTECTED`, `OBSERVED`, and `IMPORTED` are record/source/revenue classifications.
- `ACCOUNTED` is an integrity/completeness state.
- payment and payout status are lifecycle/processor facts.

A successful OBSERVED payment is **not protected volume**. A transaction contributes to protected count/volume only when `record_classification='PROTECTED'`.

## Fee semantics

V2 deliberately shows different economic facts separately:

1. **Exact transaction-fee entitlement** — fee economically attributed to the protected transaction, stored in micros.
2. **Gross application-fee cash** — processor-confirmed application fee on that payment. It can include whole cents of prior carry.
3. **Current retained Builtegrity fee cash** — application-fee cash still retained after later fee refunds/credits.
4. **Prior fractional carry settled** — prior sub-cent entitlement collected on this later protected payment.
5. **Current residual generated** — the sub-cent remainder produced by the current protected transaction.

Carry settled on a later transaction is cash collection of prior entitlement. It must not be described as new fee entitlement earned by that later transaction.

## Merchant statement

Merchant V2 statements contain a summary and transaction-level detail including:

- Builtegrity transaction ID;
- customer reference/name available to that merchant;
- purchase/order reference;
- amount/currency;
- record classification;
- exact transaction-fee entitlement;
- gross application-fee cash;
- current retained fee cash;
- prior carry settled;
- payment status;
- payout status;
- integrity status;
- exception status.

The summary includes transaction count, PROTECTED count/volume, exact transaction-fee entitlement, gross application-fee cash, current retained Builtegrity fee cash, prior carry settled, ACCOUNTED count, and exceptions.

## Partner statement

Partner statements are summarized **by merchant**, not by individual merchant customers. The same protected/fee semantics apply, but customer-level detail is withheld by default.

This is a privacy boundary: partner reporting does not automatically grant access to merchant customer detail. More granular access requires explicit authorization.

## Automation lifecycle

The Cloudflare scheduled runtime invokes the monthly statement reconciler repeatedly. Re-running is safe and expected.

`SEED -> SNAPSHOT -> RENDER -> STORE -> PREPARE DELIVERY -> SUBMIT -> PROVIDER CONFIRMATION -> DELIVERED`

The reconciler:

1. determines the prior UTC calendar month;
2. creates at most one V2 statement identity per scope/period;
3. claims generation work with a database state transition;
4. snapshots source data into immutable JSON;
5. hashes the source snapshot;
6. renders a deterministic PDF;
7. hashes and stores the PDF in private R2;
8. creates one idempotent delivery record per recipient;
9. submits through Resend with an idempotency key;
10. waits for a verified provider delivery event before final delivery state;
11. retries safe pre-acceptance failures with bounded backoff;
12. raises persistent alerts rather than dropping failures.

## Provider acceptance is not delivery

A successful Resend API submission proves provider acceptance, not recipient-mail-server delivery. Builtegrity therefore relies on signed provider delivery events before final delivery state is considered proven.

The webhook endpoint is:

`POST /api/records/resend-statement-webhook`

The production webhook must include the required sent/delivered/delayed/bounced/failed/suppressed/complained event families and must validate the raw-body signature using the configured Resend webhook secret. Accepted provider events are durable and deduplicated.

## Reliability and immutability

The operating target is at least **99.9% availability for Builtegrity-controlled statement generation, persistence, and delivery orchestration**. This is an SLO, not a guarantee that a third-party mailbox will accept mail.

The design uses durable generation rows, automatic lease recovery, idempotent email submission, immutable source snapshots, append-only item/provider evidence, SHA-256 verification, R2 durability, persistent alerts, and CI.

A generated statement cannot be silently rewritten. If reporting semantics change, Builtegrity issues a new statement version rather than mutating the historical artifact. V2 exists specifically because protected-classification and fee/carry attribution are materially clearer than V1.

## Time boundary

Statement membership is based on the Builtegrity transaction's `created_at` timestamp within the UTC calendar month. That gives each transaction a deterministic statement home and prevents later processor events from silently moving it between already-issued statements.

Later refunds/disputes/payout events remain in canonical transaction history. Future statement versions can add subsequent-period adjustment sections without rewriting prior statements.

## Representation boundary

A Builtegrity statement is an operational transaction-integrity statement. It is not a bank statement, processor official statement, tax return, audit opinion, accounting opinion, legal opinion, chargeback insurance, or loss guarantee.

## Production activation checklist

The monthly-statement subsystem is not production-complete until:

1. all ordered D1 migrations through the current head—including `0060_monthly_statement_semantic_alignment.sql`—are applied;
2. the production Worker includes the matching V2 runtime;
3. `TRANSACTION_RECORDS` is the private production R2 bucket;
4. Resend production sender/API/webhook secrets are configured;
5. merchant/partner statement recipients are valid;
6. monthly-statement CI passes on the exact production commit;
7. an end-to-end drill proves V2 generation, R2 persistence, provider submission, signed delivery confirmation, retrieval/hash verification, and immutable history;
8. external monitoring detects a dead scheduled Worker/readiness path;
9. `npm run system:gate:live` passes before live-money release.

Once those gates are satisfied, recurring operator action is not part of the normal monthly statement workflow.

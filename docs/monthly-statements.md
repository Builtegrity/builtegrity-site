# Automated Monthly Transaction Statements

## Product rule

Monthly statements are a permanent automated output of Builtegrity's canonical transaction record. They are not a manual reporting service and must not depend on an operator remembering to run them.

V1 cadence is **monthly**. Each run covers the immediately preceding UTC calendar month.

- Every qualifying merchant receives a merchant statement.
- Every qualifying external partner receives a partner statement.
- `PARTNER-0001` / house-channel statements are still generated and retained even when no external delivery address is configured.
- Statements are generated from canonical Builtegrity records; the PDF is a rendered view, not the source of truth.

## Merchant statement

The merchant statement contains a monthly summary plus transaction-level detail. Each transaction line can include:

- Builtegrity transaction ID
- customer reference/name available to that merchant
- purchase/order reference
- amount and currency
- Builtegrity fee recorded
- payment status
- payout status
- integrity status
- exception status

The monthly summary includes transaction count, successful protected volume, Builtegrity fees recorded, accounted transactions, and transactions needing attention.

## Partner statement

The partner statement is deliberately summarized **by merchant**, not by the merchant's individual customers. It includes merchant-level transaction counts, protected volume, Builtegrity fees, accounted counts, and exception counts.

This is a privacy boundary: partner reporting does not automatically grant access to merchant customer detail. More granular access must be an explicit authorization decision, never an accidental consequence of reporting.

## Automation lifecycle

The existing Cloudflare scheduled runtime invokes the monthly statement reconciler every 15 minutes. Re-running is safe and expected.

The pipeline is:

`SEED -> SNAPSHOT -> RENDER -> STORE -> PREPARE DELIVERY -> SUBMIT -> PROVIDER CONFIRMATION -> DELIVERED`

The reconciler:

1. determines the prior UTC calendar month;
2. creates at most one V1 statement identity per scope and period;
3. claims generation work with a database state transition;
4. snapshots the source data into immutable JSON;
5. hashes the source snapshot;
6. renders a deterministic PDF from that snapshot;
7. hashes and stores the PDF in private R2 storage;
8. creates one idempotent delivery record per recipient;
9. submits the email through Resend with an idempotency key;
10. waits for a verified Resend delivery event before marking the delivery complete;
11. retries work that failed before provider acceptance using bounded exponential backoff;
12. raises persistent system alerts instead of silently dropping failures.

## Why provider acceptance is not called delivery

An HTTP success from the Resend send-email API only proves that Resend accepted the message. It does not prove that the recipient's mail server accepted it.

Builtegrity therefore keeps an accepted email in `SENDING` until a verified `email.delivered` webhook arrives. `email.bounced`, `email.failed`, `email.suppressed`, and `email.complained` become persistent delivery failures/alerts instead of false successes. `email.delivery_delayed` remains pending and creates a warning.

The webhook endpoint is:

`POST /api/records/resend-statement-webhook`

It must be configured in Resend for at least:

- `email.sent`
- `email.delivered`
- `email.delivery_delayed`
- `email.bounced`
- `email.failed`
- `email.suppressed`
- `email.complained`

Webhook payloads are accepted only after Svix-compatible signature verification using the raw request body plus `svix-id`, `svix-timestamp`, `svix-signature`, and `RESEND_WEBHOOK_SECRET`. A timestamp tolerance prevents replay of stale signed requests. Every accepted event is stored append-only and deduplicated by event ID.

## Reliability model

The operating target is at least **99.9% availability for Builtegrity-controlled statement generation, persistence, and delivery orchestration**. This is an SLO target, not a promise that every third-party mailbox will accept mail.

The design avoids single-attempt behavior:

- generation rows are durable in D1;
- generation and pre-submission delivery failures retry automatically;
- stale worker leases recover automatically;
- email submission has an idempotency key;
- accepted provider messages are never duplicated merely because the delivery webhook is late;
- provider delivery events are independently persisted;
- statement source snapshots cannot be silently rewritten;
- generated statement PDFs are SHA-256 verified when retrieved or attached;
- R2 stores the durable rendered artifact;
- system alerts make unresolved failures visible;
- operator routes allow inspection and reconciliation without being required for routine monthly operation;
- GitHub CI independently validates schema and core invariants.

No system should claim a literal 100% delivery guarantee. Recipient mailbox failures, bad addresses, provider outages, DNS problems, or external network failures are outside Builtegrity's absolute control. Builtegrity's responsibility is to detect those states, preserve the statement, retry what is safe to retry, and never report success when success is unproven.

## Statement immutability

The source snapshot is frozen before rendering. Its SHA-256 is stored with the statement. The rendered PDF is separately hashed.

After a statement is generated, its period, scope, summary, source snapshot, storage key, hash, and PDF length cannot be silently changed. Transaction item snapshots and Resend event records are append-only.

If Builtegrity later needs to issue a corrected statement, it should create a new statement version rather than mutate the historical V1 artifact.

## Time boundary

V1 statement membership is based on the Builtegrity transaction's `created_at` timestamp within the UTC calendar month. This gives every transaction one deterministic monthly home and prevents late processor events from moving transactions between already-issued statements.

Later payment, refund, dispute, or payout events remain in the canonical transaction history. A future reporting version can add explicit subsequent-period adjustment sections without rewriting prior statements.

## Compliance / representation boundary

The statement must describe itself accurately. It is a Builtegrity operational transaction-integrity statement, not:

- a bank statement;
- a processor's official statement;
- a tax filing or tax return;
- an audit opinion;
- an accounting opinion;
- a legal opinion;
- chargeback insurance or a guarantee against loss.

Merchant statements may contain merchant/customer transaction information and therefore must remain tenant-scoped. Partner statements default to merchant-level summaries to avoid unnecessary customer-data disclosure.

## Production activation checklist

The monthly-statement subsystem is not production-complete until all of the following are true:

1. D1 migrations `0020` through `0023` are applied to the production database.
2. The production Worker includes the statement runtime code.
3. `TRANSACTION_RECORDS` points to the private production R2 bucket.
4. `RESEND_API_KEY` is configured as a Worker secret.
5. `STATEMENT_EMAIL_FROM` is a verified Resend sender on the Builtegrity domain.
6. A Resend webhook is created for the production endpoint and required event types.
7. Its signing secret is stored as the Worker secret `RESEND_WEBHOOK_SECRET`.
8. Every external partner that should receive statements has `partners.statement_email` configured.
9. Every merchant has a valid `merchants.statement_email` or fallback merchant email.
10. The monthly-statements CI workflow passes on the exact production commit.
11. A test statement proves generation, R2 persistence, email submission, signed webhook receipt, `email.delivered` confirmation, and immutable audit storage end to end.
12. External runtime monitoring alerts if the scheduled Worker or public readiness path stops operating.

Once these gates are satisfied, no recurring monthly operator action is part of the normal statement workflow.

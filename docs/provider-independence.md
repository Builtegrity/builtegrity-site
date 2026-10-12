# Builtegrity provider-independence rule

Builtegrity must remain operable if ChatGPT, Work, a connector, an authentication provider, or a hosting vendor is removed.

## Canonical ownership

- GitHub is the canonical source of application code and migrations.
- Runtime accounts, domains, secrets, databases, payment-platform accounts, and backups belong to Builtegrity/the owner rather than an AI workspace.
- ChatGPT and Work may assist with engineering and operations, but they are not runtime dependencies.

## Authentication boundary

The Worker runtime owns authentication before requests reach the transaction engine.

Current provider:

- `AUTH_PROVIDER=OWNER_SESSION`
- owner password is stored as a runtime secret (`OWNER_PASSWORD`)
- session signing uses a separate runtime secret (`OWNER_SESSION_SECRET`)
- the browser receives only an HttpOnly signed session cookie
- no admin/access key is stored in sessionStorage/localStorage or typed into the transaction console

Future providers can be added in `worker/src/auth.js` (for example an OIDC/SSO adapter) without changing transaction, payment, event, exception, or Stripe business logic.

Unsupported providers fail closed.

The transaction core still has a legacy internal-header check, but the runtime satisfies it with a random one-request bridge value generated only in memory after operator authentication. There is no configured persistent `INTERNAL_ADMIN_TOKEN` and no browser-visible admin token.

## ChatGPT / Work boundary

ChatGPT may:

- edit the GitHub repository when authorized
- inspect connected services when explicitly connected
- help deploy or diagnose infrastructure
- operate through owner-approved external integrations

ChatGPT must not be required for:

- owner login
- merchant login
- customer payment access
- Stripe webhooks
- transaction lifecycle processing
- database reads/writes by the production service
- payout reconciliation
- transaction/event retention
- secret storage

Disconnecting ChatGPT must not interrupt the product.

## Processor boundary

Stripe is Processor Adapter #1, not the identity of the product. Transaction records store normalized processor identifiers and lifecycle state. Additional adapters (Stripe App, Partner API, Square, other processors) should feed the same core transaction/event/exception model rather than creating a second product architecture.

## Hosting/data boundary

Cloudflare Workers + D1 are the initial runtime target, not a permanent business dependency. Keep:

- portable SQL migrations
- provider-neutral business logic where practical
- exports/backups of durable records
- secrets out of source control
- domain ownership independent from the hosting provider

A future hosting/database migration should change infrastructure adapters, not the transaction model.

## Switching rule

Before adopting any service, ask:

1. What durable data or authority does it hold?
2. Can Builtegrity export that data in a usable format?
3. Can credentials/secrets be moved without changing merchant records?
4. Can a replacement provider be wired at an adapter boundary?
5. Does disabling ChatGPT leave the production system operational?

If the answer to #5 is no, the design is rejected.

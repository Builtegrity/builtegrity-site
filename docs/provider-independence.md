# Builtegrity provider-independence rule

Builtegrity must remain operable if ChatGPT, Work, a connector, an authentication provider, a payment processor adapter, or a hosting vendor is removed.

## Canonical ownership

- GitHub is the canonical source of application code and migrations.
- Runtime accounts, domains, secrets, databases, payment-platform accounts, and backups belong to Builtegrity/the owner rather than an AI workspace.
- ChatGPT and Work may assist with engineering and operations, but they are not runtime dependencies.

## Locked V1 service boundaries

- GitHub: source code, migrations, CI, technical documentation and infrastructure configuration.
- Cloudflare Workers + Static Assets: frontend/site delivery, APIs, Stripe webhooks and transaction-processing runtime. Cloudflare Pages is not a separate V1 dependency.
- Cloudflare D1: operational relational database and live system of record.
- Stripe Connect: Processor Adapter #1 and processor financial truth.
- Clerk: primary application identity/session provider.
- Resend: transactional email adapter.
- Cloudflare Turnstile: public-route bot/abuse protection where appropriate.
- Google Drive / Sheets: company planning and human-readable admin artifacts only; never the transaction backend.

## Authentication boundary

Clerk is the primary V1 identity provider, but it is not the authorization database.

The Worker validates the Clerk session/JWT at the application edge. Builtegrity's own D1 data model owns merchant memberships, roles, tenant boundaries and record permissions. This separation prevents the transaction system from becoming structurally dependent on Clerk-specific tenancy semantics.

Current provider:

- `AUTH_PROVIDER=CLERK`
- Clerk supplies the application identity/session.
- `worker/src/clerk-auth.js` verifies RS256 JWT signatures using Clerk public verification material and validates issuer/authorized-party constraints.
- owner/admin access can be restricted to configured Clerk user IDs initially; this should graduate to D1-backed user/role/membership records as merchant multi-tenancy is introduced.
- Builtegrity never stores the user's Clerk password.

Alternative identity providers remain adapter-level replacements. The existing Cloudflare Access adapter may be retained for optional infrastructure defense-in-depth but is not the primary product login. The local owner-session adapter exists only as a portability/development fallback.

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

## Email boundary

Resend is an outbound delivery adapter. Transaction state must never depend on successful email delivery. Payment lifecycle and webhook processing complete independently; notification failures are observed/retried separately.

## Abuse-protection boundary

Turnstile may protect appropriate public form or action entry points. It must never be used as authentication and must not sit in front of processor webhook endpoints such as Stripe webhooks.

## Hosting/data boundary

Cloudflare Workers + D1 are the initial runtime target, not a permanent business dependency. Keep:

- portable SQL migrations
- provider-neutral business logic where practical
- exports/backups of durable records
- secrets out of source control
- domain ownership independent from the hosting provider

A future hosting/database migration should change infrastructure adapters, not the transaction model.

## Secret-location rule

Secrets remain inside owner-controlled provider/runtime secret stores. Google Drive, Google Sheets, GitHub source, and chat may document the *name and intended location* of a credential, but never the credential value itself.

## Switching rule

Before adopting any service, ask:

1. What durable data or authority does it hold?
2. Can Builtegrity export that data in a usable format?
3. Can credentials/secrets be moved without changing merchant records?
4. Can a replacement provider be wired at an adapter boundary?
5. Does disabling ChatGPT leave the production system operational?

If the answer to #5 is no, the design is rejected.

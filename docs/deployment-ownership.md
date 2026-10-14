# Deployment ownership and domain cutover

Builtegrity must have one authoritative live application runtime per public domain.

## Current pre-launch state

`builtegrity.com` is currently attached to GitHub Pages. That Pages deployment is a **temporary pre-launch compatibility shell only**. It may publish:

- the static pre-launch homepage;
- static privacy/legal drafts;
- the bounded stylesheet/404/robots/sitemap files required by that shell.

It must not publish the transaction application, transaction console, payment/customer routes, Worker source, database migrations, transaction-engine fixtures, operating documentation, scripts, owner-control files, or other internal repository directories.

The root `_config.yml` is the repository-side boundary for the temporary Pages artifact.

## Canonical application runtime

The intended LIVE application/runtime is:

- Cloudflare Worker for APIs, processor webhooks, authorization and transaction logic;
- Worker Static Assets using `public/` as the application asset root;
- Cloudflare/DNS custom-domain routing for the live Builtegrity application.

GitHub is source control and CI. GitHub Pages is not the transaction runtime.

## Root shell versus `public/`

These are intentionally different surfaces.

- Root `index.html` = GitHub Pages pre-launch shell. It must not link to `/console/`, `/pay/`, `/login/`, or any route that requires the Worker.
- `public/index.html` = Cloudflare application landing page. It may link to application routes because the Worker serves them.
- Static legal/privacy documents may be mirrored root ↔ `public/` when the byte-identical mirror is intentional.

Do not reintroduce a rule that root `index.html` must equal `public/index.html`.

## LIVE cutover rule

Before `TX-LIVE-0001` may pass:

1. `builtegrity.com` must be bound to and verified against the intended Cloudflare Worker/Static Assets deployment.
2. `/console/`, `/pay/`, `/login/`, API, webhook and health routes must resolve through the Worker as designed.
3. GitHub Pages must no longer claim `builtegrity.com` as its custom domain. Pages may be disabled or moved to a non-production compatibility hostname.
4. The root `CNAME`/GitHub Pages custom-domain configuration must be removed only as part of the coordinated cutover, not prematurely while Pages is still the temporary shell.
5. DNS/TLS and rollback behavior must be tested.
6. `ops/system-contract.json.deployment_ownership.verification_status` may become `VERIFIED` only after the above is independently proven.

Two platforms must never both be treated as authoritative owners of the same production domain.

## Why this gate exists

A green application test suite cannot detect DNS/provider ownership conflicts. Without this boundary, GitHub Pages can successfully deploy a static repository while the product architecture simultaneously assumes Cloudflare owns the live application. That can create broken routes, stale legal/public content, duplicate application copies, or a false sense that a payment endpoint is live when only a static host is serving the domain.

Deployment ownership is therefore a production-readiness fact, not merely a hosting preference.

# Builtegrity admin authentication — Cloudflare Access

## Production choice

The Builtegrity internal/operator console uses Cloudflare Access as its production authentication gate.

Recommended production shape:

- Admin hostname: `admin.builtegrity.com`
- Identity provider: Cloudflare account
- Access policy: allow only explicitly authorized Builtegrity Cloudflare account members
- Require MFA at the Cloudflare account / Access policy layer
- Worker auth adapter: `AUTH_PROVIDER=CLOUDFLARE_ACCESS`
- Worker verifies the signed `Cf-Access-Jwt-Assertion` before treating a request as an operator

Customer payment pages and Stripe webhooks must not be placed behind the admin Access application.

## Required Worker variables

These are configuration values, not secrets:

- `CF_ACCESS_TEAM_DOMAIN` — `https://<team-name>.cloudflareaccess.com`
- `CF_ACCESS_AUD` — the Access application's Audience (AUD) tag

Optional defense-in-depth:

- `CF_ACCESS_ALLOWED_EMAILS` — comma-separated emails permitted by the Worker after Access succeeds

The Access policy remains the primary authorization gate. The Worker JWT check is defense in depth and fails closed if the token, issuer, audience, signature, or optional allowlist does not validate.

## Cloudflare dashboard setup

1. Enable Zero Trust on the Builtegrity Cloudflare account.
2. Create/attach `admin.builtegrity.com` to the transaction Worker.
3. Create a self-hosted Access application for `admin.builtegrity.com`.
4. Choose **Cloudflare account** as the login method / policy selector.
5. Restrict the policy to the Builtegrity account members who should operate the transaction console.
6. Require MFA/independent MFA where appropriate.
7. Copy the team domain and application AUD tag into the Worker variables.
8. Keep customer/public payment and Stripe webhook hostnames outside this Access application.

## Portability

Cloudflare Access is an authentication adapter, not part of the transaction model. The existing `OWNER_SESSION` adapter remains available as a portable fallback, and other OIDC/SSO providers can be added without changing transaction, Stripe, event, exception, consent, or payout logic.

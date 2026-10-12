# Builtegrity optional infrastructure authentication — Cloudflare Access

## Status

Cloudflare Access is **not** the primary Builtegrity product-authentication system.

Primary V1 application identity is Clerk. Builtegrity/D1 owns roles, merchant membership and record authorization.

Cloudflare Access remains available as optional defense in depth for highly sensitive internal or infrastructure-only surfaces if we later want an additional perimeter outside the application login.

## Appropriate use

Possible future use:

- infrastructure-only admin utilities;
- emergency/operator tooling;
- staging environments;
- highly sensitive internal surfaces that should require both application identity and a Cloudflare perimeter.

Do not place customer payment pages or Stripe webhooks behind Cloudflare Access.

## Optional configuration

If enabled for an internal hostname such as `admin.builtegrity.com`, the existing Worker adapter can validate the signed `Cf-Access-Jwt-Assertion` with:

- `AUTH_PROVIDER=CLOUDFLARE_ACCESS` only when deliberately selecting this adapter;
- `CF_ACCESS_TEAM_DOMAIN`;
- `CF_ACCESS_AUD`;
- optional `CF_ACCESS_ALLOWED_EMAILS`.

That adapter is retained for portability/defense in depth and should not be confused with the locked V1 application identity path.

## Locked V1 auth

See the Clerk configuration and the transaction-engine runbook. The default V1 runtime uses `AUTH_PROVIDER=CLERK`.

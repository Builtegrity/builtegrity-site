# Builtegrity V1 application authentication — Clerk

## Role

Clerk is the V1 application identity/session provider.

Clerk answers: **Who is this user?**

Builtegrity/D1 answers: **Which merchant(s), roles, and records may this user access?**

Do not use Clerk Organizations as the permanent Builtegrity merchant hierarchy in V1. Merchant tenancy and authorization belong in Builtegrity's own relational model so the identity provider remains replaceable.

## Initial proving setup

For TX-0001 / owner-console testing:

1. Create an owner-controlled Clerk account/application for Builtegrity.
2. Use the Clerk development/test environment first.
3. Enable a simple sign-in method suitable for the owner account; require MFA before live administrative access.
4. Create the first owner user.
5. Enable/use Clerk Account Portal for the initial hosted sign-in/account surface.
6. Configure Builtegrity application origins/authorized parties for the Worker hostnames used in test and production.
7. Copy the non-secret/public configuration values into Worker configuration.
8. Put environment-specific verification material/configuration in the Worker environment, not in Google Drive or chat.

## Worker configuration

Expected variables:

- `AUTH_PROVIDER=CLERK`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_ISSUER`
- `CLERK_AUTHORIZED_PARTIES`
- `CLERK_ADMIN_USER_IDS`
- `CLERK_SIGN_IN_URL`
- `CLERK_USER_URL`
- `CLERK_JWT_KEY`

`CLERK_ADMIN_USER_IDS` is an intentionally temporary owner/operator allowlist for the pre-multi-tenant proving stage.

Before real merchant users are onboarded, add Builtegrity-owned identity/authorization tables in D1, for example:

`users -> merchant_memberships -> roles/permissions`

The Clerk user ID becomes an external identity reference on a Builtegrity user record rather than the merchant/customer primary key.

## Validation

`worker/src/clerk-auth.js` verifies:

- RS256 JWT signature;
- token expiry / not-before;
- issuer;
- authorized party when configured;
- temporary owner/admin user allowlist for operator access.

Authentication failures fail closed.

## Separation from public payment links

A customer receiving an unguessable transaction payment token does not automatically need a Clerk account for the V1 payment/consent route. Customer identity requirements can evolve separately from merchant/staff authentication.

## Separation from Stripe

Clerk identity never determines whether a Stripe webhook is valid. Stripe webhooks are authenticated only by Stripe's webhook-signature mechanism and must remain reachable without Clerk or Turnstile.

## Optional Cloudflare Access

Cloudflare Access may later sit outside selected internal/infrastructure surfaces as defense in depth, but it is not the application identity database and is not required for merchant/customer application login.

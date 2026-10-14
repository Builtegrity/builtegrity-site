# Deployment ownership and production-domain cutover

Builtegrity must have exactly one authoritative production application runtime for each public production hostname.

## Canonical LIVE owner

For V1, the authoritative production application runtime is:

- Cloudflare Worker + Worker Static Assets
- canonical application assets: `public/`
- canonical production domain: `builtegrity.com`
- administrative application hostname: `admin.builtegrity.com`

GitHub Pages is not the production transaction runtime.

## Current pre-launch exception

GitHub Pages currently deploys the repository root to the custom domain `builtegrity.com`. The deployed root page is explicitly marked as a test environment and states that no live merchant funds should move until production readiness is complete.

That arrangement is tolerated only during PREVIEW/TEST because no live transaction traffic is authorized. It creates a deliberate LIVE blocker: GitHub Pages and Cloudflare Worker must not both claim ownership of the same production hostname.

## Required cutover before LIVE

Before `TX-LIVE-0001` may pass the system gate:

1. Deploy the intended Cloudflare Worker/Static Assets application with the production D1/R2/configuration bindings.
2. Verify owner-controlled Cloudflare account recovery and deployment/rollback authority.
3. Configure the intended Cloudflare routes/custom domains for `builtegrity.com` and any required application/admin hostnames.
4. Remove `builtegrity.com` as the GitHub Pages custom domain.
5. Remove or change the repository root `CNAME` so it no longer points at `builtegrity.com`.
6. Verify DNS/HTTP routing from outside the Cloudflare account and prove that `builtegrity.com` reaches the intended Worker/Static Assets deployment.
7. Verify `/api/health/ready` on the production runtime and confirm that static application routes and Worker API routes share the intended origin.
8. Only then set `ops/system-contract.json -> deployment_ownership.verification_status` to `VERIFIED` through a reviewed PR.

A GitHub Pages mirror may remain only on a non-production compatibility hostname that cannot receive production application/payment traffic.

## Failure rule

If production hostname ownership is ambiguous, unknown, split, or has reverted to GitHub Pages, LIVE must fail closed. Do not create new protected payments until routing ownership is restored and independently verified.

## External GitHub administration

The connected GitHub App has repository content write access but not repository administration access. It therefore cannot itself:

- disable/change GitHub Pages custom-domain settings;
- configure main-branch protection or required checks;
- update stale repository description metadata.

Those are owner/admin actions. Code and CI must record them as external evidence requirements rather than pretending they are complete.

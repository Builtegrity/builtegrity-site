# Stripe observation pilot: owner laptop checklist

**Status: PRE-PRODUCTION. No live billing or payments are authorized by this checklist.**
**Source:** Builtegrity/builtegrity-site; branch feature/stripe-observation-fee-proof-20261114 stacked on the draft usage-billing foundation PR #69.

## Goal
Use a voluntarily enrolled Stripe test merchant's **existing** checkout to generate a signed Stripe event; retrieve payment evidence from that same authorized account; generate a distinct OBSERVED Builtegrity record; and prove the 3%-of-qualifying-payment fee **without collecting money**.

This is a code/test preparation guide. It does not say the full ingestion, D1 persistence, billing or partner integration has been built.

## Actions the owner can take now, on a laptop

1. Open the repository and review PR #69 (usage-billing foundation) and the stacked Stripe observation proof PR. Do not merge without CI, review and successful local tests.
2. Open https://dashboard.stripe.com and verify owner access. Use test mode or a Stripe sandbox. Confirm the intended Builtegrity platform account, whether the account supports the proposed connected-account model, and which integration permissions are actually available. Do not assume another platform's connected account can be observed.
3. Open https://dash.cloudflare.com and check the intended account has Workers, D1, R2 and appropriate domain authority. Do not activate live routes before the canonical deployment/owner-recovery gates pass.
4. Review https://github.com/Builtegrity/builtegrity-site/blob/main/docs/MASTER.md. It currently describes a different, hosted-checkout/application-fee canonical commercial model. It needs an approved, versioned migration before any live observation-based billing.
5. Verify that you personally control domain, GitHub administration, Stripe, Cloudflare, Clerk, Resend and the recovery vault. Keep ALL secrets only in approved provider stores; never paste API secrets, OAuth tokens, bank details or MFA codes in GitHub or chat.
6. Request one voluntary pilot merchant that already uses its own Stripe payment flow. Its account must be eligible and able to consent to data access. A partner introduction alone is not merchant authorization.

## Laptop development smoke test (no production keys)
- Install Git and a supported Node.js runtime, then clone the repository.
- `git fetch origin`
- `git switch feature/stripe-observation-fee-proof-20261114`
- `npm install`
- `node --test tests/stripe-observation-proof.test.mjs`
- `npm run system:gate`
- `npm run system:gate:live` is the separate all-system release gate and is **expected to block** while owner/commercial/legal/runtime evidence is incomplete.

## Work still needed after the pure-proof tests
1. Decide the supported Stripe observation authorization mode (Stripe App vs compatible Connect account), verified minimum read scopes and connected-account restrictions; do not use write-capable permissions just for reporting.
2. Connect raw signed Stripe webhooks and server-side account-scoped payment/charge retrieval into an authorized durable inbox. Import a merchant's *independently created* test payment, and reconcile webhooks/backfill.
3. Persist normalized merchant-scoped OBSERVED records and evidence with additive D1 migrations, independent of any Builtegrity-controlled Checkout metadata. Avoid declaring payout/bank completion unless verified.
4. Persist an immutable economic key that is unique **across pricing agreement versions**; guarantee at most one chargeable component per original processor payment. Finish refund/dispute and cancellation handling.
5. Require an approved merchant-facing pricing agreement, tax/refund disclosures and signed billing consent. The currently proposed 3% remains an unapproved **test policy**.
6. Build and test automatic collection independently of merchant payment flow. Provider-native balance collection is only supported with explicit provider authorization; otherwise use separately authorized Stripe Billing/payment method. Model collection, invoice/settlement, partner commission and cash availability as separate facts.
7. Produce a monthly itemized statement with original transaction IDs, gross volumes, fees, adjustments, collections, partner sharing if applicable, and optional contributions kept strictly separate.
8. Run adversarial tests (replay, out-of-order, cross-tenant, partial refunds, credit disputes, data gaps, disconnect, credentials, backup/restore), complete security/privacy/commercial/legal, Stripe compliance and owner-recovery release gates, and then seek explicit approval for a restricted live pilot.

## Do not do
- Do not switch `DEV_MODE=false` and deploy live merely because the new pure tests pass.
- Do not install a second application fee on any transaction already covered by the historical protected-checkout lane.
- Do not automatically debit an existing merchant's balance from an observation-only authorization.
- Do not enable optional charitable funding until the donor authorization, custody/funding path, provider receipt and applicable legal/tax checks are verified.

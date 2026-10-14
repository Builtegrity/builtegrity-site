# Builtegrity Production Readiness Gate

No live customer payment may move through Builtegrity until every blocking gate below is satisfied. A technically working deployment is not permission to process live money.

The exact release target is `TX-LIVE-0001`.

Before any LIVE release, run:

`npm run system:gate:live`

That whole-system gate is additive to runtime/D1 readiness. It does not replace processor, legal, security, tax, financial, source-control, domain-ownership, or deployment drills.

## Gate A — System coherence and canonical truth — BLOCKING

- [ ] `ops/system-contract.json` matches runtime/migrations/docs.
- [ ] `npm run system:coherence` passes.
- [ ] Ordered `migrations/*.sql` are the only canonical database schema; no competing standalone schema snapshot exists.
- [ ] Historical migrations remain frozen and later corrections are additive.
- [ ] Transaction lifecycle, integrity, and record classification remain separate axes.
- [ ] `ACCOUNTED` is an integrity/completeness state; `PROTECTED` is a record/revenue classification.
- [ ] `PROTECTED`, `OBSERVED`, and `IMPORTED` are reported distinctly.
- [ ] Static legal/privacy documents exactly match their canonical mirrored `public/` copies where a mirror is intentional.
- [ ] Root GitHub Pages `index.html` and Worker `public/index.html` remain intentionally different entry points.
- [ ] Pricing, refund economics, financial-safety limits, statements, tax summaries, books, and legal disclosures use the same semantic definitions.

**Pass condition:** the same transaction produces the same classification/economic interpretation in runtime, D1, statements, tax workpapers, books, alerts, legal copy, and CI; deployment surfaces do not pretend two different runtimes are the same application.

## Gate B — Stripe architecture and funds flow — BLOCKING

- [ ] Stripe platform is activated in test mode.
- [ ] A real test merchant can connect an eligible existing Stripe account through the intended Connect route.
- [ ] Merchant remains seller/merchant of record for its goods/services.
- [ ] Builtegrity does not custody merchant proceeds.
- [ ] Direct-charge Checkout succeeds on the merchant connected account.
- [ ] Builtegrity application fee is created and processor-confirmed.
- [ ] Exact Connect processing-fee/payment-loss responsibility is confirmed for the launch account type.
- [ ] Automatic payouts are enforced for full V1 functionality.
- [ ] Merchants already controlled by an incompatible Connect platform are detected/handled rather than silently mis-onboarded.
- [ ] Whole-cent Stripe application-fee collection is reconciled with exact internal micros and merchant-scoped fractional carry.

**Pass condition:** a test transaction moves consent -> legal clearance -> payment -> application fee -> PROTECTED -> Balance Transaction -> automatic payout -> payout-paid reconciliation with no manual database edits.

## Gate C — Pricing and Platform Fee economics — BLOCKING

- [ ] Implemented pricing version is the intended commercial version.
- [ ] Pricing has an explicit owner lock in `ops/system-contract.json`; implementation alone is not approval.
- [ ] Fee/refund economic default has an explicit owner lock.
- [ ] Applicable fee/refund legal status is APPROVED rather than `PENDING_COUNSEL`.
- [ ] Merchant-facing Fee Schedule exactly matches the server implementation.
- [ ] No client/merchant/customer caller can override pricing version, fee, carry, or fee/refund-policy fields.
- [ ] Exact fee entitlement, application-fee cash, current retained cash, residual accrual, and prior carry settlement are separately auditable.
- [ ] Current-transaction fractional residual becomes entitled only after PROTECTED.
- [ ] Reserved prior carry settles only when the later payment itself becomes PROTECTED.
- [ ] Failed, OBSERVED, IMPORTED, pending, and unresolved fee-exception transactions cannot create protected transaction-fee entitlement/revenue.
- [ ] Refund/dispute fee treatment is selected only from an approved, tested jurisdiction/processor handler and fails closed when unknown/expired.

**Pass condition:** one canonical commercial policy can be traced from owner lock -> legal approval -> merchant disclosure/acceptance -> transaction snapshot -> processor collection -> entitlement/carry evidence -> ledger -> statement -> books.

## Gate D — Transaction evidence integrity — BLOCKING

- [ ] Every transaction receives a permanent internal TX ID.
- [ ] Customer-facing URLs use random access tokens rather than guessable TX IDs.
- [ ] Exact terms are snapshotted and hashed before acceptance.
- [ ] Consent time/method and legal-document versions are preserved.
- [ ] Customer jurisdiction attestation and applicable pre-checkout legal clearance are preserved before protected Checkout.
- [ ] Browser redirect cannot mark payment successful.
- [ ] Stripe webhook signatures are verified from the raw body.
- [ ] Duplicate/out-of-order webhooks are idempotent.
- [ ] Processor truth is recorded even when a protection/legal prerequisite is missing; missing prerequisites block PROTECTED rather than discarding Stripe facts.
- [ ] Transaction events cannot be silently updated/deleted.
- [ ] PROTECTED history cannot be erased by later refund/dispute status.
- [ ] Refunds, disputes, fee refunds, payout failures, carry corrections, and other corrections append evidence rather than rewrite original truth.

**Pass condition:** the transaction can reconstruct what was offered, accepted, legally cleared, paid, charged, protected/observed/imported, included in payout, adjusted later, and why.

## Gate E — Failure, recovery, and adversarial ordering — BLOCKING

Intentionally test:

- [ ] payment failure and abandoned Checkout;
- [ ] duplicate/out-of-order/delayed Stripe webhook;
- [ ] application-fee event before/after payment event;
- [ ] payment truth and application-fee truth arriving in the same update/event window;
- [ ] complete processor truth with missing pre-checkout legal evidence remains non-PROTECTED in every event order;
- [ ] current fractional residual does not accrue on payment success alone;
- [ ] carry reservation + abandoned-checkout release;
- [ ] carry-funded payment success with missing/mismatched BG fee remains FEE_EXCEPTION and keeps reserved carry releasable;
- [ ] carry-funded PROTECTED payment settles reserved carry exactly once;
- [ ] simultaneous carry reservation attempts;
- [ ] partial/full customer refund;
- [ ] partial/full Platform Fee refund under each approved handler;
- [ ] dispute opened/won/lost;
- [ ] payout failure/reversal states supported by Stripe evidence;
- [ ] temporary Builtegrity outage while Stripe continues;
- [ ] D1 restore and R2 hash-verified artifact recovery.

Unresolved failure must become an explicit exception/attention/review state rather than false completion/protection/accounting.

## Gate F — Access, privacy, and data isolation — BLOCKING

- [ ] `DEV_MODE=false` in production.
- [ ] Production Clerk/authentication is configured.
- [ ] Tenant authorization prevents Merchant A from traversing Merchant B data.
- [ ] Partner access exposes only authorized attached merchants and approved aggregation.
- [ ] Customer records remain merchant-scoped.
- [ ] Secrets exist only in approved secret stores, never source control.
- [ ] Public payment routes expose minimum required information.
- [ ] Public access tokens can expire/revoke when required.
- [ ] Privileged admin actions are auditable.
- [ ] Privacy request deadlines, retention/deletion, and legal holds operate together without allowing deletion under active hold.

## Gate G — Security and incident/legal bridge — BLOCKING

- [ ] Security incident runbook is tested.
- [ ] High/critical incidents automatically enter legal preservation/review when configured thresholds are met.
- [ ] Incident evidence is durable and immutable/append-oriented.
- [ ] No machine path decides statutory notification law from untrusted text.
- [ ] Counsel can verify notification deadlines and containment requirements through the approved response path.
- [ ] Security alerts and legal alerts cannot silently resolve each other without the required evidence/authority.

## Gate H — Standing counsel / legal-response program — BLOCKING

“Counsel” means an actual qualified outside attorney/law firm retained by Builtegrity under an active engagement. ChatGPT/Atlas/AI is not counsel and cannot become the legal authority by configuration.

- [ ] Qualified payments/technology/corporate counsel is actually engaged.
- [ ] Attorney-client/privilege scope for routed work is confirmed.
- [ ] Legal receiving address/subdomain and signed Resend webhook are working.
- [ ] Standing counsel automatic intake route is working.
- [ ] Signed counsel callback or equivalent verified machine-return path is working.
- [ ] Counsel acknowledgement SLA escalation is tested.
- [ ] Registered-agent physical-service forwarding into the electronic route is tested.
- [ ] Insurer/carrier notice route is configured only after policy notice terms are reviewed.
- [ ] Legal evidence holds cannot release without counsel reference.
- [ ] Legal incidents cannot resolve/dismiss without the required counsel clearance reference.
- [ ] Settlement/admission/waiver/public-statement paths require the applicable counsel/corporate authority.
- [ ] The complete legal incident drill in `docs/legal-incident-autopilot.md` passes.
- [ ] `legal_response_program` is `VERIFIED` in owner-control readiness.

**Pass condition:** an ordinary legal notice can be received, preserved, routed, deadline-controlled, updated, and resolved without the owner manually relaying it, while genuinely nondelegable corporate decisions still reach the owner.

## Gate I — Legal/commercial documents — BLOCKING

- [ ] Platform Agreement approved by qualified counsel.
- [ ] Privacy Notice approved.
- [ ] Fee Schedule approved and matches locked pricing.
- [ ] Fee/refund policy approved and matches locked economics/jurisdiction handlers.
- [ ] DPA, Acceptable Use Policy, Electronic Records Consent, Security disclosure, and subprocessor registry are current/approved as applicable.
- [ ] Retention/deletion and disconnect/termination treatment are defined.
- [ ] Marketing does not imply insurance, fraud/chargeback protection, guaranteed legal enforceability, guaranteed payout, or independent bank-deposit verification.
- [ ] Merchant acceptance evidence is versioned/immutable.

## Gate J — Financial safety — BLOCKING

- [ ] Current pricing-floor evidence meets the 80% minimum planning margin.
- [ ] Human-touch telemetry remains below the configured warning/critical thresholds or the machine has applied the appropriate brake.
- [ ] Current vendor/processor cost models are not expired.
- [ ] Current Stripe platform balance evidence exists.
- [ ] LIVE company financial position comes from an approved BANK/ACCOUNTING/COMPOSITE source rather than manual/test-only evidence.
- [ ] Required runway/reserve/liability checks pass.
- [ ] No prohibited personal guarantee/debt exposure exists under current policy.
- [ ] Financial safety evaluation is fresh and GREEN for the action being taken.

## Gate K — Accounting, tax, and reconciliation — BLOCKING

- [ ] Exact transaction-fee entitlement and processor cash receipt remain separate economic facts.
- [ ] Transaction economics ledger reconciles processor cash to canonical transaction evidence.
- [ ] Fractional carry settlement is not double-counted as new entitlement.
- [ ] Company books sync/reconciliation is tested.
- [ ] Platform Fee refunds/credits are represented as adjustments, not historical rewrites.
- [ ] Tax-responsibility/account-type assumptions for V1 Stripe merchants are current and verified.
- [ ] Year-end summaries keep PROTECTED/OBSERVED/IMPORTED separate and remain informational reconciliation aids rather than tax filings/advice.
- [ ] Applicable business tax/registration obligations and Builtegrity-service tax treatment are approved for launch jurisdiction.

## Gate L — Statements/reporting — BLOCKING BEFORE RELIANCE

- [ ] Statement V2 migration/runtime are deployed together.
- [ ] Successful OBSERVED/FEE_EXCEPTION transactions do not enter protected count/volume.
- [ ] Fee entitlement, gross application-fee cash, retained cash, and carry settled are distinct fields.
- [ ] Merchant and partner statements use the same semantics.
- [ ] Partner statements do not leak merchant customer detail.
- [ ] Source snapshot and rendered PDF are hash-verified/immutable.
- [ ] Resend acceptance is not treated as final recipient delivery without verified provider delivery evidence.
- [ ] End-to-end statement delivery/retry drill passes.

## Gate M — Reliability and monitoring — BLOCKING

- [ ] Production D1 exists and all migrations apply cleanly from zero.
- [ ] Frozen migration lineage passes and production migration state matches the expected lineage.
- [ ] Backup/export/restore procedure has been executed.
- [ ] Missed Stripe activity can be replayed/reconciled.
- [ ] R2 artifact recovery/hash verification has been executed.
- [ ] Persistent alerts cover processor, exceptions, financial safety, statements, tax/compliance, security, legal response, and deployment/readiness state.
- [ ] External monitoring detects when the Worker/cron/readiness path itself stops.
- [ ] Infrastructure limits/costs are monitored before they can drop critical events.

## Gate N — Source control and release governance — BLOCKING

- [ ] `main` branch protection or equivalent GitHub ruleset is enabled.
- [ ] Required production CI status checks cannot be bypassed by an ordinary direct push.
- [ ] Production changes flow through review/merge controls appropriate to the owner/team size.
- [ ] Exact production commit is known and all required workflows are green.
- [ ] Owner can recover GitHub administration without ChatGPT.
- [ ] Owner-controlled off-provider source backup exists.
- [ ] `ops/system-contract.json.source_control.verification_status` is `VERIFIED` only after the above is proven.

The repository may be structurally coherent while this external GitHub administration proof remains unverified. That is expected pre-launch and must block LIVE.

## Gate O — Deployment and domain ownership — BLOCKING

Use `docs/deployment-ownership.md`.

Current pre-launch state may use GitHub Pages as a bounded static shell, but it is not the transaction runtime.

- [ ] GitHub Pages artifact publishes only the bounded static pre-launch shell/legal documents and does not publish `worker/`, `public/`, `migrations/`, `transaction-engine/`, `scripts/`, `ops/`, `docs/`, `templates/`, `assets/`, package files, or other internal application/source directories.
- [ ] Root Pages `index.html` exposes no `/console/`, `/pay/`, `/login/`, API, or webhook route that requires the Worker.
- [ ] Cloudflare Worker + Static Assets is deployed from the exact approved production commit.
- [ ] `public/` is the Worker Static Assets application root.
- [ ] `builtegrity.com` is bound to and verified against the intended Cloudflare Worker/Static Assets deployment.
- [ ] `/console/`, `/pay/`, `/login/`, health, API, and webhook routes resolve through the Worker as designed.
- [ ] GitHub Pages no longer claims `builtegrity.com` as its custom domain before LIVE; Pages is disabled or moved to a non-production compatibility hostname.
- [ ] DNS and TLS are correct and owner-recoverable.
- [ ] Cutover and rollback are tested without two platforms simultaneously being considered authoritative.
- [ ] `ops/system-contract.json.deployment_ownership.verification_status` is `VERIFIED` only after independent proof of single-runtime ownership.

**Pass condition:** exactly one platform owns the production domain/application behavior, and that platform is the intended Cloudflare Worker/Static Assets runtime.

## Gate P — Owner independence and disaster recovery — BLOCKING

Use `docs/owner-independence-and-disaster-recovery.md` and `ops/owner-control-manifest.json`.

- [ ] Domain registrar/root domain authority recoverable by owner.
- [ ] Cloudflare account/runtime/D1/R2 recoverable and deploy/rollback proven.
- [ ] Stripe platform recovery, credential rotation, and emergency payment-route pause proven.
- [ ] Clerk recovery/replacement path proven.
- [ ] Resend outbound/inbound recovery/rotation path proven.
- [ ] Google Workspace super-admin/business mailbox recovery proven.
- [ ] Banking/accounting authority recoverable independently of AI.
- [ ] Owner Emergency Vault exists outside GitHub/Drive/ChatGPT and contains recovery material.
- [ ] No live credential exists only in chat, one person's memory/device, or source control.
- [ ] Owner Zero-AI Drill passes.
- [ ] Every `required_for_live` owner-control system is `VERIFIED`.
- [ ] `npm run owner:gate:live` passes.

## Gate Q — Pilot suitability — BLOCKING BEFORE FIRST LIVE PILOT

- [ ] U.S. merchant with eligible existing Stripe account.
- [ ] Primarily online/card-not-present, one-time payments.
- [ ] Automatic Stripe payouts.
- [ ] Merchant willing to route relevant payments through Builtegrity protected Checkout.
- [ ] Merchant understands the role/limits of PROTECTED.
- [ ] Several real test-mode transactions and failure drills are completed first.
- [ ] Pilot scope/support burden is intentionally bounded and feeds automated case/runbook improvement rather than becoming permanent manual work.

## Release rule

`TX-LIVE-0001` is permitted only when:

1. every applicable blocking gate above is complete;
2. exact production migrations/runtime are deployed and verified;
3. `npm run system:gate:live` passes on the exact production commit;
4. the production runtime/D1 readiness controls independently allow LIVE;
5. `builtegrity.com` has verified single-runtime ownership on the Cloudflare Worker/Static Assets deployment and GitHub Pages no longer owns the production custom domain; and
6. the same end-to-end payment lifecycle has already succeeded in Stripe test mode.

No single green subsystem can override a red/unknown blocking subsystem.
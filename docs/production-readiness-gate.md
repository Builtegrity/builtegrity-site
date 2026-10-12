# Builtegrity Production Readiness Gate

No live customer payment may move through Builtegrity until every **blocking** item below is satisfied. Revenue is not the gate; merchant/customer risk is.

## Gate A — Stripe architecture and funds flow — BLOCKING

- [ ] Builtegrity platform is activated in Stripe test mode.
- [ ] A real test merchant can connect its existing eligible Stripe account through the intended Connect route.
- [ ] Merchant remains the seller / merchant responsible for its goods or services.
- [ ] Builtegrity does not custody merchant proceeds.
- [ ] Direct-charge Checkout succeeds on the connected account.
- [ ] Test application fee is created and received by the platform.
- [ ] Exact Connect fee-responsibility configuration has been confirmed for the launch account type.
- [ ] Merchant with manual payouts is either blocked from full V1 reconciliation or clearly given a reduced product state.
- [ ] Merchant already controlled by another read/write Connect platform is detected/handled rather than silently mis-onboarded.

**Pass condition:** TX-0001 or a successor test transaction moves from consent through Stripe payment, Balance Transaction, application fee, automatic payout reconciliation, and Stripe payout-paid status without manual database edits.

## Gate B — Transaction evidence integrity — BLOCKING

- [ ] Every payment receives a permanent internal TX ID.
- [ ] Customer-facing URLs use random access tokens rather than guessable TX IDs.
- [ ] Exact transaction terms are snapshotted before acceptance.
- [ ] Terms snapshot is hashed.
- [ ] Consent time and acceptance method are stored.
- [ ] Browser redirect cannot mark a payment successful.
- [ ] Stripe webhook signatures are verified from the raw request body.
- [ ] Duplicate webhooks do not duplicate transaction history or economics.
- [ ] Transaction events cannot be updated or deleted through normal application behavior.
- [ ] Refunds, disputes, and payout failures add history rather than erasing prior history.

**Pass condition:** the TX record can reconstruct what was presented, accepted, paid, charged in fees, included in payout, and what later exceptions occurred.

## Gate C — Failure and recovery — BLOCKING

Test all of these intentionally:

- [ ] card/payment failure;
- [ ] abandoned Checkout;
- [ ] duplicate webhook;
- [ ] out-of-order webhook;
- [ ] delayed webhook;
- [ ] partial refund;
- [ ] full refund;
- [ ] dispute opened;
- [ ] dispute closed;
- [ ] payout failure after a prior payout-paid event if Stripe reports one;
- [ ] temporary Builtegrity outage while Stripe continues operating;
- [ ] database restoration/recovery procedure.

- [ ] Failed webhook receipts remain discoverable and retryable.
- [ ] An unresolved failure produces `NEEDS_ATTENTION` rather than a false `ACCOUNTED` state.

**Pass condition:** a temporary application failure cannot make Builtegrity falsely claim that an incomplete transaction is accounted for.

## Gate D — Access and data isolation — BLOCKING

- [ ] Development authentication bypass is disabled (`DEV_MODE=false`).
- [ ] Production console authentication is configured.
- [ ] Merchant A cannot query Merchant B's customers, purchases, transactions, events, or exceptions.
- [ ] Partner access only exposes authorized attached merchants.
- [ ] Stripe/API secrets are stored only as deployment secrets, never committed to Git.
- [ ] Public payment endpoints expose only the minimum information needed for that payment.
- [ ] Public payment access tokens can expire/revoke when required.
- [ ] Admin actions are auditable before outside operators receive access.

**Pass condition:** an unauthenticated or wrong-tenant user cannot traverse the hierarchy into another merchant's records.

## Gate E — Reliability and monitoring — BLOCKING BEFORE RELIANCE

- [ ] D1 production database exists and migrations apply cleanly from zero.
- [ ] A backup/export procedure exists and has been tested at least once.
- [ ] Webhook failures and open exceptions can trigger an operator alert.
- [ ] There is a documented way to reconcile/replay missed Stripe activity after an outage.
- [ ] Infrastructure free-tier usage is monitored before it approaches a limit that could drop webhooks.
- [ ] A named support/contact path exists for pilot merchants.

**Spending trigger:** pay for infrastructure/monitoring as soon as the free configuration creates a credible risk of lost webhooks, insufficient backups, insufficient retention, or downtime that could materially harm a merchant. Do not wait for an arbitrary revenue number.

## Gate F — Merchant promise and legal/commercial wrapper — BLOCKING FOR LIVE COMMERCIAL USE

- [ ] Merchant agreement accurately describes Builtegrity's role.
- [ ] Privacy Notice accurately describes data collected, used, stored, and shared.
- [ ] Fee amount/rule and collection method are disclosed before use.
- [ ] Refund treatment of the Builtegrity fee is disclosed.
- [ ] Data-retention and deletion policy is defined.
- [ ] Disconnect/termination behavior is defined.
- [ ] `ACCOUNTED` is defined narrowly and consistently.
- [ ] Marketing does **not** imply fraud protection, chargeback protection, insurance, guaranteed legal enforceability, guaranteed payout, or independent bank-deposit verification.
- [ ] Exact live Stripe architecture and agreement language have received appropriate legal/compliance review before the first commercial pilot if required by the final funds flow and jurisdiction.

Suggested definition:

> **ACCOUNTED:** The required transaction context, customer acceptance record, Stripe payment records, transaction economics, and applicable automatic-payout trail have been captured, and no unresolved exception is currently recorded.

## Gate G — Pilot launch — BLOCKING BEFORE OPEN SIGNUP

- [ ] First pilot is a U.S. merchant with an existing eligible Stripe account.
- [ ] Merchant primarily accepts online/card-not-present, one-time payments.
- [ ] Merchant uses automatic Stripe payouts.
- [ ] Merchant understands it must route the relevant payments through Builtegrity-created Checkout for full V1 functionality.
- [ ] Support is intentionally manual for the first 1–3 merchants so edge cases are observed.
- [ ] At least several real test-mode transactions have been exercised before any live-mode transaction.

## Gates after the first pilot

These do not block test-mode development, but become mandatory before broader distribution:

- production role-based authentication instead of the temporary internal token;
- automated merchant onboarding and eligibility checks;
- formal incident-response procedure;
- stronger monitoring and alerting;
- retention/backups sized to real transaction volume;
- partner contracts before partners receive economics or aggregate merchant access;
- Stripe App adapter for compatible merchants already connected elsewhere;
- Partner API before claiming platform-wide activation;
- security review / penetration testing appropriate to scale and customer requirements;
- insurance and certifications when customer, contractual, or risk exposure makes them economically necessary.

## Release rule

A deployment being technically functional is **not** permission to process live money.

`TX-LIVE-0001` is permitted only after all blocking gates above are marked complete and the system has demonstrated the same lifecycle in Stripe test mode first.

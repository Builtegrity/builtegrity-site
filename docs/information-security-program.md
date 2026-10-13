# Builtegrity Written Information Security Program (WISP)

Status: **PRE-LAUNCH IMPLEMENTED DRAFT — requires approval before LIVE**  
Owner role: Builtegrity Security/Compliance  
Review: at least annually and after a material incident, architecture/provider change, or material law change.

Purpose: provide a risk-based administrative, technical, and physical information-security program for personal, transaction, financial, authentication and operational information processed by Builtegrity, including the Rhode Island duties reflected in R.I. Gen. Laws § 11-49.3-2.

## 1. Data minimization / classification

- PUBLIC: approved public website/legal material.
- INTERNAL: procedures, non-sensitive operations information.
- CONFIDENTIAL: customer/merchant identity/contact information, transaction context, contracts, support records.
- RESTRICTED: integration tokens/secrets, financial/accounting data, authentication/security evidence, incident evidence.
- PROHIBITED: raw card PAN, CVC/CVV, PIN, SSN, bank-login credentials, passwords, medical records and other data not authorized by an approved workflow.

PROHIBITED data must not be intentionally collected. The Stripe-hosted checkout is the exclusive V1 card-entry surface.

## 2. Asset and provider inventory

Production systems/providers must be recorded with owner, purpose, data classes, authentication method, recovery dependency, provider/subprocessor review and review date. Initial core inventory: Cloudflare Worker/D1/R2, Stripe, Clerk, Resend, Intuit QuickBooks Online, GitHub/CI, DNS/domain/email providers.

## 3. Identity and access

- Unique authenticated identities; no shared production administrator credentials.
- Least privilege and tenant-scoped authorization.
- Owner/admin access separate from merchant/customer public access.
- MFA enforced wherever provider supports it before LIVE.
- Access removed promptly on role termination/change.
- Provider/API credentials stored as production secrets, not committed to source control.
- Periodic access review, at least quarterly for production privileged access.

## 4. Cryptography / secrets

- HTTPS/TLS for network traffic.
- Stripe/Resend webhook signatures verified before accepting provider events.
- Sensitive QuickBooks OAuth tokens encrypted at application layer before D1 storage.
- Secret keys rotated after suspected exposure and on provider-defined schedules.
- Legal acceptance network/user-agent evidence stored as salted hashes rather than raw identifiers when raw data is not needed.

## 5. Application controls

- Parameterized database statements.
- Same-origin controls on state-changing admin requests.
- Public transaction pages use high-entropy tokens.
- Append-only transaction event/economics evidence where historical integrity matters.
- Database constraints/triggers enforce critical state invariants.
- Production capabilities fail closed when required evidence/configuration is missing.
- CI builds the complete migration chain and tests safety invariants before merge.
- Security-sensitive changes receive explicit review via pull request/CI before production.

## 6. Payment-card environment

- Use Stripe-hosted Checkout/direct connected-account charge path.
- Never embed Builtegrity card-entry fields or collect raw card credentials.
- Maintain current PCI DSS scope determination and applicable SAQ evidence.
- Maintain applicable external vulnerability scanning evidence where required for the deployed SAQ A/e-commerce architecture.
- A PCI status that expires/fails blocks legal readiness.

## 7. Logging / monitoring

Monitor at minimum:
- failed/stuck Stripe webhooks;
- invalid payment/protection/fee state;
- access/authentication failures where available;
- system/watchdog failure;
- financial-safety state;
- report/statement/tax/accounting failures;
- legal/compliance readiness blockers;
- unresolved privacy requests/security incidents.

High-risk events become internal cases/alerts and must preserve evidence.

## 8. Vulnerability / change management

- Pin/maintain supported provider/runtime versions.
- Review security advisories for critical dependencies/providers.
- Apply critical security fixes promptly based on exposure/severity.
- Do not merge/deploy safety-critical code with failing CI.
- Production configuration changes must be documented and reversible.
- Perform recurring surface review/penetration or vulnerability testing appropriate to scale/risk; formalize vendor/third-party testing before large-scale launch.

## 9. Data storage / retention / disposal

Data is retained according to `data_retention_policies` and `docs/data-retention-policy.md`. Do not retain personal information longer than reasonably required for the documented purpose. Legal hold, tax/accounting, dispute/fraud/security and statutory needs can suspend deletion. Disposal must render information unreadable/unrecoverable using provider-appropriate deletion/cryptographic disposal controls.

## 10. Service providers

Before a personal/financial-data provider is production-approved:
- record contractual terms/DPA/security obligations;
- review security/privacy materials and relevant subprocessors;
- determine data location/transfer issues when material;
- limit the data/integration scope to what is needed;
- set a re-review date;
- maintain exit/revocation procedure.

Provider approval is a LIVE readiness gate.

## 11. Incident response

Use `docs/incident-response-plan.md`. Preserve evidence, contain first, identify affected systems/data/resident states, involve legal/provider contacts, assess notification requirements, document decisions, remediate root cause and complete post-incident review.

## 12. Business continuity / recovery

- Source/infrastructure ownership must not depend on a single human session.
- Maintain documented provider ownership and recovery paths.
- D1/R2/accounting/report evidence recovery procedures must be tested.
- Critical provider outage behavior must fail safely rather than corrupt records.
- Restoration testing is performed at least annually before/after material architecture changes.

## 13. Personnel

Before any employee/contractor receives production data/access:
- appropriate confidentiality/data-security terms;
- least-privilege role;
- security/privacy training appropriate to role;
- device/account security requirements;
- offboarding/revocation checklist.

## 14. Physical safeguards

Builtegrity is cloud-first. Any local device capable of accessing production administration must use supported OS/software, strong device authentication, full-disk encryption where available, auto-lock, and remote account/session revocation. Production secrets must not be stored in unencrypted personal notes/files.

## 15. Risk assessment

At least annually and after material change, document:
- data/systems/providers;
- likely threats and vulnerabilities;
- business/legal impact;
- existing controls;
- residual risk;
- remediation owner/date.

## 16. Approval and evidence

The system status remains `IMPLEMENTED_DRAFT` until the owner and qualified legal/security review confirm this program is appropriate for the actual deployed environment. Approval evidence and next-review dates should be recorded before LIVE.

# Builtegrity Data Retention, Legal Hold & Disposal Policy

Status: PRE-LAUNCH DRAFT — retention periods require final legal/tax approval before automated deletion is enabled.

## Principles
- Collect only data needed for an approved purpose.
- Do not retain personal information longer than reasonably needed for that purpose unless contract, tax/accounting, fraud/security, dispute, litigation or law requires longer retention.
- A legal hold overrides routine deletion.
- Disposal must make data unreadable/unrecoverable using the relevant provider's deletion/cryptographic-destruction controls.
- Raw payment-card credentials, SSNs, passwords and other prohibited data have no normal retention period because Builtegrity must not intentionally collect them.

## Proposed schedules
The D1 `data_retention_policies` table is authoritative for automation status.

- Transaction records: proposed 84 months after transaction completion. Rationale: contract/dispute/accounting/audit/legal-defense evidence. Counsel must confirm state-specific limitations/record rules before ENFORCED.
- Accounting/tax records: proposed 84 months after period close, with longer retention where a specific tax/corporate rule or active matter requires it.
- Security/audit logs: proposed 24 months after creation unless an incident/legal hold requires longer.
- Marketing consent/opt-out/suppression evidence: proposed 60 months so opt-outs are not forgotten and consent history can be demonstrated.
- Failed/abandoned signup data: target 3 months after last activity unless security/fraud or legal needs justify retention.

## Legal hold
A legal hold may be opened for litigation, threatened claims, subpoena/regulator request, tax audit, dispute/fraud investigation, security incident, law-enforcement preservation request or other documented legal need. A hold must identify scope, owner, start date and release authority. No automated deletion may remove held data.

## Privacy deletion requests
A verified deletion request triggers a record-by-record purpose/legal-hold analysis. Data that is not required for an exception should be deleted; data that must be retained should be restricted to the retained purpose and not reused for unrelated marketing/profile purposes.

## Provider deletion
Deletion workflows must include applicable D1/R2 objects, email/export artifacts, identity/provider records under Builtegrity control, and processor/subprocessor deletion requests where contract/law requires. Immutable transaction/audit evidence should use redaction/separation strategies approved by counsel when a lawful deletion right conflicts with a required accounting/legal record.

## Review
Review at least annually and after a material new data category, jurisdiction, provider, legal requirement, or litigation/security event. Automated deletion remains disabled for a category until `counsel_review_status='APPROVED'` and `automation_status='ENFORCED'`.

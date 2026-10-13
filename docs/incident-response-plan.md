# Builtegrity Incident Response & Breach Notification Plan

Status: PRE-LAUNCH DRAFT — must be exercised/approved before LIVE.

## Immediate priorities
1. Preserve safety: stop unauthorized access/data loss without destroying evidence.
2. Open a `security_incidents` record with discovery time, severity and known facts.
3. Preserve logs/provider evidence; do not edit historical transaction/security evidence to “clean up” an incident.
4. Revoke/rotate exposed credentials, sessions/tokens and provider keys as appropriate.
5. Identify affected systems, data classes, merchants/customers and resident states.
6. Contact affected infrastructure/payment/identity providers under their incident procedures.
7. Escalate HIGH/CRITICAL personal-data incidents for legal notification analysis immediately.

## Classification
- LOW: no material confidentiality/integrity/availability impact.
- MEDIUM: contained event with limited impact and no confirmed regulated-data compromise.
- HIGH: likely/confirmed sensitive operational/personal-data compromise, significant service integrity impact, or material provider compromise.
- CRITICAL: broad/ongoing compromise, raw payment credential exposure, major data exfiltration, material funds/process manipulation, or incident likely to trigger legal/regulator notification.

## Legal notification analysis
For a confirmed personal-information breach, determine affected residents by state. Do not use Rhode Island's deadline as the universal deadline; apply each affected state's current statute and the earliest applicable operational deadline.

For Rhode Island residents, record `confirmed_breach_at`, affected count and the statutory notice-analysis deadline. The system currently calculates a 45-calendar-day outer deadline from confirmation for tracked RI residents and flags the >500-resident AG/credit-bureau threshold. Legal review must still confirm statutory definitions, exceptions and required content before notice is issued.

Primary RI source: R.I. Gen. Laws § 11-49.3-4, https://webserver.rilegislature.gov/Statutes/TITLE11/11-49.3/11-49.3-4.HTM

All-state reference: https://www.ncsl.org/technology-and-communication/security-breach-notification-laws

## Payment-card event
If cardholder data may have entered Builtegrity or its environment:
- immediately block the affected collection path;
- preserve evidence;
- notify Stripe/PCI contacts according to applicable agreements;
- treat PCI scope as failed/pending revalidation;
- determine whether card data must be securely purged after evidence preservation/legal direction;
- reopen payment architecture review before resuming.

## Communications
Only designated incident/legal leadership may make breach/regulator/public statements. Communications must distinguish confirmed facts from investigation hypotheses. Never conceal a legally reportable incident.

## Recovery
Restore from known-good code/configuration/data states, validate authentication/authorization/webhook/payment integrity, run the full CI/readiness suite, confirm provider credentials and monitor for recurrence before resuming paused capabilities.

## Post-incident
Within a documented review window:
- root cause;
- timeline;
- impact/affected records;
- notification decisions/evidence;
- control failures;
- remediation owner/due date;
- recurrence monitoring;
- policy/training/vendor changes.

Closed incidents remain retained according to the approved security/legal retention schedule.

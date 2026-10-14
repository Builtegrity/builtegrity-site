import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));

export function renderMasterDocument() {
  const contract = readJson('ops/system-contract.json');
  const owner = readJson('ops/owner-control-manifest.json');
  const register = readJson('ops/document-register.json');

  const pricing = contract.commercial_decisions?.pricing || {};
  const refunds = contract.commercial_decisions?.platform_fee_refund_economics || {};
  const sourceControl = contract.source_control || {};
  const deployment = contract.deployment_ownership || {};
  const systems = owner.systems || [];
  const requiredSystems = systems.filter((system) => system.required_for_live);
  const unverifiedSystems = requiredSystems.filter((system) => system.status !== 'VERIFIED');

  const categories = new Map();
  for (const doc of register.documents || []) {
    if (!categories.has(doc.category)) categories.set(doc.category, []);
    categories.get(doc.category).push(doc);
  }

  const out = [];
  out.push('# Builtegrity Master Operating Record');
  out.push('');
  out.push('> **Generated file. Do not hand-edit.** Run `npm run docs:fix` after changing canonical documentation inputs. CI verifies this file is current.');
  out.push('');
  out.push(`**System contract:** ${contract.contract_id} schema ${contract.schema_version}`);
  out.push(`**Release target:** ${contract.release_target}`);
  out.push(`**Current phase:** PRE-PRODUCTION / LIVE BLOCKED until every required gate is verified.`);
  out.push('');
  out.push('This is the owner-facing map of Builtegrity. It summarizes canonical machine-readable state and points to the authoritative document for detail. It is not a substitute for `ops/system-contract.json`, D1 transaction evidence, processor truth, signed contracts, legal advice, or the private Owner Emergency Vault.');
  out.push('');

  out.push('## 1. Core product contract');
  out.push('');
  out.push(`- **Processor:** ${contract.product_role.processor}; Builtegrity is not the processor and does not custody merchant/customer funds.`);
  out.push(`- **Merchant role:** Merchant remains seller / merchant of record.`);
  out.push(`- **V1 charge model:** ${contract.product_role.v1_charge_model}.`);
  out.push(`- **V1 scope:** ${(contract.product_role.v1_scope || []).join(', ')}.`);
  out.push(`- **Hierarchy:** ${(contract.data_hierarchy || []).join(' → ')}.`);
  out.push(`- **Customers:** ${contract.customer_scope}. Direct merchants use ${contract.direct_partner_id}.`);
  out.push('- **Working promise:** Every payment accounted for. “Protected” is a Builtegrity record/revenue classification, not insurance or a guarantee of payment, dispute, legal, or bank outcome.');
  out.push('');

  out.push('## 2. Transaction truth');
  out.push('');
  out.push(`- **Lifecycle:** ${(contract.transaction_state_axes.lifecycle || []).join(' → ')}.`);
  out.push(`- **Integrity:** ${(contract.transaction_state_axes.integrity || []).join(' | ')}.`);
  out.push(`- **Record/revenue class:** ${(contract.transaction_state_axes.record_classification || []).join(' | ')}.`);
  out.push(`- **Invariant:** ${contract.transaction_state_axes.invariant}`);
  out.push(`- **Revenue class:** Only ${contract.revenue_contract.revenue_record_classification} creates protected transaction-fee entitlement/revenue.`);
  out.push(`- **Carry:** ${contract.revenue_contract.carry_rule}`);
  out.push(`- **Protection rule:** ${contract.revenue_contract.protection_rule}`);
  out.push(`- **Processor truth:** ${contract.revenue_contract.processor_truth_rule}`);
  out.push('');

  out.push('## 3. Commercial model — implemented versus approved');
  out.push('');
  out.push(`- **Pricing implementation:** ${pricing.implementation_id || 'UNSET'} — ${pricing.implementation_status || 'UNSET'}.`);
  out.push(`- **Pricing owner lock:** **${pricing.owner_lock_status || 'UNSET'}**.`);
  if (pricing.bands?.length) {
    out.push(`- **Pricing candidate:** ${pricing.percentage_bps / 100}% plus amount-band base fee; ${pricing.uncapped ? 'no upper Builtegrity fee cap' : 'capped'}.`);
  }
  out.push(`- **Platform Fee/refund policy:** ${refunds.implementation_id || 'UNSET'} — ${refunds.implementation_status || 'UNSET'}.`);
  out.push(`- **Refund economic owner lock:** **${refunds.owner_lock_status || 'UNSET'}**.`);
  out.push(`- **Refund legal status:** **${refunds.legal_status || 'UNSET'}**.`);
  out.push(`- **Candidate default:** ${refunds.candidate_default_handler || 'UNSET'}; applicable legal/processor rules override the candidate and unknown/expired law fails closed.`);
  out.push('');

  out.push('## 4. Operating model');
  out.push('');
  out.push('- Normal transactions should require no owner touch: checkout, pricing, processor-event ingestion, protection classification, payout reconciliation, statements, monitoring and routine retries are machine paths.');
  out.push('- Exceptions follow: detect → classify → self-repair/playbook → route to responsible party → verify authoritative state → close only when fixed.');
  out.push('- Human/vendor completion claims are not sufficient when the underlying system can be checked directly.');
  out.push('- Legal judgment, material pricing/governance changes, major security policy, vendor approval, non-preauthorized write-offs and true corporate-authority decisions remain outside autonomous outsourcing.');
  out.push('- The mature owner transaction-touch target is effectively zero; transaction volume should not scale owner workload.');
  out.push('');

  out.push('## 5. Provider / outsourced-work semantics');
  out.push('');
  out.push('Provider lifecycle: `CANDIDATE → QUOTED → CONTRACTED → VERIFIED → AUTOMATION_ENABLED`.');
  out.push('');
  out.push('- **Counsel:** actual retained fintech/payments/SaaS attorney/law firm; AI is never counsel. Counsel verifies legal classification, deadlines and legal clearance.');
  out.push('- **Registered agent:** formal-service receipt + rapid forwarding into legal intake; not legal advice.');
  out.push('- **Cyber / Tech E&O insurer:** defined risk transfer and claims-response resources with known notice rules/exclusions.');
  out.push('- **Technical/operations provider:** bounded/capped work orders after automation fails; least privilege; machine acceptance test before closure.');
  out.push('- **Managed support:** self-service/playbook first; human support only for eligible unresolved work after volume justifies it.');
  out.push('- **Compliance/security platform:** evidence collection/control monitoring; never a substitute for counsel/auditor judgment.');
  out.push('');
  out.push('See `docs/provider-procurement-standard.md` before requesting quotes or enabling any provider automation.');
  out.push('');

  out.push('## 6. LIVE blocker dashboard');
  out.push('');
  out.push(`- **Source-control governance:** ${sourceControl.verification_status || 'UNSET'} — branch protection/required CI must be independently verified before LIVE.`);
  out.push(`- **Deployment ownership:** ${deployment.verification_status || 'UNSET'} — ${deployment.authoritative_live_runtime || 'UNSET'} must become the sole authoritative live runtime for ${deployment.production_domain || 'the production domain'}.`);
  out.push(`- **Required owner/provider systems verified:** ${requiredSystems.length - unverifiedSystems.length}/${requiredSystems.length}.`);
  if (unverifiedSystems.length) {
    out.push('');
    out.push('| Required system | Status | Verification still needed |');
    out.push('| --- | --- | --- |');
    for (const system of unverifiedSystems) {
      out.push(`| ${escapeCell(system.name)} | **${escapeCell(system.status)}** | ${escapeCell(system.verification_needed)} |`);
    }
  }
  out.push('');
  out.push('**Release rule:** `TX-LIVE-0001` remains blocked until the whole-system live gate, production runtime/D1 readiness, applicable legal/commercial approvals, owner/provider recovery controls and test-mode end-to-end lifecycle all pass together. No green subsystem overrides a red/unknown blocking subsystem.');
  out.push('');

  out.push('## 7. Canonical documentation map');
  out.push('');
  for (const [category, docs] of [...categories.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`### ${humanize(category)}`);
    out.push('');
    out.push('| Document | Authority | Required | Purpose |');
    out.push('| --- | --- | ---: | --- |');
    for (const doc of docs.sort((a, b) => a.title.localeCompare(b.title))) {
      out.push(`| [${escapeCell(doc.title)}](../${doc.path}) | ${escapeCell(doc.authority)} | ${doc.required ? 'Yes' : 'No'} | ${escapeCell(doc.purpose)} |`);
    }
    out.push('');
  }

  out.push('## 8. Private records — never place these in the repository');
  out.push('');
  out.push('| Private record | Approved storage class | Required before LIVE | What belongs there |');
  out.push('| --- | --- | ---: | --- |');
  for (const record of register.private_records || []) {
    out.push(`| ${escapeCell(record.title)} | ${escapeCell(record.storage)} | ${record.required_for_live ? 'Yes' : 'No'} | ${escapeCell(record.contains)} |`);
  }
  out.push('');
  out.push('Actual passwords, API keys, webhook signing secrets, backup codes, private keys, bank credentials, privileged legal communications, negotiated confidential provider terms and patent claim strategy must never be copied into this master or the public engineering repository.');
  out.push('');

  out.push('## 9. Maintenance / self-repair contract');
  out.push('');
  out.push('- `npm run docs:check` verifies every registered required document exists, every repository `docs/*.md` file is registered, private records have no repository path, and this generated master exactly matches canonical inputs.');
  out.push('- `npm run docs:fix` safely regenerates this master from `ops/system-contract.json`, `ops/owner-control-manifest.json` and `ops/document-register.json`.');
  out.push('- `npm run system:gate` includes documentation integrity, so documentation drift becomes a system failure instead of a forgotten cleanup task.');
  out.push('- CI must never auto-decide legal approval, owner commercial locks, provider approval, confidential storage location, or a security exception. Those fail visibly and require the proper authority.');
  out.push('- New documentation must be added to `ops/document-register.json`; deleted/renamed canonical docs require an intentional register update in the same reviewed change.');
  out.push('');

  out.push('## 10. Owner quick commands');
  out.push('');
  out.push('```bash');
  out.push('npm run docs:check       # verify master/document control');
  out.push('npm run docs:fix         # regenerate master after canonical changes');
  out.push('npm run system:gate      # structural/security/coherence/owner checks');
  out.push('npm run system:gate:live # must fail until every real LIVE gate is satisfied');
  out.push('```');
  out.push('');
  out.push('For the full launch checklist, use `docs/production-readiness-gate.md`. For owner/provider recovery, use `docs/owner-independence-and-disaster-recovery.md` and `ops/owner-control-manifest.json`.');
  out.push('');
  out.push('---');
  out.push('');
  out.push('_Generated by `scripts/render-master-document.mjs`. If this file differs from the canonical sources, the documentation integrity gate must fail._');
  out.push('');
  return out.join('\n');
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function humanize(value) {
  return String(value).toLowerCase().split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rendered = renderMasterDocument();
  if (process.argv.includes('--write')) {
    const target = path.join(root, 'docs/MASTER.md');
    fs.writeFileSync(target, rendered, 'utf8');
    console.log('Updated docs/MASTER.md from canonical documentation sources.');
  } else {
    process.stdout.write(rendered);
  }
}

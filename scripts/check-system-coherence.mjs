import fs from 'node:fs';
import path from 'node:path';

const modeArg = process.argv.find((arg) => arg.startsWith('--mode='));
const mode = modeArg ? modeArg.split('=')[1] : 'structure';
if (!['structure','live'].includes(mode)) fail(`Unsupported mode ${mode}`);

const root = process.cwd();
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const read = (p) => fs.readFileSync(path.join(root,p),'utf8');
const exists = (p) => fs.existsSync(path.join(root,p));

const contract = readJson('ops/system-contract.json');
const definitions = readJson('transaction-engine/definitions.json');
const rootReadme = read('README.md');
const pricingMigration = read('migrations/0045_bg_standard_v1_pricing.sql');
const protectionMigration = read('migrations/0050_protection_invariant_with_carry_and_refunds.sql');
const entitlementMigration = read('migrations/0061_protected_only_carry_entitlement.sql');
const legalOrderingMigration = read('migrations/0062_protection_legal_gate_ordering.sql');
const refundMigration = read('migrations/0055_fee_refund_compliance_hardening.sql');
const statementRuntime = read('worker/src/monthly-statements.js');
const statementMigration = read('migrations/0060_monthly_statement_semantic_alignment.sql');
const pricingRuntime = read('worker/src/pricing.js');
const pricingDoc = read('docs/pricing-engine.md');
const financeDoc = read('docs/financial-safety.md');
const engineReadme = read('transaction-engine/README.md');
const readinessDoc = read('docs/production-readiness-gate.md');
const deploymentDoc = read('docs/deployment-ownership.md');
const wranglerExample = read('wrangler.toml.example');
const ownerManifest = readJson('ops/owner-control-manifest.json');
const rootCname = exists('CNAME') ? read('CNAME').trim().toLowerCase() : '';

assert(contract.contract_id === 'BUILTEGRITY-SYSTEM-V1', 'canonical system contract id drifted');
assert(contract.canonical_sources.database_schema.includes('migrations'), 'ordered migrations must remain the canonical schema');
assert(!exists('transaction-engine/schema.sql'), 'standalone transaction-engine/schema.sql is forbidden; ordered migrations are authoritative');

const migrationLineage = contract.migration_lineage;
assert(migrationLineage?.baseline_commit === 'a07986c52abfc8e679ccb1dc9ae193a5a6f2854b', 'migration lineage baseline commit drifted');
assert(migrationLineage?.frozen_through_version === 60, 'migration frozen-through version drifted');
assert(migrationLineage?.historical_migrations_are_immutable === true, 'historical migrations must remain immutable');
assert(migrationLineage?.future_migrations_are_additive_only === true, 'future migrations must remain additive-only');
assert(migrationLineage?.future_versions_must_be_unique_and_contiguous === true, 'future migration versions must remain unique and contiguous');
assert(JSON.stringify(migrationLineage?.grandfathered_duplicate_versions?.['0038']) === JSON.stringify(['0038_compliance_evidence_and_jurisdiction_catalog.sql','0038_state_readiness_views.sql']), '0038 legacy migration exception drifted');
assert(JSON.stringify(migrationLineage?.grandfathered_duplicate_versions?.['0053']) === JSON.stringify(['0053_legal_insert_path_hardening.sql','0053_resend_dependency_resolution.sql']), '0053 legacy migration exception drifted');

const expectedLifecycle = contract.transaction_state_axes.lifecycle;
const expectedIntegrity = contract.transaction_state_axes.integrity;
const expectedRecord = contract.transaction_state_axes.record_classification;
assertJsonArrayEqual(definitions.lifecycle, expectedLifecycle, 'lifecycle status vocabulary');
assertJsonArrayEqual(definitions.integrity_statuses, expectedIntegrity, 'integrity status vocabulary');
assertJsonArrayEqual(definitions.record_classifications, expectedRecord, 'record classification vocabulary');
assertJsonArrayEqual(definitions.merchant_facing_record_classes, contract.transaction_state_axes.merchant_facing_record_classifications, 'merchant-facing record classifications');
assert(engineReadme.includes('ACCOUNTED is an integrity state') && engineReadme.includes('PROTECTED is a record/revenue classification'), 'transaction-engine README must explicitly separate ACCOUNTED from PROTECTED');
assert(!engineReadme.includes('ACCOUNTED replaces the earlier PROTECTED'), 'obsolete ACCOUNTED-replaces-PROTECTED wording reappeared');
assert(/customer jurisdiction attestation and pre-checkout legal-gate evidence/i.test(definitions.protected_definition), 'PROTECTED definition must include pre-checkout legal eligibility evidence');
assert(/Only PROTECTED transactions may recognize Builtegrity transaction revenue/i.test(definitions.protected_definition), 'definitions must keep PROTECTED as the transaction-revenue gate');
assert(/OBSERVED records do not create Builtegrity transaction revenue/i.test(definitions.observed_definition), 'definitions must keep OBSERVED non-revenue producing');
assert(/IMPORTED records do not create Builtegrity transaction revenue/i.test(definitions.imported_definition), 'definitions must keep IMPORTED non-revenue producing');
assert(/required customer jurisdiction attestation/i.test(rootReadme) && /pre-checkout legal-gate evidence/i.test(rootReadme), 'root README must describe the legal-gated PROTECTED invariant');
assert(/AVAILABLE -> RESERVED before Checkout -> SETTLED only at PROTECTED/i.test(rootReadme), 'root README must describe the protected-only carry lifecycle');

const pricing = contract.commercial_decisions.pricing;
assert(pricing.implementation_id === 'BG_STANDARD_V1', 'pricing implementation id drifted');
assert(pricing.percentage_bps === 10 && pricing.uncapped === true, 'system contract pricing percentage/cap drifted');
assert(JSON.stringify(pricing.bands.map(({min_cents,max_cents,base_fee_cents}) => [min_cents,max_cents,base_fee_cents])) === JSON.stringify([[1,100,1],[101,500,2],[501,1000,3],[1001,null,5]]), 'canonical pricing bands drifted');
assert(/'BG_STANDARD_V1'\s*,\s*'ACTIVE'\s*,\s*'USD'\s*,\s*10\s*,\s*0\s*,\s*9007199254740991/i.test(pricingMigration), 'pricing migration V1 row no longer reflects 10 bps uncapped candidate');
assert(/'AMOUNT_BANDS'\s*,\s*1\s*\)/i.test(pricingMigration), 'pricing migration no longer marks BG_STANDARD_V1 amount-band model as uncapped');
for (const row of [
  "('BGV1-BAND-001','BG_STANDARD_V1',1,100,1)",
  "('BGV1-BAND-002','BG_STANDARD_V1',101,500,2)",
  "('BGV1-BAND-003','BG_STANDARD_V1',501,1000,3)",
  "('BGV1-BAND-004','BG_STANDARD_V1',1001,NULL,5)",
]) assert(pricingMigration.includes(row), `pricing migration is missing canonical band ${row}`);
assert(pricingDoc.includes('BG_STANDARD_V1') && pricingDoc.includes('0.10%') && pricingDoc.includes('no upper fee cap'), 'pricing documentation must reflect BG_STANDARD_V1');
assert(!pricingDoc.includes('0.15%') && !pricingDoc.includes('$10 maximum') && !pricingDoc.includes('PRICE-2026-10-V1'), 'obsolete pricing model remains in pricing documentation');

assert(pricingMigration.includes('merchant_fee_carry') && pricingMigration.includes('pricing_fee_residual_micros'), 'pricing migration must define merchant-scoped fractional carry and residual precision');
assert(protectionMigration.includes('pricing_carry_reserved_cents') && protectionMigration.includes('application_fee_gross_confirmed_cents') && protectionMigration.includes("record_classification='PROTECTED'"), 'protection migration must include reserved carry in the processor-confirmed PROTECTED invariant');
assert(entitlementMigration.includes('transaction_fee_entitlements'), '0061 must preserve exact transaction entitlement separately from processor cash');
assert(entitlementMigration.includes('transaction_carry_finalization_requests'), '0061 must make carry finalization idempotent');
assert(entitlementMigration.includes("record_classification='PROTECTED'"), '0061 must gate residual entitlement/carry settlement on PROTECTED');
assert(entitlementMigration.includes("OLD.record_classification='FEE_EXCEPTION'") || entitlementMigration.includes("OLD.record_classification<>'FEE_EXCEPTION'"), '0061 must explicitly govern post-payment fee-exception carry release');
assert(/AVAILABLE.*RESERVED.*SETTLED only when the transaction becomes PROTECTED/is.test(entitlementMigration), '0061 comment/contract must retain the protected-only carry lifecycle');
assert(pricingRuntime.includes("tx?.record_classification === 'FEE_EXCEPTION'") && pricingRuntime.includes("tx.record_classification === 'PROTECTED'"), 'pricing runtime must align carry release/reservation with record classification');
assert(contract.revenue_contract.transaction_fee_attribution_precision === 'MICROS', 'transaction fee attribution precision must remain micros');
assert(contract.revenue_contract.processor_collection_precision === 'SMALLEST_CURRENCY_UNIT', 'processor collection precision must remain smallest currency unit');
assert(/only after the transaction becomes PROTECTED/i.test(contract.revenue_contract.carry_rule), 'system contract must gate fractional entitlement on PROTECTED');
assert(/pre-checkout legal-gate evidence/i.test(contract.revenue_contract.protection_rule), 'system contract protection rule must include legal-gate evidence');
assert(/processor payment\/fee facts must still be recorded/i.test(contract.revenue_contract.processor_truth_rule), 'system contract must preserve processor truth even when protection is blocked');
assert(/application-fee refunds are append-only financial adjustments/i.test(definitions.refund_accounting_rule), 'transaction definitions must preserve adjustment-not-rewrite refund accounting');

assert(legalOrderingMigration.includes('transactions_protected_requires_checkout_legal_gate_insert'), '0062 must defend direct PROTECTED inserts');
assert(legalOrderingMigration.includes('transactions_protected_requires_checkout_legal_gate_update'), '0062 must defend PROTECTED updates');
assert(legalOrderingMigration.includes('transactions_note_missing_legal_gate_after_processor_truth'), '0062 must preserve processor truth while flagging missing legal evidence');
assert(legalOrderingMigration.includes('transactions_confirm_protected_after_processor_truth'), '0062 must own the legal-aware protection classifier');
assert(/customer_attested_country_code/is.test(legalOrderingMigration) && /checkout_legal_gate_at/is.test(legalOrderingMigration), '0062 classifier must require attestation and checkout legal evidence');

const refund = contract.commercial_decisions.platform_fee_refund_economics;
assert(refund.implementation_id === 'FEE-REFUND-POLICY-V1', 'fee/refund policy id drifted');
assert(refund.candidate_default_handler === 'RETAIN_IF_EARNED', 'fee/refund candidate default drifted');
assert(refundMigration.includes('FEE-REFUND-POLICY-V1') && refundMigration.includes('RETAIN_IF_EARNED'), 'fee/refund migration no longer reflects system contract');

const safety = contract.financial_safety;
for (const [field,value] of Object.entries({
  minimum_floor_margin_ppm:800000,
  human_touch_target_ppm:100,
  human_touch_mature_ppm:50,
  human_touch_orange_ppm:200,
  human_touch_red_ppm:500,
  fee_reversal_reserve_ppm:5000,
  effective_rate_warn_bps:150,
})) assert(safety[field] === value, `financial safety contract drifted at ${field}`);
assert(financeDoc.includes('80%') && financeDoc.includes('0.02%') && financeDoc.includes('0.05%'), 'financial-safety documentation is stale relative to runtime thresholds');
assert(!financeDoc.includes('0.15%') && !financeDoc.includes('0.20%'), 'obsolete human-touch thresholds remain in financial-safety documentation');

assert(statementMigration.includes('monthly_statement_v2_source'), 'monthly statement semantic view is missing');
assert(statementRuntime.includes("row.record_classification === 'PROTECTED'") || statementRuntime.includes("record_classification='PROTECTED'"), 'monthly statements must derive protected metrics from record classification');
assert(statementRuntime.includes('transaction_fee_entitlement_micros'), 'monthly statements must expose transaction fee entitlement separately');
assert(statementRuntime.includes('application_fee_gross_cents'), 'monthly statements must expose gross application-fee cash separately');
assert(statementRuntime.includes('carry_settled_cents'), 'monthly statements must expose prior carry settlement separately');
assert(statementRuntime.includes('STATEMENT_VERSION = 2'), 'semantic statement change must remain versioned as V2');

for (const relative of ['terms/index.html','privacy/index.html','index.html','styles.css']) {
  assert(exists(relative) && exists(`public/${relative}`), `canonical/public mirror missing for ${relative}`);
  assert(read(relative) === read(`public/${relative}`), `root compatibility copy diverges from public/${relative}`);
}
for (const relative of ['legal/fees/index.html','legal/acceptable-use/index.html','legal/dpa/index.html','legal/electronic-records/index.html','legal/security/index.html','legal/subprocessors/index.html']) {
  assert(exists(relative) && exists(`public/${relative}`), `public legal mirror missing for ${relative}`);
  assert(read(relative) === read(`public/${relative}`), `root legal copy diverges from public/${relative}`);
}

assert(readinessDoc.includes('npm run system:gate:live'), 'production readiness must use the whole-system live gate');
assert(/standing counsel/i.test(readinessDoc), 'production readiness must include standing-counsel/legal-response readiness');
assert(/branch protection|branch-protection/i.test(readinessDoc), 'production readiness must include protected-main governance');

const githubControl = ownerManifest.systems.find((s) => s.id === 'github');
assert(githubControl?.required_for_live === true, 'GitHub owner control must remain live-blocking');
assert(contract.source_control.branch_protection_required_for_live === true, 'main branch protection must remain a live requirement');
assert(contract.source_control.required_status_checks_required_for_live === true, 'required CI status checks must remain a live requirement');
assert(contract.source_control.direct_unreviewed_main_bypass_allowed_for_live === false, 'unreviewed direct-main bypass must remain forbidden for LIVE');

const deployment = contract.deployment_ownership;
assert(deployment?.required_for_live === true, 'deployment ownership must remain live-blocking');
assert(deployment?.production_domain === 'builtegrity.com', 'canonical production domain drifted');
assert(deployment?.authoritative_live_runtime === 'CLOUDFLARE_WORKER_STATIC_ASSETS', 'Cloudflare Worker/Static Assets must remain the authoritative LIVE runtime');
assert(deployment?.authoritative_live_assets === 'public/', 'public/ must remain the authoritative LIVE asset directory');
assert(deployment?.github_pages_must_not_claim_production_domain_for_live === true, 'GitHub Pages production-domain conflict must remain a LIVE blocker');
assert(deployment?.cloudflare_domain_route_must_be_verified_for_live === true, 'Cloudflare production route verification must remain a LIVE requirement');
assert(/GitHub Pages is not the production transaction runtime/i.test(deploymentDoc), 'deployment ownership runbook must explicitly reject GitHub Pages as the production runtime');
assert(/Remove `builtegrity\.com` as the GitHub Pages custom domain/i.test(deploymentDoc), 'deployment ownership runbook must include Pages custom-domain removal');
assert(/APP_BASE_URL = "https:\/\/builtegrity\.com"/.test(wranglerExample), 'Worker example must target the canonical production domain');
if (rootCname === deployment.production_domain) {
  assert(deployment.verification_status === 'PRELAUNCH_GITHUB_PAGES_CONFLICT', 'repository CNAME claims the production domain but deployment ownership is not marked as a pre-launch Pages conflict');
}
if (deployment.verification_status === 'VERIFIED') {
  assert(rootCname !== deployment.production_domain, 'deployment ownership cannot be VERIFIED while repository CNAME still claims the production domain for GitHub Pages');
}

const legalControl = ownerManifest.systems.find((s) => s.id === 'legal_response_program');
assert(legalControl?.required_for_live === true && legalControl.criticality === 'P0', 'legal response program must remain a P0 live gate');

if (mode === 'live') {
  assert(pricing.owner_lock_status === 'LOCKED', 'LIVE BLOCKED: BG_STANDARD_V1 has not been explicitly owner-locked');
  assert(refund.owner_lock_status === 'LOCKED', 'LIVE BLOCKED: Platform Fee refund economics have not been explicitly owner-locked');
  assert(refund.legal_status === 'APPROVED', 'LIVE BLOCKED: Platform Fee refund economics remain pending counsel approval');
  assert(contract.source_control.verification_status === 'VERIFIED', 'LIVE BLOCKED: main branch protection/required CI governance is not verified');
  assert(deployment.verification_status === 'VERIFIED', 'LIVE BLOCKED: production-domain ownership has not been cut over and independently verified');
  assert(rootCname !== deployment.production_domain, 'LIVE BLOCKED: GitHub Pages repository CNAME still claims the production domain');
  assert(legalControl.status === 'VERIFIED', 'LIVE BLOCKED: standing counsel / legal-response program is not VERIFIED');
  assert(githubControl.status === 'VERIFIED', 'LIVE BLOCKED: GitHub owner recovery/control is not VERIFIED');
}

console.log(`Builtegrity system coherence ${mode} gate: PASS`);

function assertJsonArrayEqual(actual,expected,label){assert(JSON.stringify(actual)===JSON.stringify(expected),`${label} differs between definitions.json and system contract`);}
function assert(condition,message){if(!condition)fail(message);}
function fail(message){console.error(`SYSTEM COHERENCE FAILURE: ${message}`);process.exit(1);}

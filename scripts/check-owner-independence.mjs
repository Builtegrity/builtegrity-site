import fs from 'node:fs';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const modeArg = process.argv.find((arg) => arg.startsWith('--mode='));
const mode = modeArg ? modeArg.split('=')[1] : (args.has('--live') ? 'live' : 'structure');

if (!['structure', 'live'].includes(mode)) {
  console.error(`Unsupported mode: ${mode}`);
  process.exit(2);
}

const manifestPath = path.resolve('ops/owner-control-manifest.json');
const policyPath = path.resolve('docs/owner-independence-and-disaster-recovery.md');
const productionGatePath = path.resolve('docs/production-readiness-gate.md');
const providerIndependencePath = path.resolve('docs/provider-independence.md');

for (const requiredPath of [manifestPath, policyPath, productionGatePath, providerIndependencePath]) {
  if (!fs.existsSync(requiredPath)) {
    console.error(`Missing owner-independence control file: ${path.relative(process.cwd(), requiredPath)}`);
    process.exit(1);
  }
}

const manifestText = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestText);

const requiredTopLevel = ['schema_version', 'policy_id', 'ai_runtime_dependency', 'allowed_statuses', 'release_rule', 'systems'];
for (const field of requiredTopLevel) {
  if (!(field in manifest)) {
    console.error(`Manifest missing top-level field: ${field}`);
    process.exit(1);
  }
}

if (manifest.policy_id !== 'OWNER-INDEPENDENCE-V1') {
  console.error('Manifest policy_id must be OWNER-INDEPENDENCE-V1');
  process.exit(1);
}

if (manifest.ai_runtime_dependency !== false) {
  console.error('Builtegrity must declare ai_runtime_dependency=false');
  process.exit(1);
}

const statuses = new Set(manifest.allowed_statuses);
for (const requiredStatus of ['VERIFIED', 'PARTIALLY_VERIFIED', 'UNVERIFIED', 'NOT_ACTIVE']) {
  if (!statuses.has(requiredStatus)) {
    console.error(`Manifest allowed_statuses missing: ${requiredStatus}`);
    process.exit(1);
  }
}

if (!Array.isArray(manifest.systems) || manifest.systems.length === 0) {
  console.error('Manifest must contain at least one controlled system');
  process.exit(1);
}

const requiredSystemIds = [
  'domain_registrar',
  'github',
  'cloudflare',
  'stripe',
  'clerk',
  'resend',
  'google_workspace',
  'banking_accounting',
  'owner_emergency_vault',
  'ai_automation'
];

const requiredSystemFields = [
  'id',
  'name',
  'criticality',
  'required_for_live',
  'status',
  'authority',
  'durable_data',
  'secret_location',
  'export_or_recovery_path',
  'safe_shutdown',
  'replacement_path',
  'verification_needed'
];

const seen = new Set();
for (const system of manifest.systems) {
  for (const field of requiredSystemFields) {
    if (!(field in system) || system[field] === '') {
      console.error(`System ${system.id ?? '<unknown>'} missing field: ${field}`);
      process.exit(1);
    }
  }

  if (seen.has(system.id)) {
    console.error(`Duplicate system id: ${system.id}`);
    process.exit(1);
  }
  seen.add(system.id);

  if (!statuses.has(system.status)) {
    console.error(`System ${system.id} has invalid status: ${system.status}`);
    process.exit(1);
  }

  if (typeof system.required_for_live !== 'boolean') {
    console.error(`System ${system.id} required_for_live must be boolean`);
    process.exit(1);
  }

  const combined = [
    system.authority,
    system.durable_data,
    system.secret_location,
    system.export_or_recovery_path,
    system.safe_shutdown,
    system.replacement_path
  ].join(' ').toLowerCase();

  if (system.id !== 'ai_automation' && /chatgpt|atlas|openai work/.test(combined)) {
    console.error(`System ${system.id} appears to depend on AI in a control/recovery path`);
    process.exit(1);
  }
}

for (const systemId of requiredSystemIds) {
  if (!seen.has(systemId)) {
    console.error(`Manifest missing required system: ${systemId}`);
    process.exit(1);
  }
}

const obviousSecretPatterns = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]+/,
  /whsec_[A-Za-z0-9]+/,
  /re_[A-Za-z0-9]{12,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];

for (const pattern of obviousSecretPatterns) {
  if (pattern.test(manifestText)) {
    console.error(`Manifest appears to contain a credential matching ${pattern}`);
    process.exit(1);
  }
}

const policy = fs.readFileSync(policyPath, 'utf8');
for (const phrase of ['Owner Zero-AI Drill', 'Private Owner Emergency Vault', 'npm run owner:gate:live']) {
  if (!policy.includes(phrase)) {
    console.error(`Owner-independence policy missing required phrase: ${phrase}`);
    process.exit(1);
  }
}

if (mode === 'live') {
  const blockers = manifest.systems.filter((system) => system.required_for_live && system.status !== 'VERIFIED');
  if (blockers.length) {
    console.error('OWNER INDEPENDENCE LIVE GATE: FAIL');
    for (const blocker of blockers) {
      console.error(`- ${blocker.id}: ${blocker.status} — ${blocker.verification_needed}`);
    }
    process.exit(1);
  }
  console.log('OWNER INDEPENDENCE LIVE GATE: PASS');
  process.exit(0);
}

const counts = manifest.systems.reduce((acc, system) => {
  acc[system.status] = (acc[system.status] ?? 0) + 1;
  return acc;
}, {});

console.log('OWNER INDEPENDENCE STRUCTURE: PASS');
console.log(`Systems: ${manifest.systems.length}`);
console.log(`Status counts: ${JSON.stringify(counts)}`);
console.log('Run `npm run owner:gate:live` before live commercial processing.');

import { execFileSync } from 'node:child_process';

const BASELINE_COMMIT = 'a07986c52abfc8e679ccb1dc9ae193a5a6f2854b';
const FROZEN_THROUGH = 60;
const LEGACY_DUPLICATES = new Map([
  [38, new Set([
    'migrations/0038_compliance_evidence_and_jurisdiction_catalog.sql',
    'migrations/0038_state_readiness_views.sql',
  ])],
  [53, new Set([
    'migrations/0053_legal_insert_path_hardening.sql',
    'migrations/0053_resend_dependency_resolution.sql',
  ])],
]);

const baseline = readTree(BASELINE_COMMIT);
const current = readTree('HEAD');

const baselineFrozen = new Map(
  [...baseline.entries()].filter(([file]) => migrationNumber(file) <= FROZEN_THROUGH),
);

for (const [file, expectedSha] of baselineFrozen) {
  const currentSha = current.get(file);
  assert(currentSha, `historical migration was deleted or renamed: ${file}`);
  assert(
    currentSha === expectedSha,
    `historical migration was modified after freeze: ${file}. Add a new migration instead of rewriting applied history.`,
  );
}

for (const file of current.keys()) {
  const number = migrationNumber(file);
  if (number <= FROZEN_THROUGH) {
    assert(
      baselineFrozen.has(file),
      `new migration reused frozen version ${pad(number)}: ${file}`,
    );
  }
}

const groups = groupByVersion([...current.keys()]);
for (const [number, files] of groups) {
  if (files.length === 1) continue;
  const allowed = LEGACY_DUPLICATES.get(number);
  assert(allowed, `duplicate migration version ${pad(number)} is forbidden: ${files.join(', ')}`);
  assert(
    sameSet(new Set(files), allowed),
    `legacy duplicate version ${pad(number)} changed shape. Expected ${[...allowed].join(', ')}`,
  );
}

const futureNumbers = [...groups.keys()].filter((n) => n > FROZEN_THROUGH).sort((a, b) => a - b);
if (futureNumbers.length) {
  assert(
    futureNumbers[0] === FROZEN_THROUGH + 1,
    `future migration lineage must begin at ${pad(FROZEN_THROUGH + 1)}, found ${pad(futureNumbers[0])}`,
  );
  for (let i = 1; i < futureNumbers.length; i += 1) {
    assert(
      futureNumbers[i] === futureNumbers[i - 1] + 1,
      `future migration sequence has a gap between ${pad(futureNumbers[i - 1])} and ${pad(futureNumbers[i])}`,
    );
  }
}

console.log(
  `Migration lineage: PASS (${baselineFrozen.size} frozen historical files through ${pad(FROZEN_THROUGH)}; ` +
  `${futureNumbers.length} post-freeze version(s)).`,
);

function readTree(ref) {
  let output;
  try {
    output = execFileSync('git', ['ls-tree', '-r', ref, '--', 'migrations'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    fail(
      `cannot read Git baseline ${ref}. Use a full clone/fetch that contains ${BASELINE_COMMIT}. ` +
      `Original error: ${String(error?.stderr || error?.message || error).trim()}`,
    );
  }

  const map = new Map();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(/^\d+\s+blob\s+([0-9a-f]{40})\t(.+)$/);
    if (!match) continue;
    const [, sha, file] = match;
    if (!file.endsWith('.sql')) continue;
    migrationNumber(file); // validates name shape
    map.set(file, sha);
  }
  return map;
}

function migrationNumber(file) {
  const base = file.split('/').pop() || '';
  const match = base.match(/^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/);
  assert(match, `invalid migration filename: ${file}. Required shape: NNNN_descriptive_name.sql`);
  return Number(match[1]);
}

function groupByVersion(files) {
  const groups = new Map();
  for (const file of files) {
    const number = migrationNumber(file);
    if (!groups.has(number)) groups.set(number, []);
    groups.get(number).push(file);
  }
  for (const filesForVersion of groups.values()) filesForVersion.sort();
  return groups;
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function pad(number) {
  return String(number).padStart(4, '0');
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  console.error(`MIGRATION LINEAGE FAILURE: ${message}`);
  process.exit(1);
}

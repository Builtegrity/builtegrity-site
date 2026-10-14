import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMasterDocument } from './render-master-document.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const exists = (relative) => fs.existsSync(path.join(root, relative));
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const fail = (message) => { console.error(`DOCUMENTATION INTEGRITY FAILURE: ${message}`); process.exitCode = 1; };

const register = readJson('ops/document-register.json');
const registeredPaths = new Set();
const ids = new Set();

if (register.register_id !== 'BUILTEGRITY-DOCUMENT-CONTROL-V1') fail('unexpected document-control register id');
if (register.master_document !== 'docs/MASTER.md') fail('master document path drifted');

for (const doc of register.documents || []) {
  if (!doc.id || ids.has(doc.id)) fail(`missing or duplicate document id: ${doc.id || '(blank)'}`);
  ids.add(doc.id);
  if (!doc.path || registeredPaths.has(doc.path)) fail(`missing or duplicate repository document path: ${doc.path || '(blank)'}`);
  registeredPaths.add(doc.path);
  if (!exists(doc.path)) fail(`registered document is missing: ${doc.path}`);
  if (doc.security !== 'PUBLIC_REPO_SAFE') fail(`repository document ${doc.path} must explicitly be PUBLIC_REPO_SAFE`);
  if (!doc.category || !doc.authority || !doc.purpose) fail(`registered document metadata incomplete: ${doc.path}`);
}

for (const record of register.private_records || []) {
  if (!record.never_in_repository) fail(`private record ${record.id} must be marked never_in_repository`);
  if ('path' in record && record.path) fail(`private record ${record.id} must not have a repository path`);
  if (!record.storage || !record.contains) fail(`private record metadata incomplete: ${record.id}`);
}

const docsDir = path.join(root, 'docs');
for (const name of fs.readdirSync(docsDir)) {
  if (!name.endsWith('.md') || name === 'MASTER.md') continue;
  const relative = `docs/${name}`;
  if (!registeredPaths.has(relative)) fail(`unregistered docs file: ${relative}. Add it to ops/document-register.json.`);
}

const required = (register.documents || []).filter((doc) => doc.required);
if (!required.length) fail('document register contains no required documentation');

const canonicalInputs = ['ops/system-contract.json','ops/owner-control-manifest.json','ops/document-register.json'];
for (const input of canonicalInputs) if (!exists(input)) fail(`canonical documentation input missing: ${input}`);

if (!exists('docs/MASTER.md')) {
  fail('docs/MASTER.md is missing. Run npm run docs:fix.');
} else {
  const actual = read('docs/MASTER.md');
  const expected = renderMasterDocument();
  if (actual !== expected) fail('docs/MASTER.md is stale. Run npm run docs:fix and commit the regenerated file.');
}

const README = read('README.md');
if (!README.includes('docs/MASTER.md')) fail('README must link to docs/MASTER.md as the owner-facing documentation entry point');
if (!README.includes('npm run docs:check')) fail('README must document the documentation integrity check');

const packageJson = readJson('package.json');
for (const command of ['docs:check','docs:fix']) {
  if (!packageJson.scripts?.[command]) fail(`package.json is missing ${command}`);
}
if (!String(packageJson.scripts?.['system:gate'] || '').includes('docs:check')) fail('system:gate must include docs:check');
if (!String(packageJson.scripts?.['system:gate:live'] || '').includes('docs:check')) fail('system:gate:live must include docs:check');

const contract = readJson('ops/system-contract.json');
if (contract.canonical_sources?.master_document !== 'docs/MASTER.md') fail('system contract must identify docs/MASTER.md as the owner-facing generated master');
if (contract.canonical_sources?.document_register !== 'ops/document-register.json') fail('system contract must identify the document register');

if (!process.exitCode) console.log(`Documentation integrity: PASS (${registeredPaths.size} registered repository docs, ${(register.private_records || []).length} private record classes).`);

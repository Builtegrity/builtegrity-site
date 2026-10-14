import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ignoredDirs = new Set(['.git','node_modules','.wrangler']);
const forbiddenTrackedPathPatterns = [
  /(^|\/)\.env(?:\..+)?$/i,
  /(^|\/)\.dev\.vars(?:\..+)?$/i,
  /(^|\/)wrangler\.toml$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
];
const allowedTrackedPaths = new Set([
  '.dev.vars.example',
  '.env.example',
  '.env.sample',
  'wrangler.toml.example',
]);

const secretPatterns = [
  ['Stripe/Clerk-style secret key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ['Stripe webhook signing secret', /\bwhsec_[A-Za-z0-9]{16,}\b/g],
  ['Resend-style API key', /\bre_[A-Za-z0-9_-]{20,}\b/g],
  ['GitHub classic token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Private key material', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
];

const textExtensions = new Set([
  '.js','.mjs','.cjs','.ts','.tsx','.jsx','.json','.sql','.md','.txt','.html','.css','.yml','.yaml','.toml','.xml','.csv','.sh','.ps1','.py','.rb','.go','.rs','.java','.properties','.ini','.conf','.example',''
]);

const violations = [];
walk(root);

if (violations.length) {
  console.error('PUBLIC SECRET HYGIENE: FAIL');
  for (const v of violations) console.error(`- ${v}`);
  process.exit(1);
}

console.log('PUBLIC SECRET HYGIENE: PASS');

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (entry.isDirectory()) {
      walk(abs);
      continue;
    }
    if (!entry.isFile()) continue;

    if (!allowedTrackedPaths.has(rel) && forbiddenTrackedPathPatterns.some((re) => re.test(rel))) {
      violations.push(`forbidden credential/config file is present in the tracked tree: ${rel}`);
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!textExtensions.has(ext)) continue;
    const stat = fs.statSync(abs);
    if (stat.size > 2_000_000) continue;

    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    for (const [label, regex] of secretPatterns) {
      regex.lastIndex = 0;
      if (regex.test(text)) violations.push(`${label} pattern detected in ${rel}`);
    }
  }
}

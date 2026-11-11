// SEC-001 task 7: after `npm run build -w web`, nothing a browser downloads may
// carry a secret. Scans apps/web/.next/static (every file the site serves to
// browsers) for secret shapes, database connection strings and the names of
// server-only variables, and fails when a source map is published.
// Usage: node scripts/scan-bundle.mjs   (exit 1 on any hit)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_SHAPES } from './secret-shapes.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATIC = join(ROOT, 'apps', 'web', '.next', 'static');

const BUNDLE_SHAPES = [
  ...SECRET_SHAPES,
  { name: 'database connection string', re: /postgres(?:ql)?:\/\/[^\s'"`]+:[^\s'"`@]+@/ },
  { name: 'Stripe test key', re: /\bsk_test_[A-Za-z0-9]{10,}/ },
  // Names of server-only variables: if one is in a browser file, a server
  // module was pulled into the client.
  {
    name: 'server-only variable name',
    re: /\b(SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|CRON_SECRET)\b/,
  },
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

let files;
try {
  files = walk(STATIC);
} catch {
  console.error(`scan-bundle: ${relative(ROOT, STATIC)} not found; run npm run build -w web first`);
  process.exit(1);
}

const problems = [];
let scanned = 0;
for (const file of files) {
  const rel = relative(ROOT, file);
  if (file.endsWith('.map')) {
    problems.push(`${rel}: source map published to browsers`);
    continue;
  }
  if (!/\.(js|css|html|json|txt)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  scanned++;
  for (const shape of BUNDLE_SHAPES) {
    for (const m of text.matchAll(new RegExp(shape.re, 'g'))) {
      if (shape.check && !shape.check(m[0])) continue;
      problems.push(`${rel}: looks like a ${shape.name}`);
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`bundle:scan ok: ${scanned} browser files, no secrets, no source maps`);

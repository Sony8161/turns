// SEC-001 task 7: after `npm run build -w web`, nothing a browser downloads may
// carry a secret. Scans apps/web/.next/static and apps/web/public (every file
// the site serves as is) for secret shapes, database connection strings and
// the names of server-only variables, and fails when a source map is
// published. Rendered pages are scanned by scan-pages.mjs (v0.10.1).
// Usage: node scripts/scan-bundle.mjs   (exit 1 on any hit)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_SHAPES } from './secret-shapes.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATIC = join(ROOT, 'apps', 'web', '.next', 'static');
const PUBLIC = join(ROOT, 'apps', 'web', 'public');

const BUNDLE_SHAPES = BROWSER_SHAPES;

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
try {
  files.push(...walk(PUBLIC));
} catch {
  // no public folder: nothing to add
}

const problems = [];
let scanned = 0;
for (const file of files) {
  const rel = relative(ROOT, file);
  if (file.endsWith('.map')) {
    problems.push(`${rel}: source map published to browsers`);
    continue;
  }
  if (!/\.(js|mjs|css|html|json|txt|svg|xml|webmanifest)$/.test(file)) continue;
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

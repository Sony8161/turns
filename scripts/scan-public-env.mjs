// Fails if a public-prefixed variable name is not on the allow list, or if a
// known secret shape appears anywhere in the tree. Public prefixes ship to every
// browser and every phone (threat model T16).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.expo',
  'dist',
  'build',
  'out',
  'coverage',
  '.turbo',
  '.vercel',
  'android',
  'ios',
  'security',
]);
const SCAN_EXT = /\.(ts|tsx|js|mjs|cjs|json|toml|md|ya?ml|sh|ps1)$/;
const ENV_FILE = /^\.env(\..*)?$/;
const PUBLIC_PREFIX = /\b(NEXT_PUBLIC_|EXPO_PUBLIC_)([A-Z0-9_]+)/g;
const ALLOWED_PUBLIC = new Set(['SUPABASE_URL', 'SUPABASE_ANON_KEY']);

// Values that are secrets no matter what name they sit under.
const SECRET_SHAPES = [
  { name: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{10,}/ },
  {
    name: 'service_role JWT',
    re: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
    check: isServiceRoleJwt,
  },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Twilio account SID', re: /\bAC[0-9a-f]{32}\b/ },
  { name: 'Stripe live key', re: /\bsk_live_[A-Za-z0-9]{10,}/ },
];

function isServiceRoleJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (SCAN_EXT.test(name) || ENV_FILE.test(name)) yield p;
  }
}

const problems = [];
for (const file of walk(ROOT)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(PUBLIC_PREFIX)) {
    if (!ALLOWED_PUBLIC.has(m[2])) {
      problems.push(`${file}: public variable ${m[1]}${m[2]} is not on the allow list`);
    }
  }
  for (const shape of SECRET_SHAPES) {
    for (const m of text.matchAll(new RegExp(shape.re, 'g'))) {
      if (shape.check && !shape.check(m[0])) continue;
      problems.push(`${file}: looks like a ${shape.name}`);
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('secrets:scan ok: no disallowed public variables, no known secret shapes');

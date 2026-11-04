// Fails if a public-prefixed variable name is not on the allow list, or if a
// known secret shape appears in any file git tracks or has staged. Public
// prefixes ship to every browser and every phone (threat model T16).
// Ignored files (.env.local and friends) are the right place for local keys,
// so they are not scanned; only what could be committed is.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCAN_EXT = /\.(ts|tsx|js|mjs|cjs|json|toml|md|ya?ml|sh|ps1|html)$/;
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

function trackedFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  );
  return out.split('\0').filter(Boolean);
}

const problems = [];
for (const rel of trackedFiles()) {
  const name = basename(rel);
  if (!SCAN_EXT.test(name) && !ENV_FILE.test(name)) continue;
  const file = join(ROOT, rel);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  for (const m of text.matchAll(PUBLIC_PREFIX)) {
    if (!ALLOWED_PUBLIC.has(m[2])) {
      problems.push(`${rel}: public variable ${m[1]}${m[2]} is not on the allow list`);
    }
  }
  for (const shape of SECRET_SHAPES) {
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
console.log('secrets:scan ok: tracked files carry no disallowed public variables or secret shapes');

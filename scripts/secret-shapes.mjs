// Values that are secrets no matter what name they sit under. Shared by the
// tracked-file scan (scan-public-env.mjs) and the browser bundle scan
// (scan-bundle.mjs), SEC-001.
export const SECRET_SHAPES = [
  { name: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{10,}/ },
  {
    name: 'service_role JWT',
    re: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
    check: isServiceRoleJwt,
  },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Twilio account SID', re: /\bAC[0-9a-f]{32}\b/ },
  { name: 'Stripe live key', re: /\bsk_live_[A-Za-z0-9]{10,}/ },
  // v0.10.1 (Part 10 review finding 6): a database URL with a password, in
  // either form. The local stack's throwaway URL (127.0.0.1, localhost) is
  // fine in docs and CI.
  {
    name: 'database connection string with a password',
    re: /postgres(?:ql)?:\/\/[^\s'"`<>]+/,
    check: (m) => hasPassword(m) && !isLocalDatabase(m),
  },
];

/** What only the browser bundle and rendered pages must never hold, on top of
 *  SECRET_SHAPES: there even a local connection string means a server module
 *  leaked into the client. */
export const BROWSER_SHAPES = [
  ...SECRET_SHAPES,
  {
    name: 'database connection string',
    re: /postgres(?:ql)?:\/\/[^\s'"`<>]+/,
    check: hasPassword,
  },
  { name: 'Stripe test key', re: /\bsk_test_[A-Za-z0-9]{10,}/ },
  // Names of server-only variables: if one is in a browser file, a server
  // module was pulled into the client.
  {
    name: 'server-only variable name',
    re: /\b(SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|CRON_SECRET)\b/,
  },
];

export function hasPassword(url) {
  return /^postgres(?:ql)?:\/\/[^/@\s]*:[^/@\s]+@/.test(url) || /[?&]password=[^&\s]+/i.test(url);
}

export function isLocalDatabase(url) {
  return /@(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(url);
}

export function isServiceRoleJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

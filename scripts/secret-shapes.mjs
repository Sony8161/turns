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
];

export function isServiceRoleJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

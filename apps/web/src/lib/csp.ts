// Part 10: the Content Security Policy for every page, with a fresh nonce per
// request. Next puts the nonce on its own scripts when it finds it in the
// request's CSP header (the proxy sets both), and 'strict-dynamic' lets those
// scripts load the page chunks. Nothing else may run: no inline script from
// an injected string, no plugin, no framing, no form posting elsewhere.
// Styles allow inline: Next and the error page inline small style blocks, and
// a style cannot run code. Pure, so the tests read it.
export function buildCsp(input: { nonce: string; dev: boolean; supabaseUrl: string }): string {
  const supabase = safeOrigin(input.supabaseUrl);
  const script = ["'self'", `'nonce-${input.nonce}'`, "'strict-dynamic'"];
  // React's development build evaluates code for its stack traces.
  if (input.dev) script.push("'unsafe-eval'");
  const connect = ["'self'", ...(supabase ? [supabase] : []), ...(input.dev ? ['ws:'] : [])];
  const directives = [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(input.dev ? [] : ['upgrade-insecure-requests']),
  ];
  return directives.join('; ');
}

/** The origin of a configured URL, or null when it is not an http(s) URL. */
function safeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** 128 random bits, base64. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// Part 10: the page CSP allows only nonce'd scripts, never framing or plugins.
import { describe, expect, it } from 'vitest';
import { buildCsp, newNonce } from './csp';

describe('buildCsp', () => {
  const prod = buildCsp({ nonce: 'abc', dev: false, supabaseUrl: 'https://x.supabase.co/rest' });
  const parts = Object.fromEntries(
    prod.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1).join(' ')]),
  );

  it('scripts need the nonce; no unsafe-inline or unsafe-eval in production', () => {
    expect(parts['script-src']).toBe("'self' 'nonce-abc' 'strict-dynamic'");
    expect(prod).not.toContain("'unsafe-eval'");
    expect(parts['script-src']).not.toContain("'unsafe-inline'");
  });
  it('no framing, no plugins, forms post only here', () => {
    expect(parts['frame-ancestors']).toBe("'none'");
    expect(parts['object-src']).toBe("'none'");
    expect(parts['form-action']).toBe("'self'");
    expect(parts['base-uri']).toBe("'self'");
  });
  it('connects only to itself and the Supabase origin', () => {
    expect(parts['connect-src']).toBe("'self' https://x.supabase.co");
  });
  it('reports violations to our own endpoint (v0.10.1)', () => {
    expect(parts['report-uri']).toBe('/api/csp-report');
    expect(parts['report-to']).toBe('csp');
  });
  it('a junk Supabase URL adds nothing', () => {
    expect(buildCsp({ nonce: 'n', dev: false, supabaseUrl: 'javascript:alert(1)' })).toContain(
      "connect-src 'self';",
    );
  });
  it('development adds eval and websockets for the dev server only', () => {
    const dev = buildCsp({ nonce: 'n', dev: true, supabaseUrl: '' });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain('ws:');
    expect(dev).not.toContain('upgrade-insecure-requests');
  });
  it('nonces are fresh', () => {
    expect(newNonce()).not.toBe(newNonce());
    expect(newNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

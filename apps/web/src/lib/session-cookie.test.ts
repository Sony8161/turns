import { describe, expect, it } from 'vitest';
import { hasSessionCookie, underAny } from './session-cookie';

const req = (...names: string[]) => ({
  cookies: { getAll: () => names.map((name) => ({ name })) },
});

describe('hasSessionCookie', () => {
  it('sees a Supabase session cookie, whole or in chunks', () => {
    expect(hasSessionCookie(req('sb-127-auth-token'))).toBe(true);
    expect(hasSessionCookie(req('sb-abcdefgh-auth-token.0', 'sb-abcdefgh-auth-token.1'))).toBe(
      true,
    );
  });
  it('sees the kiosk cookie', () => {
    expect(hasSessionCookie(req('turn-kiosk'))).toBe(true);
  });
  it('ignores everything else', () => {
    expect(hasSessionCookie(req())).toBe(false);
    expect(
      hasSessionCookie(req('turn-lang', 'sb-x-auth-token-code-verifier', 'turn-kiosk-staff-seen')),
    ).toBe(false);
  });
});

describe('underAny', () => {
  it('matches a section and its pages, not a longer word', () => {
    expect(underAny('/me', ['/me'])).toBe(true);
    expect(underAny('/me/x', ['/me'])).toBe(true);
    expect(underAny('/meow', ['/me'])).toBe(false);
    expect(underAny('/admin/log', ['/admin', '/me'])).toBe(true);
    expect(underAny('/', ['/admin'])).toBe(false);
  });
});

// Pure helpers for the proxy (v0.10.1), kept apart so tests can reach them.
import { KIOSK_COOKIE } from './kiosk-idle';

const SUPABASE_SESSION = /^sb-[\w-]+-auth-token(\.\d+)?$/;

/** A Supabase session cookie (sb-<project>-auth-token, maybe split into .0,
 *  .1 chunks) or the kiosk cookie: this browser may hold a session that needs
 *  refreshing (Part 10 review finding 3). */
export function hasSessionCookie(request: { cookies: { getAll(): { name: string }[] } }): boolean {
  return request.cookies
    .getAll()
    .some((c) => c.name === KIOSK_COOKIE || SUPABASE_SESSION.test(c.name));
}

/** Is the path one of these sections? "/me" and "/me/x", not "/meow". */
export function underAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(`${p}/`));
}

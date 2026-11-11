// Runs before every page request. Sets the Content Security Policy with a
// fresh nonce (Part 10). On the staff and sign-in paths it also refreshes the
// Supabase session cookie and sends signed-out visitors away from staff pages.
// This is an optimistic check; every page and action verifies the user and
// membership again.
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, CSP_REPORTING_ENDPOINTS, newNonce } from '@/lib/csp';
import { KIOSK_COOKIE, KIOSK_SEEN_COOKIE, kioskStaffIdle } from '@/lib/kiosk-idle';
import { hasSessionCookie, underAny } from '@/lib/session-cookie';

const STAFF_PREFIXES = ['/admin', '/me'];
// Where the session matters (the matcher before Part 10).
const SESSION_PREFIXES = ['/admin', '/me', '/login', '/join', '/setup', '/kiosk'];

// Bracket access on purpose: a literal dotted process.env read of a public
// variable is inlined at build time, and a build without the variable would
// bake in an empty string.
function env(name: string): string {
  return process.env[name] ?? '';
}

export async function proxy(request: NextRequest) {
  const csp = buildCsp({
    nonce: newNonce(),
    dev: process.env['NODE_ENV'] !== 'production',
    supabaseUrl: env('NEXT_PUBLIC_SUPABASE_URL'),
  });
  // Next reads the nonce from the request's CSP header for its own scripts.
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', csp);
  const next = () => NextResponse.next({ request: { headers } });
  const send = (r: NextResponse) => {
    r.headers.set('Content-Security-Policy', csp);
    r.headers.set('Reporting-Endpoints', CSP_REPORTING_ENDPOINTS);
    return r;
  };

  const path = request.nextUrl.pathname;
  // v0.10.1 (Part 10 review finding 3): any page a signed-in browser opens
  // refreshes the session here, where the rotated cookie can be saved. The
  // root layout checks the user on every page of a kiosk iPad; without this a
  // refresh on "/" or "/terms" would use up the token and throw the new one
  // away. A browser with no session cookie skips the auth call.
  if (!underAny(path, SESSION_PREFIXES) && !hasSessionCookie(request)) {
    return send(next());
  }

  let response = next();
  const supabase = createServerClient(
    env('NEXT_PUBLIC_SUPABASE_URL'),
    env('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(toSet) {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          headers.set('cookie', request.cookies.toString());
          response = next();
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // v0.9.1 (review finding 4): a staff session on a kiosk iPad ends after five
  // minutes without a tap (the clock is kept by KioskStaffGuard).
  if (user && request.cookies.has(KIOSK_COOKIE)) {
    const now = Date.now();
    if (kioskStaffIdle(request.cookies.get(KIOSK_SEEN_COOKIE)?.value, now)) {
      await supabase.auth.signOut();
      const url = request.nextUrl.clone();
      url.pathname = '/kiosk';
      url.search = '';
      const out = NextResponse.redirect(url);
      for (const c of response.cookies.getAll()) out.cookies.set(c);
      out.cookies.delete(KIOSK_SEEN_COOKIE);
      return send(out);
    }
  }

  if (!user && underAny(path, STAFF_PREFIXES)) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return send(NextResponse.redirect(url));
  }
  return send(response);
}

export const config = {
  // Every page; not the build's static files, images, the icon or the API
  // routes (they answer JSON or CSV, not HTML).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'],
};

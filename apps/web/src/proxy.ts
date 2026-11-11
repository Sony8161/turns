// Runs before every matched request: refreshes the Supabase session cookie and
// sends signed-out visitors away from staff pages. This is an optimistic check;
// every page and action verifies the user and membership again.
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { KIOSK_COOKIE, KIOSK_SEEN_COOKIE, kioskStaffIdle } from '@/lib/kiosk-idle';

const STAFF_PREFIXES = ['/admin', '/me'];

// Bracket access on purpose: a literal dotted process.env read of a public
// variable is inlined at build time, and a build without the variable would
// bake in an empty string.
function env(name: string): string {
  return process.env[name] ?? '';
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
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
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

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
      return out;
    }
  }

  if (!user && STAFF_PREFIXES.some((p) => path.startsWith(p))) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ['/admin/:path*', '/me', '/login', '/join/:path*', '/setup', '/kiosk'],
};

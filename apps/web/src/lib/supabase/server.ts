import 'server-only';
// Supabase client for server components, server actions and route handlers.
// Holds only the public URL and anon key; the session comes from cookies.
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

// Bracket access: read at runtime, never inlined at build time.
function env(name: 'NEXT_PUBLIC_SUPABASE_URL' | 'NEXT_PUBLIC_SUPABASE_ANON_KEY'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('NEXT_PUBLIC_SUPABASE_ANON_KEY'), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a server component: cookies are read-only there and the
          // proxy refreshes the session instead.
        }
      },
    },
  });
}

/** The signed-in auth user, verified against the auth server, or null. */
export async function getAuthUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

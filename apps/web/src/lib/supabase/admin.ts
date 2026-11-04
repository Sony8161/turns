import 'server-only';
// Service-role auth client. Used for exactly one thing: creating an account
// after an invite code has been checked. Never import from a client file.
import { createClient } from '@supabase/supabase-js';

export function adminAuth() {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!url || !key) throw new Error('Supabase service credentials are not set');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;
}

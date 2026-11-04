// After sign-in with a pending invite: redeem it for the signed-in user, in the
// user's own session, then clear the cookie. GET so a redirect can reach it.
import { redeemInvite } from '@turn/db/invites';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthUser } from '@/lib/supabase/server';
import { clearInviteCookie, readInviteCookie } from '../invite-cookie';

export async function GET(request: NextRequest) {
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url));

  const user = await getAuthUser();
  if (!user) return to('/login');

  const invite = await readInviteCookie();
  await clearInviteCookie();
  if (!invite) return to('/admin');

  const name = invite.name.trim().slice(0, 80);
  if (!name) return to('/join?error=name');

  const result = await redeemInvite(db(), {
    code: invite.code,
    userId: user.id,
    displayName: name,
    email: user.email ?? undefined,
    phone: user.phone ?? undefined,
  });
  return to(result.ok ? '/admin' : `/join?error=${result.reason}`);
}

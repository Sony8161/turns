// After sign-in with a pending code: redeem it for the signed-in user, in the
// user's own session, then clear the cookie. GET so a redirect can reach it.
import { redeemInvite } from '@turn/db/invites';
import { redeemSetupCode } from '@turn/db/setup';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthUser } from '@/lib/supabase/server';
import { clearInviteCookie, readInviteCookie } from '../invite-cookie';

export async function GET(request: NextRequest) {
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url));

  const user = await getAuthUser();
  if (!user) return to('/login');

  const pending = await readInviteCookie();
  await clearInviteCookie();
  if (!pending) return to('/admin');

  const name = pending.name.trim().slice(0, 80);
  if (!name) return to(pending.kind === 'setup' ? '/setup?error=fields' : '/join?error=name');
  const contact = { email: user.email ?? undefined, phone: user.phone ?? undefined };

  if (pending.kind === 'setup') {
    const result = await redeemSetupCode(db(), {
      code: pending.code,
      userId: user.id,
      displayName: name,
      salonName: pending.salonName.trim().slice(0, 80),
      locationName: pending.locationName.trim().slice(0, 80),
      ...contact,
    });
    return to(result.ok ? '/admin' : `/setup?error=${result.reason}`);
  }

  const result = await redeemInvite(db(), {
    code: pending.code,
    userId: user.id,
    displayName: name,
    ...contact,
  });
  return to(result.ok ? '/admin' : `/join?error=${result.reason}`);
}

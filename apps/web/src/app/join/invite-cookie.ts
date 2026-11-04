// A pending invite travels from /join through sign-in in one cookie. It lives
// as long as a sign-in code does (one hour), is httpOnly, and is cleared on
// sign-out and on redemption, so a shared iPad cannot hand a role to the next
// person who signs in.
import { cookies } from 'next/headers';

export const INVITE_COOKIE = 'invite';
const ONE_HOUR = 60 * 60;

export type PendingInvite = { code: string; name: string };

export async function setInviteCookie(invite: PendingInvite): Promise<void> {
  (await cookies()).set(INVITE_COOKIE, JSON.stringify(invite), {
    maxAge: ONE_HOUR,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}

export async function clearInviteCookie(): Promise<void> {
  (await cookies()).delete(INVITE_COOKIE);
}

export async function readInviteCookie(): Promise<PendingInvite | null> {
  const raw = (await cookies()).get(INVITE_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as PendingInvite).code === 'string' &&
      typeof (parsed as PendingInvite).name === 'string'
    ) {
      return parsed as PendingInvite;
    }
  } catch {
    // malformed cookie: treat as absent
  }
  return null;
}

// A pending code (staff invite or salon setup) travels from its form through
// sign-in in one cookie. It lives as long as a sign-in code does (one hour), is
// httpOnly, and is cleared on sign-out and on redemption, so a shared iPad
// cannot hand a role to the next person who signs in.
import { cookies } from 'next/headers';

export const INVITE_COOKIE = 'pending';
const ONE_HOUR = 60 * 60;

export type PendingInvite = { kind: 'invite'; code: string; name: string };
export type PendingSetup = {
  kind: 'setup';
  code: string;
  name: string;
  salonName: string;
  locationName: string;
};
export type Pending = PendingInvite | PendingSetup;

export async function setInviteCookie(pending: Pending): Promise<void> {
  (await cookies()).set(INVITE_COOKIE, JSON.stringify(pending), {
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

function str(v: unknown): v is string {
  return typeof v === 'string';
}

export async function readInviteCookie(): Promise<Pending | null> {
  const raw = (await cookies()).get(INVITE_COOKIE)?.value;
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<Record<keyof PendingSetup, unknown>> | null;
    if (!p || typeof p !== 'object' || !str(p.code) || !str(p.name)) return null;
    if (p.kind === 'invite') return { kind: 'invite', code: p.code, name: p.name };
    if (p.kind === 'setup' && str(p.salonName) && str(p.locationName)) {
      return {
        kind: 'setup',
        code: p.code,
        name: p.name,
        salonName: p.salonName,
        locationName: p.locationName,
      };
    }
  } catch {
    // malformed cookie: treat as absent
  }
  return null;
}

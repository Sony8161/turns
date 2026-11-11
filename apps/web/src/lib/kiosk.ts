import 'server-only';
// The kiosk iPad's identity (Part 9, threat model T20, T25): a random token in
// an httpOnly cookie, never a staff session. The database keeps only its hash.
import { kioskFromToken, type KioskDevice } from '@turn/db/kiosk';
import { cookies } from 'next/headers';
import { db } from './db';

export const KIOSK_COOKIE = 'turn-kiosk';
// Browsers cap cookie lifetimes at about 400 days; re-pair after that.
const MAX_AGE = 60 * 60 * 24 * 400;

/** The paired device behind this browser's cookie, or null. */
export async function currentKiosk(): Promise<KioskDevice | null> {
  const token = (await cookies()).get(KIOSK_COOKIE)?.value;
  return kioskFromToken(db(), token);
}

export async function setKioskCookie(token: string): Promise<void> {
  (await cookies()).set(KIOSK_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: MAX_AGE,
  });
}

import 'server-only';
// The kiosk iPad's identity (Part 9, threat model T20, T25): a random token in
// an httpOnly cookie, never a staff session. The database keeps only its hash.
import {
  closeKioskUnlock,
  extendKioskUnlock,
  kioskFromToken,
  kioskUnlockOpen,
  openKioskUnlock,
  type KioskDevice,
} from '@turn/db/kiosk';
import { cookies } from 'next/headers';
import { db } from './db';
import { KIOSK_COOKIE, KIOSK_SEEN_COOKIE, KIOSK_UNLOCK_COOKIE } from './kiosk-idle';

export { KIOSK_COOKIE };
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

const secure = () => process.env['NODE_ENV'] === 'production';

/** After the right PIN (v0.9.1, review finding 4): a short-lived cookie whose
 *  token the database must match before this iPad may reach the sign-in. */
export async function unlockThisKiosk(device: KioskDevice): Promise<void> {
  const u = await openKioskUnlock(db(), device);
  (await cookies()).set(KIOSK_UNLOCK_COOKIE, u.token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: secure(),
    path: '/',
    expires: u.expiresAt,
  });
}

/**
 * On a paired kiosk iPad, the staff sign-in needs an open unlock (the PIN).
 * A browser that is not a kiosk is never blocked. Returns the device when one
 * is behind the cookie, so the caller can extend or close the window.
 */
export async function kioskSignInGate(): Promise<
  { blocked: false; device: KioskDevice | null } | { blocked: true }
> {
  const jar = await cookies();
  if (!jar.has(KIOSK_COOKIE)) return { blocked: false, device: null };
  const device = await currentKiosk();
  if (!device) return { blocked: false, device: null };
  const open = await kioskUnlockOpen(db(), device, jar.get(KIOSK_UNLOCK_COOKIE)?.value);
  return open ? { blocked: false, device } : { blocked: true };
}

/** The sign-in code is on its way: keep the window open long enough to type it. */
export async function holdKioskUnlock(device: KioskDevice, minutes = 10): Promise<void> {
  const until = new Date(Date.now() + minutes * 60_000);
  await extendKioskUnlock(db(), device, until);
  const token = (await cookies()).get(KIOSK_UNLOCK_COOKIE)?.value;
  if (token) {
    (await cookies()).set(KIOSK_UNLOCK_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secure(),
      path: '/',
      expires: until,
    });
  }
}

/** Signed in: the window is used up, and the idle clock starts. */
export async function finishKioskUnlock(device: KioskDevice): Promise<void> {
  await closeKioskUnlock(db(), device);
  const jar = await cookies();
  jar.delete(KIOSK_UNLOCK_COOKIE);
  // Not httpOnly: KioskStaffGuard moves it on every tap (lib/kiosk-idle.ts).
  jar.set(KIOSK_SEEN_COOKIE, String(Date.now()), {
    httpOnly: false,
    sameSite: 'strict',
    secure: secure(),
    path: '/',
    maxAge: 60 * 60 * 12,
  });
}

// v0.9.1 (review finding 4): a staff member who signs in on a kiosk iPad and
// walks away is signed out after five minutes without a tap. Pure, so the
// proxy and the tests share it. The clock is the time of the last tap or key,
// written by KioskStaffGuard on the page (not by requests: the board polls
// every few seconds and would keep it alive forever). The sign-in sets it
// first. A customer would need developer tools on a locked-down iPad to move
// it; Guided Access stays the real lock (TESTING.md).
export const KIOSK_COOKIE = 'turn-kiosk';
export const KIOSK_UNLOCK_COOKIE = 'turn-kiosk-unlock';
export const KIOSK_SEEN_COOKIE = 'turn-kiosk-staff-seen';
export const KIOSK_STAFF_IDLE_MS = 5 * 60_000;

/** Has a staff session on a kiosk iPad gone idle? A missing or junk clock
 *  counts as idle: every sign-in on a kiosk sets it, so none means a session
 *  that did not come through the PIN. */
export function kioskStaffIdle(
  seen: string | undefined,
  now: number,
  idleMs = KIOSK_STAFF_IDLE_MS,
): boolean {
  if (!seen || !/^\d{10,16}$/.test(seen)) return true;
  return now - Number(seen) > idleMs;
}

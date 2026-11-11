// v0.9.1 (review finding 4): staff on a kiosk iPad are signed out after five
// minutes without a tap; a session with no clock never came through the PIN.
import { describe, expect, it } from 'vitest';
import { KIOSK_STAFF_IDLE_MS, kioskStaffIdle } from './kiosk-idle';

describe('kioskStaffIdle', () => {
  const now = 1_800_000_000_000;
  it('is not idle within five minutes of the last tap', () => {
    expect(kioskStaffIdle(String(now - 60_000), now)).toBe(false);
    expect(kioskStaffIdle(String(now - KIOSK_STAFF_IDLE_MS), now)).toBe(false);
  });
  it('is idle after five minutes', () => {
    expect(kioskStaffIdle(String(now - KIOSK_STAFF_IDLE_MS - 1), now)).toBe(true);
  });
  it('a missing or junk clock counts as idle', () => {
    expect(kioskStaffIdle(undefined, now)).toBe(true);
    expect(kioskStaffIdle('', now)).toBe(true);
    expect(kioskStaffIdle('soon', now)).toBe(true);
    expect(kioskStaffIdle('1e15', now)).toBe(true);
  });
  it('a clock from the future counts as idle, with a minute of slack (v0.10.1)', () => {
    expect(kioskStaffIdle(String(now + 30_000), now)).toBe(false);
    expect(kioskStaffIdle(String(now + 61_000), now)).toBe(true);
    expect(kioskStaffIdle(String(now + 365 * 24 * 3600_000), now)).toBe(true);
  });
});

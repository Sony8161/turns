'use server';

// Kiosk actions (Part 9). The device is always the one behind this browser's
// cookie, never an id from the form; a staff session on the same browser is
// refused, so the kiosk never acts as a person (threat model T20).
import {
  checkKioskPin,
  KIOSK_LIMITS,
  kioskCheckIn,
  kioskCheckInLimited,
  kioskGroupCheckIn,
  pairKiosk,
} from '@turn/db/kiosk';
import { consumeRateLimit } from '@turn/db/rate-limit';
import { normalizePhone } from '@turn/db/clients';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { currentKiosk, setKioskCookie, unlockThisKiosk } from '@/lib/kiosk';
import { clientIp } from '@/lib/request';
import { createClient, getAuthUser } from '@/lib/supabase/server';
import { kioskFromForm, kioskGroupFromForm } from './form';
import { guarded } from '@/lib/action';

export type KioskState = {
  error?: string;
  done?: boolean;
  name?: string;
  at?: number;
  ref?: string;
};

// Limits (T7, T25): a stolen or scripted kiosk cannot flood the queue, and the
// PIN and pairing code cannot be guessed. Generous for a real front desk. The
// numbers live in @turn/db/kiosk (v0.17.1), where each person in a group
// counts against the device and the address (review #5).
const PIN_TRIES = KIOSK_LIMITS.pinTries;
const PAIR_TRIES = KIOSK_LIMITS.pairTries;

async function limited(key: string, rule: { limit: number; windowS: number }): Promise<boolean> {
  const r = await consumeRateLimit(db(), key, rule.limit, rule.windowS);
  return !r.allowed;
}

/** The iPad redeems the pairing code from Admin → Kiosk. */
export async function pairThisIpad(prev: KioskState, formData: FormData): Promise<KioskState> {
  return guarded('pairThisIpad', { error: 'server' } as KioskState, () =>
    pairThisIpadRun(prev, formData),
  );
}

async function pairThisIpadRun(_prev: KioskState, formData: FormData): Promise<KioskState> {
  if (await getAuthUser()) return { error: 'staff_signed_in' };
  if (await limited(`kiosk:pair:ip:${await clientIp()}`, PAIR_TRIES)) {
    return { error: 'too_many' };
  }
  const code = String(formData.get('code') ?? '').slice(0, 40);
  const r = await pairKiosk(db(), { code });
  if (!r.ok) return { error: r.reason };
  await setKioskCookie(r.token);
  redirect('/kiosk');
}

/** A customer checks in. The same answer whether or not the phone is on file. */
export async function checkInAction(prev: KioskState, formData: FormData): Promise<KioskState> {
  return guarded('checkInAction', { error: 'server' } as KioskState, () =>
    checkInActionRun(prev, formData),
  );
}

async function checkInActionRun(_prev: KioskState, formData: FormData): Promise<KioskState> {
  if (await getAuthUser()) return { error: 'staff_signed_in' };
  const device = await currentKiosk();
  if (!device) return { error: 'not_paired' };
  const ip = await clientIp();
  const form = kioskFromForm(formData);
  if (!form.ok) return { error: form.reason };
  const phone = form.phone ? normalizePhone(form.phone) : null;
  if (form.phone && !phone) return { error: 'bad_phone' };
  // The device, the address and the phone (so one number cannot be checked
  // in over and over). The message is the generic one: it says nothing about
  // whether the number is known.
  if (await kioskCheckInLimited(db(), { device, ip, phone, people: 1 })) {
    return { error: 'too_many' };
  }
  const r = await kioskCheckIn(db(), {
    device,
    name: form.name,
    lastName: form.lastName,
    phone,
    serviceIds: form.serviceIds,
    requestedTechnicianId: form.requestedTechnicianId,
    attributes: form.attributes,
    sameTime: form.sameTime,
    note: form.note,
  });
  if (!r.ok) return { error: r.reason };
  revalidatePath('/admin');
  revalidatePath('/kiosk');
  // The first name only, to say thank you; the screen clears itself.
  return { done: true, name: form.name.trim().split(/\s+/)[0]?.slice(0, 40), at: Date.now() };
}

/**
 * v0.16.0: a group checks in ("We're a group"). The same guards as one
 * person. v0.17.1 (review #5): every person counts against the device and
 * the address limits; the group's one phone counts once (Duong, v0.16.0).
 * Nothing about a stored client comes back.
 */
export async function groupCheckInAction(
  prev: KioskState,
  formData: FormData,
): Promise<KioskState> {
  return guarded('groupCheckInAction', { error: 'server' } as KioskState, () =>
    groupCheckInActionRun(prev, formData),
  );
}

async function groupCheckInActionRun(_prev: KioskState, formData: FormData): Promise<KioskState> {
  if (await getAuthUser()) return { error: 'staff_signed_in' };
  const device = await currentKiosk();
  if (!device) return { error: 'not_paired' };
  const ip = await clientIp();
  const form = kioskGroupFromForm(formData);
  if (!form.ok) return { error: form.reason };
  const phone = form.phone ? normalizePhone(form.phone) : null;
  if (form.phone && !phone) return { error: 'bad_phone' };
  if (await kioskCheckInLimited(db(), { device, ip, phone, people: form.people.length })) {
    return { error: 'too_many' };
  }
  const r = await kioskGroupCheckIn(db(), {
    device,
    phone,
    people: form.people.map((p) => ({
      name: p.name,
      lastName: p.lastName,
      serviceIds: p.serviceIds,
      requestedTechnicianId: p.requestedTechnicianId,
      note: p.note,
    })),
  });
  if (!r.ok) return { error: r.reason };
  revalidatePath('/admin');
  revalidatePath('/kiosk');
  return { done: true, at: Date.now() };
}

/** Five taps on the logo, then the PIN: the iPad goes to the staff sign-in. */
export async function unlockAction(prev: KioskState, formData: FormData): Promise<KioskState> {
  return guarded('unlockAction', { error: 'server' } as KioskState, () =>
    unlockActionRun(prev, formData),
  );
}

async function unlockActionRun(_prev: KioskState, formData: FormData): Promise<KioskState> {
  const device = await currentKiosk();
  if (!device) return { error: 'not_paired' };
  if (await limited(`kiosk:pin:${device.deviceId}`, PIN_TRIES)) return { error: 'too_many' };
  const ok = await checkKioskPin(db(), device, String(formData.get('pin') ?? ''));
  if (!ok) return { error: 'bad_pin' };
  // The sign-in page checks this short window; typing /login alone gets the
  // kiosk back (v0.9.1, review finding 4).
  await unlockThisKiosk(device);
  redirect('/login');
}

/** On a kiosk iPad where someone is still signed in: sign them out first. */
export async function signOutForKiosk(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/kiosk');
}

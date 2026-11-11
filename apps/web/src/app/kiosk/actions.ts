'use server';

// Kiosk actions (Part 9). The device is always the one behind this browser's
// cookie, never an id from the form; a staff session on the same browser is
// refused, so the kiosk never acts as a person (threat model T20).
import { checkKioskPin, kioskCheckIn, pairKiosk } from '@turn/db/kiosk';
import { consumeRateLimit } from '@turn/db/rate-limit';
import { normalizePhone } from '@turn/db/clients';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { currentKiosk, setKioskCookie } from '@/lib/kiosk';
import { clientIp } from '@/lib/request';
import { createClient, getAuthUser } from '@/lib/supabase/server';
import { kioskFromForm } from './form';

export type KioskState = { error?: string; done?: boolean; name?: string; at?: number };

// Limits (T7, T25): a stolen or scripted kiosk cannot flood the queue, and the
// PIN and pairing code cannot be guessed. Generous for a real front desk.
const CHECKINS_PER_DEVICE = { limit: 30, windowS: 10 * 60 };
const CHECKINS_PER_PHONE = { limit: 3, windowS: 30 * 60 };
const CHECKINS_PER_IP = { limit: 60, windowS: 10 * 60 };
const PIN_TRIES = { limit: 5, windowS: 15 * 60 };
const PAIR_TRIES = { limit: 10, windowS: 15 * 60 };

async function limited(key: string, rule: { limit: number; windowS: number }): Promise<boolean> {
  const r = await consumeRateLimit(db(), key, rule.limit, rule.windowS);
  return !r.allowed;
}

/** The iPad redeems the pairing code from Admin → Kiosk. */
export async function pairThisIpad(_prev: KioskState, formData: FormData): Promise<KioskState> {
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
export async function checkInAction(_prev: KioskState, formData: FormData): Promise<KioskState> {
  if (await getAuthUser()) return { error: 'staff_signed_in' };
  const device = await currentKiosk();
  if (!device) return { error: 'not_paired' };
  const ip = await clientIp();
  if (
    (await limited(`kiosk:device:${device.deviceId}`, CHECKINS_PER_DEVICE)) ||
    (await limited(`kiosk:ip:${ip}`, CHECKINS_PER_IP))
  ) {
    return { error: 'too_many' };
  }
  const form = kioskFromForm(formData);
  if (!form.ok) return { error: form.reason };
  const phone = form.phone ? normalizePhone(form.phone) : null;
  if (form.phone && !phone) return { error: 'bad_phone' };
  // Per phone, so one number cannot be checked in over and over. The message
  // is the generic one: it says nothing about whether the number is known.
  if (phone && (await limited(`kiosk:phone:${device.locationId}:${phone}`, CHECKINS_PER_PHONE))) {
    return { error: 'too_many' };
  }
  const r = await kioskCheckIn(db(), {
    device,
    name: form.name,
    phone,
    serviceIds: form.serviceIds,
    requestedTechnicianId: form.requestedTechnicianId,
    attributes: form.attributes,
    sameTime: form.sameTime,
  });
  if (!r.ok) return { error: r.reason };
  revalidatePath('/admin');
  revalidatePath('/kiosk');
  // The first name only, to say thank you; the screen clears itself.
  return { done: true, name: form.name.trim().split(/\s+/)[0]?.slice(0, 40), at: Date.now() };
}

/** Five taps on the logo, then the PIN: the iPad goes to the staff sign-in. */
export async function unlockAction(_prev: KioskState, formData: FormData): Promise<KioskState> {
  const device = await currentKiosk();
  if (!device) return { error: 'not_paired' };
  if (await limited(`kiosk:pin:${device.deviceId}`, PIN_TRIES)) return { error: 'too_many' };
  const ok = await checkKioskPin(db(), device, String(formData.get('pin') ?? ''));
  if (!ok) return { error: 'bad_pin' };
  redirect('/login');
}

/** On a kiosk iPad where someone is still signed in: sign them out first. */
export async function signOutForKiosk(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/kiosk');
}

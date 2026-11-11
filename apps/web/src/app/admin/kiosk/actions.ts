'use server';

// Admin → Kiosk (Part 9): owners and managers register, re-pair and revoke the
// check-in iPads at their own location. The location comes from the
// membership, never from the form (threat model T10).
import { createKioskDevice, newPairingCode, pairKiosk, revokeKiosk } from '@turn/db/kiosk';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { uuidOf } from '@/lib/ids';
import { currentKiosk, setKioskCookie } from '@/lib/kiosk';
import { createClient } from '@/lib/supabase/server';
import { guarded, guardedVoid } from '@/lib/action';

export type KioskAdminState = { error?: string; code?: string; expiresAt?: string; ref?: string };

async function managerActor() {
  const actor = await requireActor();
  const m = membershipWith(actor, 'manage_kiosks');
  if (!m) return null;
  return { userId: actor.userId, organizationId: m.organizationId, locationId: m.locationId };
}

export async function registerKiosk(
  _prev: KioskAdminState,
  formData: FormData,
): Promise<KioskAdminState> {
  return guarded('registerKiosk', { error: 'server' } as KioskAdminState, () =>
    registerKioskRun(_prev, formData),
  );
}

async function registerKioskRun(
  _prev: KioskAdminState,
  formData: FormData,
): Promise<KioskAdminState> {
  const actor = await managerActor();
  if (!actor) return { error: 'not_allowed' };
  const r = await createKioskDevice(db(), {
    actor,
    name: String(formData.get('name') ?? ''),
    pin: String(formData.get('pin') ?? ''),
  });
  revalidatePath('/admin/kiosk');
  return r.ok ? { code: r.pairingCode, expiresAt: r.expiresAt.toISOString() } : { error: r.reason };
}

export async function repairKiosk(
  _prev: KioskAdminState,
  formData: FormData,
): Promise<KioskAdminState> {
  return guarded('repairKiosk', { error: 'server' } as KioskAdminState, () =>
    repairKioskRun(_prev, formData),
  );
}

async function repairKioskRun(
  _prev: KioskAdminState,
  formData: FormData,
): Promise<KioskAdminState> {
  const actor = await managerActor();
  if (!actor) return { error: 'not_allowed' };
  const deviceId = uuidOf(formData.get('deviceId'));
  if (!deviceId) return { error: 'unknown_device' };
  const r = await newPairingCode(db(), { actor, deviceId });
  revalidatePath('/admin/kiosk');
  return r.ok ? { code: r.pairingCode, expiresAt: r.expiresAt.toISOString() } : { error: r.reason };
}

export async function revokeKioskAction(
  _prev: KioskAdminState,
  formData: FormData,
): Promise<KioskAdminState> {
  return guarded('revokeKioskAction', { error: 'server' } as KioskAdminState, () =>
    revokeKioskActionRun(_prev, formData),
  );
}

async function revokeKioskActionRun(
  _prev: KioskAdminState,
  formData: FormData,
): Promise<KioskAdminState> {
  const actor = await managerActor();
  if (!actor) return { error: 'not_allowed' };
  const deviceId = uuidOf(formData.get('deviceId'));
  if (!deviceId) return { error: 'unknown_device' };
  const r = await revokeKiosk(db(), { actor, deviceId });
  revalidatePath('/admin/kiosk');
  return r.ok ? {} : { error: r.reason };
}

/** Registers this browser as the kiosk and signs the staff member out, so the
 *  kiosk never carries their session (T20). */
export async function makeThisIpadTheKiosk(
  _prev: KioskAdminState,
  formData: FormData,
): Promise<KioskAdminState> {
  return guarded('makeThisIpadTheKiosk', { error: 'server' } as KioskAdminState, () =>
    makeThisIpadTheKioskRun(_prev, formData),
  );
}

async function makeThisIpadTheKioskRun(
  _prev: KioskAdminState,
  formData: FormData,
): Promise<KioskAdminState> {
  const actor = await managerActor();
  if (!actor) return { error: 'not_allowed' };
  const made = await createKioskDevice(db(), {
    actor,
    name: String(formData.get('name') ?? ''),
    pin: String(formData.get('pin') ?? ''),
  });
  if (!made.ok) return { error: made.reason };
  const paired = await pairKiosk(db(), { code: made.pairingCode });
  if (!paired.ok) return { error: paired.reason };
  await setKioskCookie(paired.token);
  await (await createClient()).auth.signOut();
  redirect('/kiosk');
}

/** A receptionist iPad that is also paired as a kiosk switches into kiosk
 *  mode: the staff session ends, the kiosk screen starts. Only at a location
 *  the person works at. */
export async function enterKioskMode(): Promise<void> {
  return guardedVoid('enterKioskMode', () => enterKioskModeRun());
}

async function enterKioskModeRun(): Promise<void> {
  const actor = await requireActor();
  const device = await currentKiosk();
  const allowed =
    !!device &&
    actor.memberships.some(
      (m) =>
        m.locationId === device.locationId &&
        m.organizationId === device.organizationId &&
        m.role !== 'technician',
    );
  if (!allowed) redirect('/admin');
  await (await createClient()).auth.signOut();
  redirect('/kiosk');
}

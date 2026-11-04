'use server';

import { callNext, createWalkIn, expireCall, setLongWaitNotice } from '@turn/db/engine';
import { revalidatePath } from 'next/cache';
import { membershipWith, requireActor, type Membership } from '@/lib/auth';
import { db } from '@/lib/db';
import { can } from '@/lib/permissions';

export type DeskState = { error?: string; detail?: string };

async function deskMembership(): Promise<Membership | null> {
  const actor = await requireActor();
  return membershipWith(actor, 'enter_walkins');
}

/** The receptionist enters a walk-in: services only. The salon and location come
 *  from the membership, never from the form. */
export async function enterWalkIn(_prev: DeskState, formData: FormData): Promise<DeskState> {
  const actor = await requireActor();
  const m = await deskMembership();
  if (!m) return { error: 'not_allowed' };
  const serviceIds = formData.getAll('service').map(String).filter(Boolean);
  const requested = String(formData.get('requestedTechnician') ?? '');
  const result = await createWalkIn(db(), {
    organizationId: m.organizationId,
    locationId: m.locationId,
    serviceIds,
    requestedTechnicianId: requested || null,
    note: String(formData.get('note') ?? ''),
    actor: { userId: actor.userId },
  });
  revalidatePath('/admin');
  return result.ok ? {} : { error: result.reason };
}

/** Call the next technician for a waiting visit. Also used to re-send after a deny. */
export async function callNextFor(_prev: DeskState, formData: FormData): Promise<DeskState> {
  const actor = await requireActor();
  const m = await deskMembership();
  if (!m || !can(m.role, 'call_technician')) return { error: 'not_allowed' };
  const visitId = String(formData.get('visitId') ?? '');
  const result = await callNext(db(), {
    visitId,
    actor: { userId: actor.userId },
    locationId: m.locationId,
  });
  revalidatePath('/admin');
  revalidatePath('/me');
  return result.ok ? {} : { error: result.reason, detail: result.detail };
}

/** The desk clears a call nobody answered (after the rules' minutes): no
 *  penalty, the visit waits again. */
export async function clearCallFor(_prev: DeskState, formData: FormData): Promise<DeskState> {
  const actor = await requireActor();
  const m = await deskMembership();
  if (!m || !can(m.role, 'call_technician')) return { error: 'not_allowed' };
  const callId = String(formData.get('callId') ?? '');
  const result = await expireCall(db(), {
    callId,
    actor: { userId: actor.userId },
    locationId: m.locationId,
  });
  revalidatePath('/admin');
  revalidatePath('/me');
  return result.ok ? {} : { error: result.reason, detail: result.detail };
}

/** Receptionist or manager switches the customer long-wait notice (Duong, 2026-11-04). */
export async function setNotice(_prev: DeskState, formData: FormData): Promise<DeskState> {
  const actor = await requireActor();
  const m = await deskMembership();
  if (!m) return { error: 'not_allowed' };
  await setLongWaitNotice(db(), {
    organizationId: m.organizationId,
    locationId: m.locationId,
    enabled: formData.get('enabled') === 'true',
    actor: { userId: actor.userId },
  });
  revalidatePath('/admin');
  return {};
}

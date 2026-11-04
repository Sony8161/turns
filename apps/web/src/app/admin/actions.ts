'use server';

import { callNext, createWalkIn } from '@turn/db/engine';
import { revalidatePath } from 'next/cache';
import { requireActor, type Membership } from '@/lib/auth';
import { db } from '@/lib/db';
import { can } from '@/lib/permissions';

export type DeskState = { error?: string; detail?: string };

async function deskMembership(): Promise<Membership | null> {
  const actor = await requireActor();
  return actor.memberships.find((m) => can(m.role, 'enter_walkins')) ?? null;
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
  const result = await callNext(db(), { visitId, actor: { userId: actor.userId } });
  revalidatePath('/admin');
  revalidatePath('/me');
  return result.ok ? {} : { error: result.reason, detail: result.detail };
}

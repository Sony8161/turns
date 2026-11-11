'use server';

import { callNext, createWalkIn, expireCall, setLongWaitNotice } from '@turn/db/engine';
import { reviewKioskVisit } from '@turn/db/kiosk';
import { revalidatePath } from 'next/cache';
import { membershipWith, requireActor, type Membership } from '@/lib/auth';
import { db } from '@/lib/db';
import { uuidOf } from '@/lib/ids';
import { can } from '@/lib/permissions';
import { toSkippedLines, type SkippedLine } from './chips';
import { walkInFromForm } from './form';

export type DeskState = {
  error?: string;
  detail?: string;
  /** Who was passed over for the last call, and why (Part 6). */
  skipped?: SkippedLine[];
};

async function deskMembership(): Promise<Membership | null> {
  const actor = await requireActor();
  return membershipWith(actor, 'enter_walkins');
}

/** The receptionist enters a walk-in: services, and what the rules need to
 *  know about the client. The salon and location come from the membership,
 *  never from the form. */
export async function enterWalkIn(_prev: DeskState, formData: FormData): Promise<DeskState> {
  const actor = await requireActor();
  const m = await deskMembership();
  if (!m) return { error: 'not_allowed' };
  const w = walkInFromForm(formData);
  const result = await createWalkIn(db(), {
    organizationId: m.organizationId,
    locationId: m.locationId,
    serviceIds: w.serviceIds,
    requestedTechnicianId: w.requestedTechnicianId,
    note: w.note,
    client: w.client,
    attributes: w.attributes,
    sameTime: w.sameTime,
    actor: { userId: actor.userId },
  });
  revalidatePath('/admin');
  return result.ok ? {} : { error: result.reason };
}

/** Call the next technician for a waiting visit. Also used to re-send after a
 *  deny. The desk sees who was passed over and why (design doc, Eligibility). */
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
  return result.ok
    ? { skipped: toSkippedLines(result.skipped) }
    : { error: result.reason, detail: result.detail, skipped: toSkippedLines(result.skipped) };
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

/** The desk confirms a kiosk check-in (then it can be called) or declines it
 *  (nobody there): Part 9, threat model Q6. */
export async function reviewKioskFor(_prev: DeskState, formData: FormData): Promise<DeskState> {
  const actor = await requireActor();
  const m = await deskMembership();
  if (!m || !can(m.role, 'call_technician')) return { error: 'not_allowed' };
  const visitId = uuidOf(formData.get('visitId'));
  if (!visitId) return { error: 'unknown_visit' };
  const raw = formData.get('decision');
  const decision =
    raw === 'decline' ? 'decline' : raw === 'confirm_no_request' ? 'confirm_no_request' : 'confirm';
  const result = await reviewKioskVisit(db(), {
    actor: { userId: actor.userId, organizationId: m.organizationId, locationId: m.locationId },
    visitId,
    decision,
  });
  revalidatePath('/admin');
  return result.ok ? {} : { error: result.reason };
}

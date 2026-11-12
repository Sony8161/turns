'use server';

import {
  callNext,
  createWalkIn,
  deskCall,
  expireCall,
  setLongWaitNotice,
  setVisitNote,
} from '@turn/db/engine';
import { reviewKioskVisit } from '@turn/db/kiosk';
import { revalidatePath } from 'next/cache';
import { membershipWith, requireActor, type Membership } from '@/lib/auth';
import { db } from '@/lib/db';
import { uuidOf } from '@/lib/ids';
import { can } from '@/lib/permissions';
import { toSkippedLines, type SkippedLine } from './chips';
import { walkInFromForm } from './form';
import { guarded } from '@/lib/action';

export type DeskState = {
  /** Reference shown for an unplanned failure (v0.10.1). */
  ref?: string;
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
export async function enterWalkIn(prev: DeskState, formData: FormData): Promise<DeskState> {
  return guarded('enterWalkIn', { error: 'server' } as DeskState, () =>
    enterWalkInRun(prev, formData),
  );
}

async function enterWalkInRun(_prev: DeskState, formData: FormData): Promise<DeskState> {
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
export async function callNextFor(prev: DeskState, formData: FormData): Promise<DeskState> {
  return guarded('callNextFor', { error: 'server' } as DeskState, () =>
    callNextForRun(prev, formData),
  );
}

async function callNextForRun(_prev: DeskState, formData: FormData): Promise<DeskState> {
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

/**
 * v0.14.0: the desk calls one technician outside the turn order: asks a
 * higher-level technician for a service that is not hers by turn, or picks
 * the technician for a service that is never called by turn. Managers and
 * receptionists (call_technician). She may say no without a penalty.
 */
export async function deskCallFor(prev: DeskState, formData: FormData): Promise<DeskState> {
  return guarded('deskCallFor', { error: 'server' } as DeskState, () =>
    deskCallForRun(prev, formData),
  );
}

async function deskCallForRun(_prev: DeskState, formData: FormData): Promise<DeskState> {
  const actor = await requireActor();
  const m = await deskMembership();
  if (!m || !can(m.role, 'call_technician')) return { error: 'not_allowed' };
  const visitId = uuidOf(formData.get('visitId'));
  const technicianId = uuidOf(formData.get('technicianId'));
  const kind = String(formData.get('kind') ?? '');
  if (!visitId || !technicianId || (kind !== 'offer' && kind !== 'desk_pick')) {
    return { error: 'unknown_visit' };
  }
  const result = await deskCall(db(), {
    kind,
    visitId,
    technicianId,
    actor: { userId: actor.userId },
    locationId: m.locationId,
  });
  revalidatePath('/admin');
  revalidatePath('/me');
  return result.ok ? {} : { error: result.reason, detail: result.detail };
}

/** The desk clears a call nobody answered (after the rules' minutes): no
 *  penalty, the visit waits again. */
export async function clearCallFor(prev: DeskState, formData: FormData): Promise<DeskState> {
  return guarded('clearCallFor', { error: 'server' } as DeskState, () =>
    clearCallForRun(prev, formData),
  );
}

async function clearCallForRun(_prev: DeskState, formData: FormData): Promise<DeskState> {
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
export async function setNotice(prev: DeskState, formData: FormData): Promise<DeskState> {
  return guarded('setNotice', { error: 'server' } as DeskState, () => setNoticeRun(prev, formData));
}

async function setNoticeRun(_prev: DeskState, formData: FormData): Promise<DeskState> {
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

/** The desk adds, edits or clears the special request on an open visit (v0.10.2). */
export async function setNoteFor(prev: DeskState, formData: FormData): Promise<DeskState> {
  return guarded('setNoteFor', { error: 'server' } as DeskState, () =>
    setNoteForRun(prev, formData),
  );
}

async function setNoteForRun(_prev: DeskState, formData: FormData): Promise<DeskState> {
  const actor = await requireActor();
  const m = await deskMembership();
  if (!m) return { error: 'not_allowed' };
  const visitId = uuidOf(formData.get('visitId'));
  if (!visitId) return { error: 'unknown_visit' };
  const result = await setVisitNote(db(), {
    actor: { userId: actor.userId, organizationId: m.organizationId, locationId: m.locationId },
    visitId,
    note: String(formData.get('note') ?? ''),
  });
  revalidatePath('/admin');
  revalidatePath('/me');
  return result.ok ? {} : { error: result.reason };
}

/** The desk confirms a kiosk check-in (then it can be called) or declines it
 *  (nobody there): Part 9, threat model Q6. */
export async function reviewKioskFor(prev: DeskState, formData: FormData): Promise<DeskState> {
  return guarded('reviewKioskFor', { error: 'server' } as DeskState, () =>
    reviewKioskForRun(prev, formData),
  );
}

async function reviewKioskForRun(_prev: DeskState, formData: FormData): Promise<DeskState> {
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

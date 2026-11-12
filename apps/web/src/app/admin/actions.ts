'use server';

import {
  callNext,
  clientLeft,
  createWalkIn,
  deskCall,
  expireCall,
  setLongWaitNotice,
  setVisitNote,
} from '@turn/db/engine';
import { fixCandidates, reviewFix } from '@turn/db/fixes';
import { acknowledgeHelp } from '@turn/db/help';
import { reviewKioskVisit } from '@turn/db/kiosk';
import { createParty } from '@turn/db/party';
import { bookForLater, keepWaiting, sendByTurn } from '@turn/db/requests';
import { locations, services } from '@turn/db';
import { and, eq, inArray } from 'drizzle-orm';
import { getDictionary } from '@/i18n/lang';
import { revalidatePath } from 'next/cache';
import { membershipWith, requireActor, type Membership } from '@/lib/auth';
import { db } from '@/lib/db';
import { uuidOf } from '@/lib/ids';
import { can } from '@/lib/permissions';
import { toSkippedLines, type SkippedLine } from './chips';
import { salonTime } from './appointments/form';
import { groupFromForm, walkInFromForm } from './form';
import { guarded } from '@/lib/action';

export type DeskState = {
  /** Reference shown for an unplanned failure (v0.10.1). */
  ref?: string;
  error?: string;
  detail?: string;
  /** Who was passed over for the last call, and why (Part 6). */
  skipped?: SkippedLine[];
  /** v0.16.0: set when a group was added, so the form starts over. */
  done?: number;
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
  // v0.16.0: a nail fix: the role decides whether it waits for approval.
  const fixes = w.serviceIds.length
    ? await db()
        .select({ id: services.id })
        .from(services)
        .where(
          and(
            inArray(
              services.id,
              w.serviceIds.filter((id) => uuidOf(id)),
            ),
            eq(services.locationId, m.locationId),
            eq(services.isFix, true),
          ),
        )
    : [];
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
    ...(fixes.length && m.role !== 'technician'
      ? { fix: { enteredBy: m.role, ofVisitId: uuidOf(formData.get('fixOfVisit')) } }
      : {}),
  });
  revalidatePath('/admin');
  return result.ok ? {} : { error: result.reason };
}

/** v0.16.0: the client's visits inside the fix window, for the desk's fix entry. */
export type FixLookup = {
  windowDays: number;
  visits: {
    visitId: string;
    client: string | null;
    date: string;
    services: string[];
    technician: string | null;
    technicianWorking: boolean;
  }[];
};

export async function lookupFixVisits(query: string): Promise<FixLookup | { error: string }> {
  return guarded<FixLookup | { error: string }>(
    'lookupFixVisits',
    { error: 'server' },
    async () => {
      const m = await deskMembership();
      if (!m) return { error: 'not_allowed' };
      const [{ lang }, loc] = await Promise.all([
        getDictionary(),
        db()
          .select({ timezone: locations.timezone })
          .from(locations)
          .where(eq(locations.id, m.locationId))
          .then((r) => r[0]),
      ]);
      const found = await fixCandidates(db(), {
        locationId: m.locationId,
        query: String(query ?? '').slice(0, 60),
      });
      const day = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-US', {
        timeZone: loc?.timezone ?? 'America/New_York',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      return {
        windowDays: found.windowDays,
        visits: found.visits.map((v) => ({
          visitId: v.visitId,
          client: v.client,
          date: day.format(v.at),
          services: v.services,
          technician: v.technician,
          technicianWorking: v.technicianWorking,
        })),
      };
    },
  );
}

/** v0.16.0: a group at the desk: one visit per person, linked by a party id. */
export async function enterGroup(prev: DeskState, formData: FormData): Promise<DeskState> {
  return guarded('enterGroup', { error: 'server' } as DeskState, () =>
    enterGroupRun(prev, formData),
  );
}

async function enterGroupRun(_prev: DeskState, formData: FormData): Promise<DeskState> {
  const actor = await requireActor();
  const m = await deskMembership();
  if (!m) return { error: 'not_allowed' };
  const people = groupFromForm(formData);
  const result = await createParty(db(), {
    organizationId: m.organizationId,
    locationId: m.locationId,
    actor: { userId: actor.userId },
    people,
  });
  revalidatePath('/admin');
  return result.ok
    ? { done: Date.now() }
    : {
        error: result.reason,
        ...(result.person !== undefined ? { detail: String(result.person + 1) } : {}),
      };
}

/** v0.16.0: a manager or owner approves or declines a receptionist's fix. */
export async function reviewFixFor(prev: DeskState, formData: FormData): Promise<DeskState> {
  return guarded('reviewFixFor', { error: 'server' } as DeskState, () =>
    reviewFixForRun(prev, formData),
  );
}

async function reviewFixForRun(_prev: DeskState, formData: FormData): Promise<DeskState> {
  const actor = await requireActor();
  const m = await deskMembership();
  if (!m || !can(m.role, 'approve_fixes')) return { error: 'not_allowed' };
  const visitId = uuidOf(formData.get('visitId'));
  if (!visitId) return { error: 'unknown_visit' };
  const result = await reviewFix(db(), {
    actor: { userId: actor.userId, organizationId: m.organizationId, locationId: m.locationId },
    visitId,
    decision: formData.get('decision') === 'decline' ? 'decline' : 'approve',
  });
  revalidatePath('/admin');
  return result.ok ? {} : { error: result.reason };
}

/** v0.16.0: the client left after the call, before the service started. */
export async function clientLeftFor(prev: DeskState, formData: FormData): Promise<DeskState> {
  return guarded('clientLeftFor', { error: 'server' } as DeskState, () =>
    clientLeftForRun(prev, formData),
  );
}

async function clientLeftForRun(_prev: DeskState, formData: FormData): Promise<DeskState> {
  const actor = await requireActor();
  const m = await deskMembership();
  if (!m || !can(m.role, 'call_technician')) return { error: 'not_allowed' };
  const visitId = uuidOf(formData.get('visitId'));
  if (!visitId) return { error: 'unknown_visit' };
  const result = await clientLeft(db(), {
    visitId,
    actor: { userId: actor.userId },
    locationId: m.locationId,
  });
  revalidatePath('/admin');
  revalidatePath('/me');
  return result.ok ? {} : { error: result.reason };
}

/** v0.16.0: someone at the desk is on a technician's "Need help". */
export async function ackHelpFor(prev: DeskState, formData: FormData): Promise<DeskState> {
  return guarded('ackHelpFor', { error: 'server' } as DeskState, () =>
    ackHelpForRun(prev, formData),
  );
}

async function ackHelpForRun(_prev: DeskState, formData: FormData): Promise<DeskState> {
  const actor = await requireActor();
  const m = await deskMembership();
  if (!m) return { error: 'not_allowed' };
  const id = uuidOf(formData.get('helpId'));
  if (!id) return { error: 'unknown_request' };
  const result = await acknowledgeHelp(db(), {
    actor: { userId: actor.userId, organizationId: m.organizationId, locationId: m.locationId },
    id,
  });
  revalidatePath('/admin');
  revalidatePath('/me');
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
    // v0.16.0: "Confirm all" on a group from the kiosk.
    wholeParty: formData.get('wholeParty') === 'true',
  });
  revalidatePath('/admin');
  return result.ok ? {} : { error: result.reason };
}

/**
 * v0.15.0: the client asked for (or booked) a technician who is busy. The
 * desk keeps them waiting, books them for later with her, or drops the request
 * so the visit goes by turn. Receptionists and managers (call_technician);
 * every decision is in the log. The engine never falls back on its own.
 */
export async function requestHoldFor(prev: DeskState, formData: FormData): Promise<DeskState> {
  return guarded('requestHoldFor', { error: 'server' } as DeskState, () =>
    requestHoldForRun(prev, formData),
  );
}

async function requestHoldForRun(_prev: DeskState, formData: FormData): Promise<DeskState> {
  const actor = await requireActor();
  const m = await deskMembership();
  if (!m || !can(m.role, 'call_technician')) return { error: 'not_allowed' };
  const visitId = uuidOf(formData.get('visitId'));
  if (!visitId) return { error: 'unknown_visit' };
  const who = { userId: actor.userId, organizationId: m.organizationId, locationId: m.locationId };
  const decision = String(formData.get('decision') ?? '');
  let result: { ok: true } | { ok: false; reason: string };
  if (decision === 'keep') {
    result = await keepWaiting(db(), { actor: who, visitId });
  } else if (decision === 'by_turn') {
    result = await sendByTurn(db(), { actor: who, visitId });
  } else if (decision === 'book') {
    // The desk types a wall-clock time at the salon, not the iPad's zone.
    const [loc] = await db()
      .select({ timezone: locations.timezone })
      .from(locations)
      .where(eq(locations.id, m.locationId));
    const startAt = salonTime(formData.get('start'), loc?.timezone ?? 'America/New_York');
    if (!startAt) return { error: 'bad_time' };
    result = await bookForLater(db(), { actor: who, visitId, startAt });
  } else {
    return { error: 'unknown_visit' };
  }
  revalidatePath('/admin');
  revalidatePath('/admin/appointments');
  if (result.ok) return {};
  // Every time problem reads the same to the desk: pick another time.
  const time = ['end_before_start', 'too_long', 'too_far_back', 'too_far_ahead'];
  return { error: time.includes(result.reason) ? 'bad_time' : result.reason };
}

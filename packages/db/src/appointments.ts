// Appointments (Part 7): what the desk enters by hand, what the calendar feed
// brings in, and "client arrived", which turns one into a visit for the
// technician it was booked with. Server only. Threat model T15: a missed
// appointment is a pay error, so the desk can always enter one by hand.
//
// The audit log gets times and technicians, never the client's name (T11).
import { and, asc, eq, gt, gte, isNull, lt, lte, ne } from 'drizzle-orm';
import { createWalkIn, type ClientAttributes, type EngineError } from './engine';
import { appointments, technicians } from './schema';
import type { Db } from './server';
import { writeAudit, type Actor } from './status';

/** Someone at the desk, acting at their own location (T10). */
export type DeskActor = Actor & { organizationId: string; locationId: string };

const MAX_NAME = 120;
const MAX_REASON = 300;
const MAX_HOURS = 12;
const PAST_DAYS = 1;
const AHEAD_DAYS = 90;
/** Two open appointments for one technician starting this close together are
 *  one appointment entered twice (by hand and from the calendar). v0.7.1. */
export const DUPLICATE_WINDOW_MIN = 10;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Open (not cancelled) appointments of `technicianId` starting within the
 *  duplicate window of `startAt`, other than `exceptId`. */
export async function sameSlot(
  tx: Tx,
  technicianId: string,
  startAt: Date,
  exceptId?: string,
): Promise<(typeof appointments.$inferSelect)[]> {
  const w = DUPLICATE_WINDOW_MIN * 60_000;
  return tx
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.technicianId, technicianId),
        isNull(appointments.cancelledAt),
        gte(appointments.startAt, new Date(startAt.getTime() - w)),
        lte(appointments.startAt, new Date(startAt.getTime() + w)),
        exceptId ? ne(appointments.id, exceptId) : undefined,
      ),
    )
    .for('update');
}

export type AppointmentInput = {
  technicianId: string;
  startAt: Date;
  endAt: Date;
  clientName?: string | null;
};

function checkTimes(startAt: Date, endAt: Date, now: Date): string | null {
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) return 'bad_time';
  const length = endAt.getTime() - startAt.getTime();
  if (length <= 0) return 'end_before_start';
  if (length > MAX_HOURS * 3_600_000) return 'too_long';
  if (startAt.getTime() < now.getTime() - PAST_DAYS * 86_400_000) return 'too_far_back';
  if (startAt.getTime() > now.getTime() + AHEAD_DAYS * 86_400_000) return 'too_far_ahead';
  return null;
}

const cleanName = (n: string | null | undefined) =>
  n
    ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, MAX_NAME) || null;

async function techAt(
  db: Db | Parameters<Parameters<Db['transaction']>[0]>[0],
  id: string,
  actor: DeskActor,
) {
  const [t] = await db
    .select({ id: technicians.id })
    .from(technicians)
    .where(
      and(
        eq(technicians.id, id),
        eq(technicians.locationId, actor.locationId),
        eq(technicians.organizationId, actor.organizationId),
        eq(technicians.active, true),
      ),
    );
  return t ?? null;
}

/** The desk enters an appointment by hand (the fallback when the feed missed it). */
export async function addAppointment(
  db: Db,
  input: AppointmentInput & { actor: DeskActor; now?: Date },
): Promise<{ ok: true; appointmentId: string } | EngineError> {
  const now = input.now ?? new Date();
  const bad = checkTimes(input.startAt, input.endAt, now);
  if (bad) return { ok: false, reason: bad };
  return db.transaction(async (tx) => {
    if (!(await techAt(tx, input.technicianId, input.actor))) {
      return { ok: false, reason: 'unknown_technician' };
    }
    // Already on the book (most often: the calendar brought it in).
    if ((await sameSlot(tx, input.technicianId, input.startAt)).length > 0) {
      return { ok: false, reason: 'duplicate' };
    }
    const [row] = await tx
      .insert(appointments)
      .values({
        organizationId: input.actor.organizationId,
        locationId: input.actor.locationId,
        technicianId: input.technicianId,
        clientName: cleanName(input.clientName),
        startAt: input.startAt,
        endAt: input.endAt,
        source: 'manual',
        createdBy: input.actor.userId,
      })
      .returning({ id: appointments.id });
    if (!row) throw new Error('appointment insert returned nothing');
    await writeAudit(tx, {
      organizationId: input.actor.organizationId,
      locationId: input.actor.locationId,
      actorUserId: input.actor.userId,
      entityType: 'appointments',
      entityId: row.id,
      action: 'appointment_added',
      after: {
        technicianId: input.technicianId,
        startAt: input.startAt,
        endAt: input.endAt,
        hasName: !!cleanName(input.clientName),
      },
    });
    return { ok: true, appointmentId: row.id };
  });
}

type Row = typeof appointments.$inferSelect;

/** Loads and locks an appointment the actor may change; refusals say why. */
async function editable(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  id: string,
  actor: DeskActor,
): Promise<{ ok: true; row: Row } | EngineError> {
  const [row] = await tx.select().from(appointments).where(eq(appointments.id, id)).for('update');
  if (!row) return { ok: false, reason: 'unknown_appointment' };
  if (row.locationId !== actor.locationId || row.organizationId !== actor.organizationId) {
    return { ok: false, reason: 'wrong_location' };
  }
  if (row.arrivedAt) return { ok: false, reason: 'already_arrived' };
  if (row.cancelledAt) return { ok: false, reason: 'already_cancelled' };
  // The calendar owns its rows: change them in Fresha, the next poll follows.
  if (row.source === 'ics') return { ok: false, reason: 'from_calendar' };
  return { ok: true, row };
}

/** The desk moves a hand-entered appointment (time, technician, name). */
export async function editAppointment(
  db: Db,
  input: AppointmentInput & { appointmentId: string; actor: DeskActor; now?: Date },
): Promise<{ ok: true } | EngineError> {
  const now = input.now ?? new Date();
  const bad = checkTimes(input.startAt, input.endAt, now);
  if (bad) return { ok: false, reason: bad };
  return db.transaction(async (tx) => {
    const got = await editable(tx, input.appointmentId, input.actor);
    if (!got.ok) return got;
    if (!(await techAt(tx, input.technicianId, input.actor))) {
      return { ok: false, reason: 'unknown_technician' };
    }
    const { row } = got;
    if ((await sameSlot(tx, input.technicianId, input.startAt, row.id)).length > 0) {
      return { ok: false, reason: 'duplicate' };
    }
    await tx
      .update(appointments)
      .set({
        technicianId: input.technicianId,
        startAt: input.startAt,
        endAt: input.endAt,
        clientName: cleanName(input.clientName),
        updatedAt: now,
      })
      .where(eq(appointments.id, row.id));
    await writeAudit(tx, {
      organizationId: row.organizationId,
      locationId: row.locationId,
      actorUserId: input.actor.userId,
      entityType: 'appointments',
      entityId: row.id,
      action: 'appointment_changed',
      before: { technicianId: row.technicianId, startAt: row.startAt, endAt: row.endAt },
      after: { technicianId: input.technicianId, startAt: input.startAt, endAt: input.endAt },
    });
    return { ok: true };
  });
}

/** The desk cancels a hand-entered appointment. Nothing is deleted. */
export async function cancelAppointment(
  db: Db,
  input: { appointmentId: string; actor: DeskActor; reason?: string | null; now?: Date },
): Promise<{ ok: true } | EngineError> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const got = await editable(tx, input.appointmentId, input.actor);
    if (!got.ok) return got;
    const { row } = got;
    await tx
      .update(appointments)
      .set({ cancelledAt: now, updatedAt: now })
      .where(eq(appointments.id, row.id));
    await writeAudit(tx, {
      organizationId: row.organizationId,
      locationId: row.locationId,
      actorUserId: input.actor.userId,
      entityType: 'appointments',
      entityId: row.id,
      action: 'appointment_cancelled',
      before: { technicianId: row.technicianId, startAt: row.startAt, endAt: row.endAt },
      reason: input.reason?.trim().slice(0, MAX_REASON) || null,
    });
    return { ok: true };
  });
}

/**
 * The client is here: the appointment becomes a visit with source
 * `appointment` for the technician it was booked with. The rules' appointment
 * discount applies at finish (an appointment full set posts 0, shown as 00).
 * The desk then calls that technician the usual way; when they cannot take it,
 * the visit waits for them and the desk sees why. Whether an appointment may
 * fall back to the line is not decided (open with Phu, like a request).
 */
export async function appointmentArrived(
  db: Db,
  input: {
    appointmentId: string;
    serviceIds: string[];
    actor: DeskActor;
    attributes?: ClientAttributes | null;
    note?: string | null;
    now?: Date;
  },
): Promise<{ ok: true; visitId: string } | EngineError> {
  const now = input.now ?? new Date();
  if (input.serviceIds.length === 0) return { ok: false, reason: 'no_services' };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(appointments)
      .where(eq(appointments.id, input.appointmentId))
      .for('update');
    if (!row) return { ok: false, reason: 'unknown_appointment' };
    if (
      row.locationId !== input.actor.locationId ||
      row.organizationId !== input.actor.organizationId
    ) {
      return { ok: false, reason: 'wrong_location' };
    }
    if (row.arrivedAt) return { ok: false, reason: 'already_arrived' };
    if (row.cancelledAt) return { ok: false, reason: 'already_cancelled' };
    // A copy of this appointment (hand-entered and from the calendar) that has
    // already arrived: it is the same client, one visit only (v0.7.1).
    const copies = await sameSlot(tx, row.technicianId, row.startAt, row.id);
    if (copies.some((c) => c.arrivedAt)) return { ok: false, reason: 'already_arrived' };
    const visit = await createWalkIn(tx as unknown as Db, {
      organizationId: row.organizationId,
      locationId: row.locationId,
      serviceIds: input.serviceIds,
      actor: { userId: input.actor.userId },
      source: 'appointment',
      requestedTechnicianId: row.technicianId,
      note: input.note ?? null,
      attributes: input.attributes ?? null,
      // An appointment is one visit with its technician (no same-time split).
      sameTime: false,
    });
    if (!visit.ok) return visit;
    await tx
      .update(appointments)
      .set({ arrivedAt: now, visitId: visit.visitId, updatedAt: now })
      .where(eq(appointments.id, row.id));
    await writeAudit(tx, {
      organizationId: row.organizationId,
      locationId: row.locationId,
      actorUserId: input.actor.userId,
      entityType: 'appointments',
      entityId: row.id,
      action: 'appointment_arrived',
      after: { visitId: visit.visitId, technicianId: row.technicianId, startAt: row.startAt },
    });
    // The copies arrive with it: they stop holding the technician out of the
    // queue and cannot become a second visit (or a second discount).
    for (const c of copies) {
      await tx
        .update(appointments)
        .set({ arrivedAt: now, updatedAt: now })
        .where(eq(appointments.id, c.id));
      await writeAudit(tx, {
        organizationId: row.organizationId,
        locationId: row.locationId,
        actorUserId: input.actor.userId,
        entityType: 'appointments',
        entityId: c.id,
        action: 'appointment_merged',
        after: { into: row.id, visitId: visit.visitId, technicianId: c.technicianId },
      });
    }
    return { ok: true, visitId: visit.visitId };
  });
}

export type AppointmentRow = {
  id: string;
  technicianId: string;
  technicianName: string;
  clientName: string | null;
  startAt: Date;
  endAt: Date;
  source: 'ics' | 'manual';
  arrivedAt: Date | null;
  cancelledAt: Date | null;
};

/** A location's appointments in a window, for the desk (staff only). */
export async function appointmentsBetween(
  db: Db,
  locationId: string,
  from: Date,
  to: Date,
): Promise<AppointmentRow[]> {
  return db
    .select({
      id: appointments.id,
      technicianId: appointments.technicianId,
      technicianName: technicians.displayName,
      clientName: appointments.clientName,
      startAt: appointments.startAt,
      endAt: appointments.endAt,
      source: appointments.source,
      arrivedAt: appointments.arrivedAt,
      cancelledAt: appointments.cancelledAt,
    })
    .from(appointments)
    .innerJoin(technicians, eq(technicians.id, appointments.technicianId))
    .where(
      and(
        eq(appointments.locationId, locationId),
        gte(appointments.startAt, from),
        lt(appointments.startAt, to),
      ),
    )
    .orderBy(asc(appointments.startAt));
}

/** A technician's own coming appointments: times only (the phone never shows clients, T11). */
export async function upcomingFor(
  db: Db,
  technicianId: string,
  now = new Date(),
  limit = 5,
): Promise<{ startAt: Date; endAt: Date }[]> {
  return db
    .select({ startAt: appointments.startAt, endAt: appointments.endAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.technicianId, technicianId),
        isNull(appointments.cancelledAt),
        isNull(appointments.arrivedAt),
        gt(appointments.endAt, now),
      ),
    )
    .orderBy(asc(appointments.startAt))
    .limit(limit);
}

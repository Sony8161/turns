// v0.15.0 (Duong, 2026-11-12): the client asked for a technician, or booked
// one, and she is busy. The engine never falls back on its own: the visit
// waits for her. The desk sees her status and her next appointment, is
// flagged once the client has waited a while (rules: attention.request_wait_min),
// and decides: keep waiting, book the client for later with her, or drop the
// request and send the visit by turn. Every decision is audited. Server only.
import { and, asc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { addAppointment } from './appointments';
import {
  contextOf,
  queueFor,
  type EngineError,
  type ManagerActor,
  type SkipReason,
} from './engine';
import { activeRules } from './rules';
import {
  appointments,
  clients,
  services,
  technicianStatus,
  technicians,
  visitServices,
  visits,
} from './schema';
import type { Db } from './server';
import { writeAudit } from './status';

export type RequestHold = {
  technicianId: string;
  technicianName: string;
  /** Why she cannot be called now: her status, or the engine's reason. */
  status: SkipReason | 'off';
  /** For appointment_soon: minutes until it. */
  detail?: string;
  /** Since when she has been in that status (with a client since...). */
  since: Date | null;
  nextAppointmentAt: Date | null;
  /** Minutes the client has waited since they arrived. */
  waitedMin: number;
  /** The client has waited the rules' minutes since arriving, or since the
   *  desk last pressed "Keep waiting". */
  attention: boolean;
  /** An appointment (booked), not a request made at the desk or the kiosk. */
  booked: boolean;
};

/**
 * Waiting visits whose requested or booked technician cannot be called right
 * now, keyed by visit. A visit whose technician is free is not here: the desk
 * presses Call next.
 */
export async function requestHolds(
  db: Db,
  locationId: string,
  now = new Date(),
): Promise<Map<string, RequestHold>> {
  const rules = await activeRules(db, locationId);
  const waitMs = rules.attention.request_wait_min * 60_000;
  const bufferMs = rules.eligibility.upcoming_appointment_buffer_min * 60_000;
  const out = new Map<string, RequestHold>();
  await db.transaction(async (tx) => {
    const waiting = await tx
      .select()
      .from(visits)
      .where(
        and(
          eq(visits.locationId, locationId),
          eq(visits.status, 'waiting'),
          eq(visits.needsConfirm, false),
          isNotNull(visits.requestedTechnicianId),
        ),
      );
    for (const visit of waiting) {
      const booked = visit.source === 'appointment';
      // With the bypass rule off a request is a note: the line decides.
      if (!booked && !rules.requests.requested_tech_bypasses_queue) continue;
      const technicianId = visit.requestedTechnicianId!;
      const queue = await queueFor(tx, locationId, await contextOf(tx, visit), now);
      const her = queue.find((c) => c.technicianId === technicianId);
      if (her?.eligible) continue;
      const [tech] = await tx
        .select({ name: technicians.displayName, since: technicianStatus.since })
        .from(technicians)
        .leftJoin(technicianStatus, eq(technicianStatus.technicianId, technicians.id))
        .where(eq(technicians.id, technicianId));
      const [next] = await tx
        .select({ startAt: appointments.startAt })
        .from(appointments)
        .where(
          and(
            eq(appointments.technicianId, technicianId),
            isNull(appointments.cancelledAt),
            isNull(appointments.arrivedAt),
            gt(appointments.endAt, now),
            // A client past the buffer is a no-show and no longer holds her.
            gt(appointments.startAt, new Date(now.getTime() - bufferMs)),
          ),
        )
        .orderBy(asc(appointments.startAt))
        .limit(1);
      const from = Math.max(visit.arrivedAt.getTime(), visit.requestAckAt?.getTime() ?? 0);
      out.set(visit.id, {
        technicianId,
        technicianName: tech?.name ?? '?',
        status: her ? her.why : 'off',
        ...(her?.detail ? { detail: her.detail } : {}),
        since: her ? (tech?.since ?? null) : null,
        nextAppointmentAt: next?.startAt ?? null,
        waitedMin: Math.max(0, Math.floor((now.getTime() - visit.arrivedAt.getTime()) / 60_000)),
        attention: now.getTime() - from >= waitMs,
        booked,
      });
    }
  });
  return out;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

type HoldError = {
  ok: false;
  reason: 'unknown_visit' | 'visit_not_waiting' | 'no_request' | 'needs_confirm';
};

/** The waiting visit with a request, at the actor's own location (T10), locked. */
async function heldVisit(
  tx: Tx,
  actor: ManagerActor,
  visitId: string,
): Promise<{ ok: true; visit: typeof visits.$inferSelect } | HoldError> {
  const [visit] = await tx
    .select()
    .from(visits)
    .where(
      and(
        eq(visits.id, visitId),
        eq(visits.locationId, actor.locationId),
        eq(visits.organizationId, actor.organizationId),
      ),
    )
    .for('update');
  if (!visit) return { ok: false, reason: 'unknown_visit' };
  if (visit.status !== 'waiting') return { ok: false, reason: 'visit_not_waiting' };
  if (visit.needsConfirm) return { ok: false, reason: 'needs_confirm' };
  if (!visit.requestedTechnicianId) return { ok: false, reason: 'no_request' };
  return { ok: true, visit };
}

/** "Keep waiting": the desk has seen it; the flag comes back after the rules' minutes. */
export async function keepWaiting(
  db: Db,
  input: { actor: ManagerActor; visitId: string; now?: Date },
): Promise<{ ok: true } | HoldError> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const found = await heldVisit(tx, input.actor, input.visitId);
    if (!found.ok) return found;
    await tx
      .update(visits)
      .set({ requestAckAt: now, updatedAt: new Date() })
      .where(eq(visits.id, found.visit.id));
    await writeAudit(tx, {
      organizationId: found.visit.organizationId,
      locationId: found.visit.locationId,
      actorUserId: input.actor.userId,
      entityType: 'visits',
      entityId: found.visit.id,
      action: 'request_keep_waiting',
      after: {
        technicianId: found.visit.requestedTechnicianId,
        waitedMin: Math.max(
          0,
          Math.floor((now.getTime() - found.visit.arrivedAt.getTime()) / 60_000),
        ),
      },
    });
    return { ok: true } as const;
  });
}

/**
 * "Send by turn": the request (or the booking) is dropped and the line
 * decides. The visit counts as a walk-in for whoever takes it: no appointment
 * discount and no request multiplier, because it is no longer her client.
 */
export async function sendByTurn(
  db: Db,
  input: { actor: ManagerActor; visitId: string },
): Promise<{ ok: true } | HoldError> {
  return db.transaction(async (tx) => {
    const found = await heldVisit(tx, input.actor, input.visitId);
    if (!found.ok) return found;
    const { visit } = found;
    const source = visit.kioskDeviceId ? 'self_checkin' : 'walk_in';
    await tx
      .update(visits)
      .set({ requestedTechnicianId: null, source, requestAckAt: null, updatedAt: new Date() })
      .where(eq(visits.id, visit.id));
    await writeAudit(tx, {
      organizationId: visit.organizationId,
      locationId: visit.locationId,
      actorUserId: input.actor.userId,
      entityType: 'visits',
      entityId: visit.id,
      action: 'request_sent_by_turn',
      before: { source: visit.source, requestedTechnicianId: visit.requestedTechnicianId },
      after: { source, requestedTechnicianId: null },
    });
    return { ok: true } as const;
  });
}

/**
 * "Book for later": an appointment with the technician the client asked for,
 * at the time the desk picks, as long as the services take. The visit leaves
 * the line (cancelled); when the client comes back the desk presses "Client
 * arrived" on the appointment as usual.
 */
export async function bookForLater(
  db: Db,
  input: { actor: ManagerActor; visitId: string; startAt: Date; now?: Date },
): Promise<{ ok: true; appointmentId: string } | HoldError | EngineError> {
  const now = input.now ?? new Date();
  if (Number.isNaN(input.startAt.getTime()) || input.startAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'bad_time' };
  }
  return db.transaction(async (tx) => {
    const found = await heldVisit(tx, input.actor, input.visitId);
    if (!found.ok) return found;
    const { visit } = found;
    const technicianId = visit.requestedTechnicianId!;
    const rules = await activeRules(tx, visit.locationId);
    const items = await tx
      .select({ minutes: services.defaultDurationMin })
      .from(visitServices)
      .innerJoin(services, eq(services.id, visitServices.serviceId))
      .where(eq(visitServices.visitId, visit.id));
    const minutes =
      items.reduce((sum, i) => sum + (i.minutes ?? rules.attention.default_service_min), 0) ||
      rules.attention.default_service_min;
    const [client] = visit.clientId
      ? await tx
          .select({
            name: clients.name,
            firstName: clients.firstName,
            lastName: clients.lastName,
          })
          .from(clients)
          .where(eq(clients.id, visit.clientId))
      : [];
    const clientName =
      [client?.firstName, client?.lastName].filter(Boolean).join(' ') ||
      client?.name ||
      [visit.kioskName, visit.kioskLastName].filter(Boolean).join(' ') ||
      null;
    // Decide before writing: a refused appointment leaves the visit waiting.
    const made = await addAppointment(tx as unknown as Db, {
      actor: input.actor,
      technicianId,
      startAt: input.startAt,
      endAt: new Date(input.startAt.getTime() + minutes * 60_000),
      clientName,
      // v0.17.0: the client page counts this booking's no-show, if it is one.
      clientId: visit.clientId,
      now,
    });
    if (!made.ok) return made;
    await tx
      .update(visits)
      .set({ status: 'cancelled', cancelledAt: now, updatedAt: new Date() })
      .where(eq(visits.id, visit.id));
    // Times and the technician, never the client's name (T11).
    await writeAudit(tx, {
      organizationId: visit.organizationId,
      locationId: visit.locationId,
      actorUserId: input.actor.userId,
      entityType: 'visits',
      entityId: visit.id,
      action: 'request_booked_later',
      before: { source: visit.source, status: visit.status },
      after: {
        technicianId,
        appointmentId: made.appointmentId,
        startAt: input.startAt,
        minutes,
      },
    });
    return { ok: true, appointmentId: made.appointmentId } as const;
  });
}

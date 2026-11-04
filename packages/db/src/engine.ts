// The turn engine (design doc, Rule engine and Call flow). Server only. App
// code decides, the database enforces: one open call per technician and per
// visit (partial unique indexes), and every move writes the audit log.
// Every number comes from rule_config (rules.ts); nothing here is hard-coded.
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { activeRules, visitPointsUnder, type RuleConfig } from './rules';
import {
  auditLog,
  locations,
  serviceCategories,
  services,
  shifts,
  technicianStatus,
  technicians,
  turnCalls,
  turnLedger,
  visitServices,
  visits,
} from './schema';
import type { Db } from './server';
import { postPoints, transition, writeAudit, type Actor } from './status';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const DENY_REASONS = [
  'not_my_service',
  'with_another_client',
  'break_needed',
  'client_issue',
  'other',
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

export type { RuleConfig };

export type EngineError = { ok: false; reason: string; detail?: string };

/** A receptionist enters a walk-in: services only (Duong, 2026-11-04). */
export async function createWalkIn(
  db: Db,
  input: {
    organizationId: string;
    locationId: string;
    serviceIds: string[];
    actor: Actor;
    source?: 'walk_in' | 'appointment' | 'request' | 'self_checkin';
    requestedTechnicianId?: string | null;
    /** Free text from the desk: special requests the engine does not model yet. */
    note?: string | null;
  },
): Promise<{ ok: true; visitId: string } | EngineError> {
  if (input.serviceIds.length === 0) return { ok: false, reason: 'no_services' };
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: services.id,
        isFillOrFullSet: serviceCategories.isFillOrFullSet,
        categoryId: serviceCategories.id,
      })
      .from(services)
      .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
      .where(
        and(
          inArray(services.id, input.serviceIds),
          eq(services.locationId, input.locationId),
          isNull(services.archivedAt),
        ),
      );
    if (rows.length !== new Set(input.serviceIds).size) {
      return { ok: false, reason: 'unknown_service' };
    }
    const rules = await activeRules(tx, input.locationId);
    const source = input.source ?? 'walk_in';
    const [visit] = await tx
      .insert(visits)
      .values({
        organizationId: input.organizationId,
        locationId: input.locationId,
        source: input.requestedTechnicianId ? 'request' : source,
        requestedTechnicianId: input.requestedTechnicianId ?? null,
        note: input.note?.trim().slice(0, 300) || null,
        createdBy: input.actor.userId,
      })
      .returning({ id: visits.id });
    if (!visit) throw new Error('visit insert returned nothing');
    await tx.insert(visitServices).values(
      rows.map((s) => ({
        organizationId: input.organizationId,
        visitId: visit.id,
        serviceId: s.id,
        pointsValueSnapshot: visitPointsUnder(rules, [s], 'walk_in').toFixed(1),
      })),
    );
    await writeAudit(tx, {
      organizationId: input.organizationId,
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      entityType: 'visits',
      entityId: visit.id,
      action: 'visit_created',
      after: { source, serviceIds: input.serviceIds },
    });
    return { ok: true, visitId: visit.id };
  });
}

type Candidate = {
  technicianId: string;
  displayName: string;
  points: number;
  checkedInAt: Date | null;
  status: string;
  eligible: boolean;
  why: string;
};

/** Everyone on shift, in queue order, with why each one can or cannot be called. */
export async function queueFor(tx: Tx, locationId: string): Promise<Candidate[]> {
  const rows = await tx
    .select({
      technicianId: technicians.id,
      displayName: technicians.displayName,
      status: technicianStatus.status,
      checkedInAt: shifts.checkedInAt,
      points: sql<string>`coalesce((select sum(${turnLedger.delta}) from ${turnLedger} where ${turnLedger.shiftId} = ${technicianStatus.shiftId}), 0)`,
      openCall: sql<number>`(select count(*) from ${turnCalls} c where c.technician_id = ${technicians.id} and c.responded_at is null)`,
    })
    .from(technicians)
    .innerJoin(technicianStatus, eq(technicianStatus.technicianId, technicians.id))
    .leftJoin(shifts, eq(shifts.id, technicianStatus.shiftId))
    .where(and(eq(technicians.locationId, locationId), eq(technicians.active, true)));
  return rows
    .filter((r) => r.status !== 'off')
    .map((r) => {
      let why = 'available';
      let eligible = true;
      if (r.status !== 'available') {
        eligible = false;
        why = r.status;
      } else if (Number(r.openCall) > 0) {
        eligible = false;
        why = 'already_called';
      }
      return {
        technicianId: r.technicianId,
        displayName: r.displayName,
        points: Number(r.points),
        checkedInAt: r.checkedInAt,
        status: r.status,
        eligible,
        why,
      };
    })
    .sort(
      (a, b) =>
        a.points - b.points || (a.checkedInAt?.getTime() ?? 0) - (b.checkedInAt?.getTime() ?? 0),
    );
}

/** Calls the first eligible technician for a waiting visit, or says why nobody can be called. */
export async function callNext(
  db: Db,
  input: {
    visitId: string;
    actor: Actor;
    /** The caller's own location: a visit elsewhere is refused (threat model T10). */
    locationId: string;
  },
): Promise<{ ok: true; callId: string; technicianId: string } | EngineError> {
  return db.transaction(async (tx) => {
    const [visit] = await tx
      .select()
      .from(visits)
      .where(eq(visits.id, input.visitId))
      .for('update');
    if (!visit) return { ok: false, reason: 'unknown_visit' };
    if (visit.locationId !== input.locationId) {
      return { ok: false, reason: 'wrong_location' };
    }
    if (visit.status !== 'waiting') return { ok: false, reason: 'visit_not_waiting' };

    const queue = await queueFor(tx, visit.locationId);
    const pick = visit.requestedTechnicianId
      ? queue.find((c) => c.technicianId === visit.requestedTechnicianId && c.eligible)
      : queue.find((c) => c.eligible);
    if (!pick) {
      return {
        ok: false,
        reason: 'nobody_eligible',
        detail: queue.map((c) => `${c.displayName}: ${c.why}`).join('; '),
      };
    }
    // Hold the technician's status row while the call is written, so a break
    // or check-out that is being saved at the same second either lands first
    // (and this pick is refused) or waits and then sees the open call.
    const [held] = await tx
      .select({ status: technicianStatus.status })
      .from(technicianStatus)
      .where(eq(technicianStatus.technicianId, pick.technicianId))
      .for('update');
    if (held?.status !== 'available') {
      return {
        ok: false,
        reason: 'nobody_eligible',
        detail: `${pick.displayName}: ${held?.status ?? 'off'}`,
      };
    }
    // The partial unique indexes refuse a second open call for the technician
    // or the visit; a race loses cleanly here instead of double-booking (T3).
    const [call] = await tx
      .insert(turnCalls)
      .values({
        organizationId: visit.organizationId,
        locationId: visit.locationId,
        visitId: visit.id,
        technicianId: pick.technicianId,
        calledBy: input.actor.userId,
        queueSnapshot: queue,
      })
      .returning({ id: turnCalls.id });
    if (!call) throw new Error('call insert returned nothing');
    await tx
      .update(visits)
      .set({ status: 'called', updatedAt: new Date() })
      .where(eq(visits.id, visit.id));
    await writeAudit(tx, {
      organizationId: visit.organizationId,
      locationId: visit.locationId,
      actorUserId: input.actor.userId,
      entityType: 'turn_calls',
      entityId: call.id,
      action: 'call_sent',
      after: { visitId: visit.id, technicianId: pick.technicianId, queue },
    });
    return { ok: true, callId: call.id, technicianId: pick.technicianId };
  });
}

/** The called technician answers. Accept starts the service; deny posts the
 *  penalty from the rules and the visit goes back to waiting for the next call. */
export async function respondToCall(
  db: Db,
  input: {
    callId: string;
    technicianId: string;
    response: 'accepted' | 'denied';
    denyReason?: DenyReason;
    actor: Actor;
  },
): Promise<{ ok: true } | EngineError> {
  return db.transaction(async (tx) => {
    const [call] = await tx
      .select()
      .from(turnCalls)
      .where(eq(turnCalls.id, input.callId))
      .for('update');
    if (!call) return { ok: false, reason: 'unknown_call' };
    if (call.technicianId !== input.technicianId) return { ok: false, reason: 'not_your_call' };
    if (call.respondedAt) return { ok: false, reason: 'already_answered' };
    const now = new Date();

    if (input.response === 'accepted') {
      const moved = await transition(tx as unknown as Db, {
        technicianId: call.technicianId,
        to: 'in_service',
        actor: input.actor,
        now,
      });
      if (!moved.ok) return { ok: false, reason: 'cannot_start', detail: moved.reason };
      await tx
        .update(turnCalls)
        .set({ respondedAt: now, response: 'accepted' })
        .where(eq(turnCalls.id, call.id));
      await tx
        .update(visits)
        .set({
          status: 'in_service',
          assignedTechnicianId: call.technicianId,
          startedAt: now,
          updatedAt: now,
        })
        .where(eq(visits.id, call.visitId));
      await writeAudit(tx, {
        organizationId: call.organizationId,
        locationId: call.locationId,
        actorUserId: input.actor.userId,
        entityType: 'turn_calls',
        entityId: call.id,
        action: 'call_accepted',
        after: { visitId: call.visitId },
      });
      return { ok: true };
    }

    const reason = input.denyReason ?? 'other';
    if (!DENY_REASONS.includes(reason)) return { ok: false, reason: 'bad_deny_reason' };
    await tx
      .update(turnCalls)
      .set({ respondedAt: now, response: 'denied', denyReason: reason })
      .where(eq(turnCalls.id, call.id));
    await tx
      .update(visits)
      .set({ status: 'waiting', updatedAt: now })
      .where(eq(visits.id, call.visitId));
    const rules = await activeRules(tx, call.locationId);
    const [st] = await tx
      .select({ shiftId: technicianStatus.shiftId })
      .from(technicianStatus)
      .where(eq(technicianStatus.technicianId, call.technicianId));
    if (st?.shiftId) {
      await postPoints(tx, {
        organizationId: call.organizationId,
        locationId: call.locationId,
        technicianId: call.technicianId,
        shiftId: st.shiftId,
        delta: rules.penalties.deny,
        reasonType: 'deny',
        visitId: call.visitId,
        actorUserId: input.actor.userId,
        note: reason,
      });
    }
    await writeAudit(tx, {
      organizationId: call.organizationId,
      locationId: call.locationId,
      actorUserId: input.actor.userId,
      entityType: 'turn_calls',
      entityId: call.id,
      action: 'call_denied',
      after: { visitId: call.visitId, denyReason: reason },
      reason,
    });
    return { ok: true };
  });
}

/** The technician taps Finished: points post from the rules, the visit
 *  completes, the technician is available again. */
export async function finishVisit(
  db: Db,
  input: { technicianId: string; actor: Actor },
): Promise<{ ok: true; points: number } | EngineError> {
  return db.transaction(async (tx) => {
    const [visit] = await tx
      .select()
      .from(visits)
      .where(
        and(eq(visits.assignedTechnicianId, input.technicianId), eq(visits.status, 'in_service')),
      )
      .for('update');
    if (!visit) return { ok: false, reason: 'no_visit_in_service' };
    const items = await tx
      .select({
        isFillOrFullSet: serviceCategories.isFillOrFullSet,
        categoryId: serviceCategories.id,
      })
      .from(visitServices)
      .innerJoin(services, eq(services.id, visitServices.serviceId))
      .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
      .where(eq(visitServices.visitId, visit.id));
    const rules = await activeRules(tx, visit.locationId);
    const points = visitPointsUnder(rules, items, visit.source);
    const now = new Date();

    const moved = await transition(tx as unknown as Db, {
      technicianId: input.technicianId,
      to: 'available',
      actor: input.actor,
      reason: 'finished',
      now,
    });
    if (!moved.ok) return { ok: false, reason: 'cannot_finish', detail: moved.reason };
    const [st] = await tx
      .select({ shiftId: technicianStatus.shiftId })
      .from(technicianStatus)
      .where(eq(technicianStatus.technicianId, input.technicianId));
    if (st?.shiftId) {
      await postPoints(tx, {
        organizationId: visit.organizationId,
        locationId: visit.locationId,
        technicianId: input.technicianId,
        shiftId: st.shiftId,
        delta: points,
        reasonType: 'visit',
        visitId: visit.id,
        actorUserId: input.actor.userId,
      });
    }
    await tx
      .update(visits)
      .set({
        status: 'completed',
        completedAt: now,
        pointsPosted: points.toFixed(1),
        updatedAt: now,
      })
      .where(eq(visits.id, visit.id));
    await writeAudit(tx, {
      organizationId: visit.organizationId,
      locationId: visit.locationId,
      actorUserId: input.actor.userId,
      entityType: 'visits',
      entityId: visit.id,
      action: 'visit_completed',
      after: { points, technicianId: input.technicianId },
    });
    return { ok: true, points };
  });
}

/** A manager moves a visit to another technician (called wrong, appointment,
 *  client issue). The first technician's open call is marked overridden; a
 *  penalty is the manager's call (Duong, 2026-11-04), default none. */
export async function reassignVisit(
  db: Db,
  input: {
    visitId: string;
    toTechnicianId: string;
    actor: Actor;
    reason: string;
    penalizeFirst?: boolean;
  },
): Promise<{ ok: true; callId: string } | EngineError> {
  if (!input.reason.trim()) return { ok: false, reason: 'reason_required' };
  return db.transaction(async (tx) => {
    const [visit] = await tx
      .select()
      .from(visits)
      .where(eq(visits.id, input.visitId))
      .for('update');
    if (!visit) return { ok: false, reason: 'unknown_visit' };
    if (visit.status === 'completed' || visit.status === 'cancelled') {
      return { ok: false, reason: 'visit_closed' };
    }
    const now = new Date();
    const [open] = await tx
      .select()
      .from(turnCalls)
      .where(and(eq(turnCalls.visitId, visit.id), isNull(turnCalls.respondedAt)))
      .for('update');
    if (open) {
      await tx
        .update(turnCalls)
        .set({ respondedAt: now, response: 'overridden' })
        .where(eq(turnCalls.id, open.id));
      if (input.penalizeFirst) {
        const rules = await activeRules(tx, visit.locationId);
        const [st] = await tx
          .select({ shiftId: technicianStatus.shiftId })
          .from(technicianStatus)
          .where(eq(technicianStatus.technicianId, open.technicianId));
        if (st?.shiftId) {
          await postPoints(tx, {
            organizationId: visit.organizationId,
            locationId: visit.locationId,
            technicianId: open.technicianId,
            shiftId: st.shiftId,
            delta: rules.penalties.deny,
            reasonType: 'manual',
            visitId: visit.id,
            actorUserId: input.actor.userId,
            note: `reassigned: ${input.reason}`,
          });
        }
      }
    }
    if (visit.status === 'in_service' && visit.assignedTechnicianId) {
      const back = await transition(tx as unknown as Db, {
        technicianId: visit.assignedTechnicianId,
        to: 'available',
        actor: input.actor,
        reason: `reassigned: ${input.reason}`,
        now,
      });
      if (!back.ok) return { ok: false, reason: 'cannot_release', detail: back.reason };
    }
    const queue = await queueFor(tx, visit.locationId);
    const target = queue.find((c) => c.technicianId === input.toTechnicianId);
    if (!target || !target.eligible) {
      return { ok: false, reason: 'target_not_eligible', detail: target?.why };
    }
    const [call] = await tx
      .insert(turnCalls)
      .values({
        organizationId: visit.organizationId,
        locationId: visit.locationId,
        visitId: visit.id,
        technicianId: input.toTechnicianId,
        calledBy: input.actor.userId,
        queueSnapshot: queue,
      })
      .returning({ id: turnCalls.id });
    if (!call) throw new Error('call insert returned nothing');
    await tx
      .update(visits)
      .set({ status: 'called', assignedTechnicianId: null, startedAt: null, updatedAt: now })
      .where(eq(visits.id, visit.id));
    await writeAudit(tx, {
      organizationId: visit.organizationId,
      locationId: visit.locationId,
      actorUserId: input.actor.userId,
      entityType: 'visits',
      entityId: visit.id,
      action: 'visit_reassigned',
      before: { technicianId: open?.technicianId ?? visit.assignedTechnicianId },
      after: { technicianId: input.toTechnicianId, penalizeFirst: !!input.penalizeFirst },
      reason: input.reason,
    });
    return { ok: true, callId: call.id };
  });
}

/** What the technician's phone needs: their open call with its services. */
export async function openCallFor(db: Db, technicianId: string) {
  const [call] = await db
    .select({
      callId: turnCalls.id,
      visitId: turnCalls.visitId,
      calledAt: turnCalls.calledAt,
      source: visits.source,
    })
    .from(turnCalls)
    .innerJoin(visits, eq(visits.id, turnCalls.visitId))
    .where(and(eq(turnCalls.technicianId, technicianId), isNull(turnCalls.respondedAt)))
    .orderBy(asc(turnCalls.calledAt))
    .limit(1);
  if (!call) return null;
  const items = await db
    .select({ name: services.name })
    .from(visitServices)
    .innerJoin(services, eq(services.id, visitServices.serviceId))
    .where(eq(visitServices.visitId, call.visitId));
  return { ...call, services: items.map((i) => i.name) };
}

/** The front desk's view: waiting, called and in-service visits with their services. */
export async function waitingVisits(db: Db, locationId: string) {
  const rows = await db
    .select({
      id: visits.id,
      status: visits.status,
      source: visits.source,
      arrivedAt: visits.arrivedAt,
      note: visits.note,
      calledTechnician: technicians.displayName,
      calledAt: turnCalls.calledAt,
      requestedTechnician: sql<
        string | null
      >`(select t2.display_name from ${technicians} t2 where t2.id = ${visits.requestedTechnicianId})`,
    })
    .from(visits)
    .leftJoin(turnCalls, and(eq(turnCalls.visitId, visits.id), isNull(turnCalls.respondedAt)))
    .leftJoin(technicians, eq(technicians.id, turnCalls.technicianId))
    .where(
      and(
        eq(visits.locationId, locationId),
        inArray(visits.status, ['waiting', 'called', 'in_service']),
      ),
    )
    .orderBy(asc(visits.arrivedAt));
  const ids = rows.map((r) => r.id);
  const items = ids.length
    ? await db
        .select({ visitId: visitServices.visitId, name: services.name })
        .from(visitServices)
        .innerJoin(services, eq(services.id, visitServices.serviceId))
        .where(inArray(visitServices.visitId, ids))
    : [];
  return rows.map((r) => ({
    ...r,
    services: items.filter((i) => i.visitId === r.id).map((i) => i.name),
  }));
}

// Attention (Duong, 2026-11-04) ------------------------------------------------

/**
 * Minutes a new customer would wait, from a queue simulation: free
 * technicians take the waiting visits in order, each visit lasts its
 * services' minutes, a busy technician frees up at their expected end.
 * null when nobody can take a visit at all. Pure.
 */
export function estimateWait(input: {
  now: Date;
  /** Technicians free right now. */
  available: number;
  /** Expected end of each service in progress (or call being answered). */
  inService: Date[];
  /** Minutes each waiting visit will take, in arrival order. */
  waiting: number[];
}): number | null {
  const free: number[] = [];
  for (let i = 0; i < input.available; i++) free.push(0);
  for (const end of input.inService) {
    free.push(Math.max(0, Math.ceil((end.getTime() - input.now.getTime()) / 60_000)));
  }
  if (free.length === 0) return null;
  for (const minutes of input.waiting) {
    free.sort((x, y) => x - y);
    free[0] = free[0]! + minutes;
  }
  return Math.min(...free);
}

export type FloorAttention = {
  /** Calls open longer than the rules allow: the desk and the manager step in. */
  unansweredCalls: {
    callId: string;
    visitId: string;
    technicianId: string;
    technicianName: string;
    waitedMin: number;
  }[];
  unansweredCallMin: number;
  /** Minutes a new customer would wait; null when nobody is on the floor. */
  estimatedWaitMin: number | null;
  longWait: boolean;
  longWaitMin: number;
  /** The desk's switch for the customer notice (kiosk, Part 9). */
  noticeEnabled: boolean;
};

/** What needs a person right now, and how long the line is. Read only. */
export async function floorAttention(
  db: Db,
  locationId: string,
  now = new Date(),
): Promise<FloorAttention> {
  const rules = await activeRules(db, locationId);
  const fallbackMin = rules.attention.default_service_min;

  const [loc] = await db
    .select({ longWaitNotice: locations.longWaitNotice })
    .from(locations)
    .where(eq(locations.id, locationId));

  const open = await db
    .select({
      callId: turnCalls.id,
      visitId: turnCalls.visitId,
      technicianId: turnCalls.technicianId,
      technicianName: technicians.displayName,
      calledAt: turnCalls.calledAt,
    })
    .from(turnCalls)
    .innerJoin(technicians, eq(technicians.id, turnCalls.technicianId))
    .where(and(eq(turnCalls.locationId, locationId), isNull(turnCalls.respondedAt)));
  const unansweredCalls = open
    .map((c) => ({
      callId: c.callId,
      visitId: c.visitId,
      technicianId: c.technicianId,
      technicianName: c.technicianName,
      waitedMin: Math.floor((now.getTime() - c.calledAt.getTime()) / 60_000),
    }))
    .filter((c) => c.waitedMin >= rules.attention.unanswered_call_min);

  // Minutes per open visit, from its services.
  const openVisits = await db
    .select({
      id: visits.id,
      status: visits.status,
      arrivedAt: visits.arrivedAt,
      startedAt: visits.startedAt,
      minutes: sql<string>`coalesce((
        select sum(coalesce(s.default_duration_min, ${fallbackMin}))
        from ${visitServices} vs join ${services} s on s.id = vs.service_id
        where vs.visit_id = visits.id), ${fallbackMin})`,
    })
    .from(visits)
    .where(
      and(
        eq(visits.locationId, locationId),
        inArray(visits.status, ['waiting', 'called', 'in_service']),
      ),
    )
    .orderBy(asc(visits.arrivedAt));

  const statuses = await db
    .select({ technicianId: technicianStatus.technicianId, status: technicianStatus.status })
    .from(technicianStatus)
    .innerJoin(technicians, eq(technicians.id, technicianStatus.technicianId))
    .where(and(eq(technicians.locationId, locationId), eq(technicians.active, true)));
  const calledIds = new Set(open.map((c) => c.technicianId));
  const available = statuses.filter(
    (t) => t.status === 'available' && !calledIds.has(t.technicianId),
  ).length;

  const inService: Date[] = [];
  const waiting: number[] = [];
  for (const v of openVisits) {
    const minutes = Number(v.minutes);
    if (v.status === 'in_service' && v.startedAt) {
      inService.push(new Date(v.startedAt.getTime() + minutes * 60_000));
    } else if (v.status === 'called') {
      // Being answered: counts as about to start.
      inService.push(new Date(now.getTime() + minutes * 60_000));
    } else {
      waiting.push(minutes);
    }
  }
  const estimatedWaitMin = estimateWait({ now, available, inService, waiting });

  return {
    unansweredCalls,
    unansweredCallMin: rules.attention.unanswered_call_min,
    estimatedWaitMin,
    longWait:
      estimatedWaitMin === null
        ? waiting.length > 0
        : estimatedWaitMin >= rules.attention.long_wait_min,
    longWaitMin: rules.attention.long_wait_min,
    noticeEnabled: loc?.longWaitNotice ?? false,
  };
}

/**
 * The desk clears a call nobody answered: the call closes as expired, no
 * penalty (the technician may have lost their phone, not their nerve), and
 * the visit waits again so "Call next" can go to whoever is next. A manager
 * who wants the penalty uses reassign with penalizeFirst.
 */
export async function expireCall(
  db: Db,
  input: {
    callId: string;
    actor: Actor;
    /** The caller's own location: a call elsewhere is refused (threat model T10). */
    locationId: string;
  },
): Promise<{ ok: true; visitId: string } | EngineError> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ visitId: turnCalls.visitId, locationId: turnCalls.locationId })
      .from(turnCalls)
      .where(eq(turnCalls.id, input.callId));
    if (!found) return { ok: false, reason: 'unknown_call' };
    if (found.locationId !== input.locationId) {
      return { ok: false, reason: 'wrong_location' };
    }
    // Same lock order as reassignVisit (visit, then call), so the desk
    // clearing and a manager reassigning the same call cannot deadlock.
    await tx.select().from(visits).where(eq(visits.id, found.visitId)).for('update');
    const [call] = await tx
      .select()
      .from(turnCalls)
      .where(eq(turnCalls.id, input.callId))
      .for('update');
    if (!call) return { ok: false, reason: 'unknown_call' };
    if (call.respondedAt) return { ok: false, reason: 'already_answered' };
    const rules = await activeRules(tx, call.locationId);
    const now = new Date();
    const waitedMin = (now.getTime() - call.calledAt.getTime()) / 60_000;
    if (waitedMin < rules.attention.unanswered_call_min) {
      return { ok: false, reason: 'too_soon', detail: String(rules.attention.unanswered_call_min) };
    }
    await tx
      .update(turnCalls)
      .set({ respondedAt: now, response: 'expired' })
      .where(eq(turnCalls.id, call.id));
    await tx
      .update(visits)
      .set({ status: 'waiting', updatedAt: now })
      .where(eq(visits.id, call.visitId));
    await writeAudit(tx, {
      organizationId: call.organizationId,
      locationId: call.locationId,
      actorUserId: input.actor.userId,
      entityType: 'turn_calls',
      entityId: call.id,
      action: 'call_expired',
      after: {
        visitId: call.visitId,
        technicianId: call.technicianId,
        waitedMin: Math.floor(waitedMin),
      },
    });
    return { ok: true, visitId: call.visitId };
  });
}

/** The desk's switch for the customer notice. Audited like every setting. */
export async function setLongWaitNotice(
  db: Db,
  input: { organizationId: string; locationId: string; enabled: boolean; actor: Actor },
): Promise<void> {
  await db.transaction(async (tx) => {
    // No explicit lock: FOR UPDATE on a location would make every insert that
    // references it (visits, calls, audit rows) wait until this commits.
    const [before] = await tx
      .select({ longWaitNotice: locations.longWaitNotice })
      .from(locations)
      .where(eq(locations.id, input.locationId));
    await tx
      .update(locations)
      .set({ longWaitNotice: input.enabled, updatedAt: new Date() })
      .where(eq(locations.id, input.locationId));
    await writeAudit(tx, {
      organizationId: input.organizationId,
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      entityType: 'locations',
      entityId: input.locationId,
      action: 'long_wait_notice',
      before: { enabled: before?.longWaitNotice ?? null },
      after: { enabled: input.enabled },
    });
  });
}

/** Today's counts for the admin sentence, on the location's own calendar day. */
export async function todayCounts(
  db: Db,
  locationId: string,
): Promise<{ visits: number; denies: number; overrides: number }> {
  const [loc] = await db
    .select({ timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, locationId));
  const tz = loc?.timezone ?? 'UTC';
  // A range on the column, not a function of it, so the (location_id, at)
  // indexes are used: from local midnight to the next local midnight.
  const today = (col: unknown) =>
    sql`${col} >= (date_trunc('day', now() at time zone ${tz}) at time zone ${tz})
        and ${col} < ((date_trunc('day', now() at time zone ${tz}) + interval '1 day') at time zone ${tz})`;
  const [v] = await db
    .select({ n: sql<string>`count(*)` })
    .from(visits)
    .where(and(eq(visits.locationId, locationId), today(visits.arrivedAt)));
  const [d] = await db
    .select({ n: sql<string>`count(*)` })
    .from(turnCalls)
    .where(
      and(
        eq(turnCalls.locationId, locationId),
        eq(turnCalls.response, 'denied'),
        today(turnCalls.respondedAt),
      ),
    );
  const [o] = await db
    .select({ n: sql<string>`count(*)` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.locationId, locationId),
        inArray(auditLog.action, ['visit_reassigned', 'deny_excused', 'points_adjusted']),
        today(auditLog.at),
      ),
    );
  return { visits: Number(v?.n ?? 0), denies: Number(d?.n ?? 0), overrides: Number(o?.n ?? 0) };
}

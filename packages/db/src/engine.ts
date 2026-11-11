// The turn engine (design doc, Rule engine and Call flow). Server only. App
// code decides, the database enforces: one open call per technician and per
// visit (partial unique indexes), and every move writes the audit log.
// Every number comes from rule_config (rules.ts); nothing here is hard-coded.
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { upsertClient, type ClientGender, type ClientInput } from './clients';
import { doesEverything, loadProfiles, restrictionOf, type TechnicianProfile } from './profile';
import { activeRules, visitPointsUnder, type RuleConfig } from './rules';
import {
  appointments,
  auditLog,
  clients,
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

/** A manager or owner acting at their own location (threat model T10). */
export type ManagerActor = { userId: string | null; organizationId: string; locationId: string };

export const DENY_REASONS = [
  'not_my_service',
  'with_another_client',
  'break_needed',
  'client_issue',
  'other',
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

export type { RuleConfig };

export type EngineError = {
  ok: false;
  reason: string;
  detail?: string;
  /** For nobody_eligible: every technician on shift and why they were passed over. */
  skipped?: Skipped[];
};

/** What the desk asked about the client, for the restrictions (design doc, Call flow). */
export type ClientAttributes = {
  /** null = not asked. */
  gender?: ClientGender | null;
  isKid?: boolean | null;
  /** Approximate age, when asked (min_client_age). */
  age?: number | null;
};

/**
 * A receptionist enters a walk-in: the services, and what the restrictions
 * need to know about the client (Duong, 2026-11-04). "Same time" with two or
 * more services opens one linked visit per service, so two technicians are
 * called (design doc, Same-time services).
 */
export async function createWalkIn(
  db: Db,
  input: {
    organizationId: string;
    locationId: string;
    serviceIds: string[];
    actor: Actor;
    source?: 'walk_in' | 'appointment' | 'request' | 'self_checkin';
    requestedTechnicianId?: string | null;
    /** Free text from the desk: special requests the engine does not model. */
    note?: string | null;
    /** Name and phone, when the desk took them (optional; phone is the Fresha key). */
    client?: ClientInput | null;
    attributes?: ClientAttributes | null;
    sameTime?: boolean;
  },
): Promise<{ ok: true; visitId: string; visitIds: string[] } | EngineError> {
  if (input.serviceIds.length === 0) return { ok: false, reason: 'no_services' };
  const age = input.attributes?.age ?? null;
  if (age !== null && (!Number.isInteger(age) || age < 0 || age > 120)) {
    return { ok: false, reason: 'bad_age' };
  }
  const sameTime = !!input.sameTime && new Set(input.serviceIds).size >= 2;
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
    if (input.requestedTechnicianId) {
      const [t] = await tx
        .select({ id: technicians.id })
        .from(technicians)
        .where(
          and(
            eq(technicians.id, input.requestedTechnicianId),
            eq(technicians.locationId, input.locationId),
            eq(technicians.active, true),
          ),
        );
      if (!t) return { ok: false, reason: 'unknown_technician' };
    }
    const gender = input.attributes?.gender ?? input.client?.gender ?? null;
    const client = await upsertClient(tx, {
      organizationId: input.organizationId,
      locationId: input.locationId,
      name: input.client?.name ?? null,
      phone: input.client?.phone ?? null,
      gender,
    });
    if (!client.ok) return { ok: false, reason: client.reason };

    const rules = await activeRules(tx, input.locationId);
    const source = input.source ?? 'walk_in';
    const groupId = sameTime ? randomUUID() : null;
    const groups = sameTime ? rows.map((s) => [s]) : [rows];
    const visitIds: string[] = [];
    for (const group of groups) {
      const [visit] = await tx
        .insert(visits)
        .values({
          organizationId: input.organizationId,
          locationId: input.locationId,
          // A same-time pair: the request goes with the first visit; the
          // second one needs a second technician.
          source: input.requestedTechnicianId && visitIds.length === 0 ? 'request' : source,
          requestedTechnicianId:
            visitIds.length === 0 ? (input.requestedTechnicianId ?? null) : null,
          note: input.note?.trim().slice(0, 300) || null,
          createdBy: input.actor.userId,
          clientId: client.clientId,
          clientGender: gender,
          clientIsKid: input.attributes?.isKid ?? null,
          clientAge: age,
          groupId,
        })
        .returning({ id: visits.id });
      if (!visit) throw new Error('visit insert returned nothing');
      await tx.insert(visitServices).values(
        group.map((s) => ({
          organizationId: input.organizationId,
          visitId: visit.id,
          serviceId: s.id,
          pointsValueSnapshot: visitPointsUnder(rules, [s], 'walk_in').toFixed(1),
        })),
      );
      // The attributes the engine used, never the name or phone (T11).
      await writeAudit(tx, {
        organizationId: input.organizationId,
        locationId: input.locationId,
        actorUserId: input.actor.userId,
        entityType: 'visits',
        entityId: visit.id,
        action: 'visit_created',
        after: {
          source,
          serviceIds: group.map((s) => s.id),
          gender,
          isKid: input.attributes?.isKid ?? null,
          age,
          groupId,
          hasClient: client.clientId !== null,
        },
      });
      visitIds.push(visit.id);
    }
    return { ok: true, visitId: visitIds[0]!, visitIds };
  });
}

/** Why a technician was skipped, one reason per technician (the first that applied). */
export type SkipReason =
  | 'available'
  | 'checked_in'
  | 'in_service'
  | 'break'
  | 'out'
  | 'already_called'
  | 'busy'
  | 'no_skill'
  | 'no_male_clients'
  | 'no_kids'
  | 'min_client_age'
  | 'no_same_time'
  | 'appointment_soon';

/** Reasons a manager may override with reassign (force); status reasons never. */
export const SOFT_SKIPS: readonly SkipReason[] = [
  'no_skill',
  'no_male_clients',
  'no_kids',
  'min_client_age',
  'no_same_time',
  'appointment_soon',
];

export type Candidate = {
  technicianId: string;
  displayName: string;
  points: number;
  checkedInAt: Date | null;
  status: string;
  eligible: boolean;
  why: SkipReason;
  /** For no_skill: the category names missing. For appointment_soon: minutes until it. */
  detail?: string;
  /** A custom restriction's text: shown to the desk, never applied by the engine. */
  note?: string;
  /** With skill_match "preferred": does the technician have every skill? */
  skilled: boolean;
};

/** What the engine needs to know about the visit being called. */
export type VisitContext = {
  categoryIds: string[];
  gender: ClientGender | null;
  isKid: boolean | null;
  age: number | null;
  sameTime: boolean;
};

const NO_CONTEXT: VisitContext = {
  categoryIds: [],
  gender: null,
  isKid: null,
  age: null,
  sameTime: false,
};

/** The restriction that stops this technician from taking this visit, if any. Pure. */
export function restrictionBlocking(
  profile: Pick<TechnicianProfile, 'restrictions'>,
  ctx: VisitContext,
): SkipReason | null {
  if (restrictionOf(profile, 'no_male_clients') && ctx.gender === 'male') return 'no_male_clients';
  if (restrictionOf(profile, 'no_kids') && ctx.isKid === true) return 'no_kids';
  const minAge = restrictionOf(profile, 'min_client_age');
  if (minAge?.value != null) {
    // A kid of unknown age is treated as under the limit: the safe reading.
    if (ctx.age !== null ? ctx.age < minAge.value : ctx.isKid === true) return 'min_client_age';
  }
  if (restrictionOf(profile, 'no_same_time') && ctx.sameTime) return 'no_same_time';
  return null;
}

/**
 * Everyone on shift, in queue order, with why each one can or cannot be
 * called for this visit (design doc, Eligibility filters). Status first, then
 * the double-booking guard, skills, restrictions and the appointment buffer.
 */
export async function queueFor(
  tx: Tx,
  locationId: string,
  ctx: VisitContext = NO_CONTEXT,
  now = new Date(),
): Promise<Candidate[]> {
  const rules = await activeRules(tx, locationId);
  const bufferEnd = new Date(
    now.getTime() + rules.eligibility.upcoming_appointment_buffer_min * 60_000,
  );
  const [rows, profiles, categories, upcoming] = await Promise.all([
    tx
      .select({
        technicianId: technicians.id,
        displayName: technicians.displayName,
        status: technicianStatus.status,
        checkedInAt: shifts.checkedInAt,
        points: sql<string>`coalesce((select sum(${turnLedger.delta}) from ${turnLedger} where ${turnLedger.shiftId} = ${technicianStatus.shiftId}), 0)`,
        openCall: sql<number>`(select count(*) from ${turnCalls} c where c.technician_id = ${technicians.id} and c.responded_at is null)`,
        // The double-booking guard: a visit already in progress on this technician.
        openVisit: sql<number>`(select count(*) from ${visits} v where v.assigned_technician_id = ${technicians.id} and v.status in ('called', 'in_service'))`,
      })
      .from(technicians)
      .innerJoin(technicianStatus, eq(technicianStatus.technicianId, technicians.id))
      .leftJoin(shifts, eq(shifts.id, technicianStatus.shiftId))
      .where(and(eq(technicians.locationId, locationId), eq(technicians.active, true))),
    loadProfiles(tx, locationId),
    ctx.categoryIds.length
      ? tx
          .select({ id: serviceCategories.id, name: serviceCategories.name })
          .from(serviceCategories)
          .where(inArray(serviceCategories.id, ctx.categoryIds))
      : Promise.resolve([] as { id: string; name: string }[]),
    tx
      .select({ technicianId: appointments.technicianId, startAt: appointments.startAt })
      .from(appointments)
      .where(
        and(
          eq(appointments.locationId, locationId),
          isNull(appointments.cancelledAt),
          gt(appointments.endAt, now),
          lt(appointments.startAt, bufferEnd),
        ),
      )
      .orderBy(asc(appointments.startAt)),
  ]);
  const nextAppointment = new Map<string, Date>();
  for (const a of upcoming) {
    if (!nextAppointment.has(a.technicianId)) nextAppointment.set(a.technicianId, a.startAt);
  }
  const needed = [...new Set(ctx.categoryIds)];
  const nameOf = new Map(categories.map((c) => [c.id, c.name]));

  return rows
    .filter((r) => r.status !== 'off')
    .map((r): Candidate => {
      const profile = profiles.get(r.technicianId);
      const skills = profile ? new Set(profile.skillCategoryIds) : null;
      const missing =
        !profile || doesEverything(profile) ? [] : needed.filter((c) => !skills!.has(c));
      const skilled = missing.length === 0;
      const custom = profile ? (restrictionOf(profile, 'custom')?.note ?? undefined) : undefined;
      const base = {
        technicianId: r.technicianId,
        displayName: r.displayName,
        points: Number(r.points),
        checkedInAt: r.checkedInAt,
        status: r.status,
        skilled,
        ...(custom ? { note: custom } : {}),
      };
      const skip = (why: SkipReason, detail?: string): Candidate => ({
        ...base,
        eligible: false,
        why,
        ...(detail ? { detail } : {}),
      });
      if (r.status !== 'available') return skip(r.status as SkipReason);
      if (Number(r.openCall) > 0) return skip('already_called');
      if (Number(r.openVisit) > 0) return skip('busy');
      if (!skilled && rules.eligibility.skill_match === 'required') {
        return skip('no_skill', missing.map((c) => nameOf.get(c) ?? c).join(', '));
      }
      if (profile && rules.eligibility.honor_restrictions) {
        const blocked = restrictionBlocking(profile, ctx);
        if (blocked) return skip(blocked);
      }
      const appointment = nextAppointment.get(r.technicianId);
      if (appointment) {
        const minutes = Math.max(0, Math.ceil((appointment.getTime() - now.getTime()) / 60_000));
        return skip('appointment_soon', String(minutes));
      }
      return { ...base, eligible: true, why: 'available' };
    })
    .sort((a, b) => {
      // "preferred": a technician with the skills goes ahead of one without, at any points.
      if (rules.eligibility.skill_match === 'preferred' && a.skilled !== b.skilled) {
        return a.skilled ? -1 : 1;
      }
      return (
        a.points - b.points || (a.checkedInAt?.getTime() ?? 0) - (b.checkedInAt?.getTime() ?? 0)
      );
    });
}

/** The engine's view of a visit: its categories and the client attributes. */
async function contextOf(tx: Tx, visit: typeof visits.$inferSelect): Promise<VisitContext> {
  const items = await tx
    .select({ categoryId: services.categoryId })
    .from(visitServices)
    .innerJoin(services, eq(services.id, visitServices.serviceId))
    .where(eq(visitServices.visitId, visit.id));
  return {
    categoryIds: items.map((i) => i.categoryId),
    gender: visit.clientGender,
    isKid: visit.clientIsKid,
    age: visit.clientAge,
    sameTime: visit.groupId !== null,
  };
}

export type Skipped = {
  technicianId: string;
  displayName: string;
  why: SkipReason;
  detail?: string;
  /** The technician's free-text restriction, for the desk to read. */
  note?: string;
};

function skippedOf(queue: Candidate[]): Skipped[] {
  return queue
    .filter((c) => !c.eligible)
    .map((c) => ({
      technicianId: c.technicianId,
      displayName: c.displayName,
      why: c.why,
      ...(c.detail ? { detail: c.detail } : {}),
      ...(c.note ? { note: c.note } : {}),
    }));
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
): Promise<{ ok: true; callId: string; technicianId: string; skipped: Skipped[] } | EngineError> {
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

    const rules = await activeRules(tx, visit.locationId);
    const queue = await queueFor(tx, visit.locationId, await contextOf(tx, visit));
    // With the bypass rule on, a requested technician is the only pick: when
    // they cannot take it, the visit waits for them and the desk sees why. With
    // the rule off, the request is a note and the line decides.
    const pick =
      visit.requestedTechnicianId && rules.requests.requested_tech_bypasses_queue
        ? queue.find((c) => c.technicianId === visit.requestedTechnicianId && c.eligible)
        : queue.find((c) => c.eligible);
    if (!pick) {
      return {
        ok: false,
        reason: 'nobody_eligible',
        detail: queue.map((c) => `${c.displayName}: ${c.why}`).join('; '),
        skipped: skippedOf(queue),
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
    return {
      ok: true,
      callId: call.id,
      technicianId: pick.technicianId,
      // Who was ahead of the pick and why they were passed over.
      skipped: skippedOf(queue.slice(0, queue.indexOf(pick))),
    };
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

/**
 * A manager moves a visit to another technician (called wrong, appointment,
 * client issue). The first technician's open call is marked overridden; a
 * penalty is the manager's call (Duong, 2026-11-04), default none. With
 * `force` the manager overrides skills, restrictions and the appointment
 * buffer for the target; never their status (a technician on break stays on
 * break). The visit must be at the manager's own location (threat model T10).
 */
export async function reassignVisit(
  db: Db,
  input: {
    visitId: string;
    toTechnicianId: string;
    actor: ManagerActor;
    reason: string;
    penalizeFirst?: boolean;
    force?: boolean;
  },
): Promise<{ ok: true; callId: string } | EngineError> {
  const reason = input.reason.trim().slice(0, 300);
  if (!reason) return { ok: false, reason: 'reason_required' };
  return db.transaction(async (tx) => {
    const [visit] = await tx
      .select()
      .from(visits)
      .where(eq(visits.id, input.visitId))
      .for('update');
    if (!visit) return { ok: false, reason: 'unknown_visit' };
    if (
      visit.locationId !== input.actor.locationId ||
      visit.organizationId !== input.actor.organizationId
    ) {
      return { ok: false, reason: 'wrong_location' };
    }
    if (visit.status === 'completed' || visit.status === 'cancelled') {
      return { ok: false, reason: 'visit_closed' };
    }
    const now = new Date();
    // Decide first, write after: a refusal must leave the visit, its open
    // call and the first technician exactly as they were (a returned error
    // does not roll the transaction back).
    const queue = await queueFor(tx, visit.locationId, await contextOf(tx, visit), now);
    const target = queue.find((c) => c.technicianId === input.toTechnicianId);
    const forced = !!target && !target.eligible && !!input.force && SOFT_SKIPS.includes(target.why);
    if (!target || (!target.eligible && !forced)) {
      // No target at all: the technician is not on shift (or not at this location).
      return {
        ok: false,
        reason: 'target_not_eligible',
        detail: target?.why ?? 'off',
        skipped: target ? skippedOf([target]) : [],
      };
    }
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
            reasonType: 'deny',
            visitId: visit.id,
            actorUserId: input.actor.userId,
            // The manager's words go to the audit log only (the ledger is floor-readable).
            note: 'reassigned',
          });
        }
      }
    }
    if (visit.status === 'in_service' && visit.assignedTechnicianId) {
      const back = await transition(tx as unknown as Db, {
        technicianId: visit.assignedTechnicianId,
        to: 'available',
        actor: input.actor,
        reason: `reassigned: ${reason}`,
        now,
      });
      if (!back.ok) return { ok: false, reason: 'cannot_release', detail: back.reason };
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
      after: {
        technicianId: input.toTechnicianId,
        penalizeFirst: !!input.penalizeFirst,
        // When forced: the eligibility reason the manager overrode.
        forced: forced ? target.why : null,
      },
      reason,
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
      assignedTechnician: sql<
        string | null
      >`(select t3.display_name from ${technicians} t3 where t3.id = ${visits.assignedTechnicianId})`,
      clientGender: visits.clientGender,
      clientIsKid: visits.clientIsKid,
      clientAge: visits.clientAge,
      groupId: visits.groupId,
      clientName: clients.name,
    })
    .from(visits)
    .leftJoin(turnCalls, and(eq(turnCalls.visitId, visits.id), isNull(turnCalls.respondedAt)))
    .leftJoin(technicians, eq(technicians.id, turnCalls.technicianId))
    .leftJoin(clients, eq(clients.id, visits.clientId))
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
  /** Technicians on break or out, how long, and whether the out timer has run over. */
  timers: {
    technicianId: string;
    technicianName: string;
    status: 'break' | 'out';
    minutes: number;
    /** Out longer than the rules allow: the penalty is posted (sweepFloor). */
    over: boolean;
  }[];
  outOverMin: number;
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
    .select({
      technicianId: technicianStatus.technicianId,
      technicianName: technicians.displayName,
      status: technicianStatus.status,
      since: technicianStatus.since,
    })
    .from(technicianStatus)
    .innerJoin(technicians, eq(technicians.id, technicianStatus.technicianId))
    .where(and(eq(technicians.locationId, locationId), eq(technicians.active, true)));
  const timers = statuses
    .filter((t) => t.status === 'break' || t.status === 'out')
    .map((t) => {
      const minutes = Math.floor((now.getTime() - t.since.getTime()) / 60_000);
      return {
        technicianId: t.technicianId,
        technicianName: t.technicianName,
        status: t.status as 'break' | 'out',
        minutes,
        over: t.status === 'out' && minutes >= rules.penalties.out_over_minutes,
      };
    })
    .sort((a, b) => b.minutes - a.minutes);
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
    timers,
    outOverMin: rules.penalties.out_over_minutes,
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
        inArray(auditLog.action, [
          'visit_reassigned',
          'deny_excused',
          'penalty_excused',
          'points_adjusted',
        ]),
        today(auditLog.at),
      ),
    );
  return { visits: Number(v?.n ?? 0), denies: Number(d?.n ?? 0), overrides: Number(o?.n ?? 0) };
}

// Manager overrides (Part 6) --------------------------------------------------

export type PenaltyRow = {
  ledgerId: string;
  technicianId: string;
  technicianName: string;
  delta: number;
  reasonType: 'deny' | 'out_over' | 'late';
  note: string | null;
  visitId: string | null;
  at: Date;
  /** Already reversed by an excuse row. */
  excused: boolean;
};

/** Today's penalties at a location (deny, out over, late), newest first, with
 *  whether each one was excused. For the manager's screen. */
export async function todayPenalties(db: Db, locationId: string): Promise<PenaltyRow[]> {
  const rows = await db
    .select({
      ledgerId: turnLedger.id,
      technicianId: turnLedger.technicianId,
      technicianName: technicians.displayName,
      delta: turnLedger.delta,
      reasonType: turnLedger.reasonType,
      note: turnLedger.note,
      visitId: turnLedger.visitId,
      at: turnLedger.createdAt,
      excused: sql<number>`(select count(*) from ${turnLedger} e where e.reverses_id = ${turnLedger.id})`,
    })
    .from(turnLedger)
    .innerJoin(technicians, eq(technicians.id, turnLedger.technicianId))
    .innerJoin(shifts, eq(shifts.id, turnLedger.shiftId))
    .where(
      and(
        eq(turnLedger.locationId, locationId),
        inArray(turnLedger.reasonType, ['deny', 'out_over', 'late']),
        // The location's own calendar day, whether or not the technician has checked out since.
        sql`${shifts.date} = (now() at time zone (select l.timezone from ${locations} l where l.id = ${locationId}))::date`,
      ),
    )
    .orderBy(desc(turnLedger.createdAt));
  return rows.map((r) => ({
    ...r,
    delta: Number(r.delta),
    reasonType: r.reasonType as PenaltyRow['reasonType'],
    excused: Number(r.excused) > 0,
  }));
}

/**
 * A manager excuses a penalty (a deny, an out over the limit, a late start):
 * a reversing ledger row is posted and the audit log says who and why. A
 * penalty is excused once; a deny also marks its call as excused. The row
 * must be at the manager's own location (threat model T10).
 */
export async function excusePenalty(
  db: Db,
  input: { ledgerId: string; actor: ManagerActor; reason: string },
): Promise<{ ok: true } | EngineError> {
  const reason = input.reason.trim().slice(0, 300);
  if (!reason) return { ok: false, reason: 'reason_required' };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(turnLedger)
      .where(eq(turnLedger.id, input.ledgerId))
      .for('update');
    if (!row) return { ok: false, reason: 'unknown_penalty' };
    if (
      row.locationId !== input.actor.locationId ||
      row.organizationId !== input.actor.organizationId
    ) {
      return { ok: false, reason: 'wrong_location' };
    }
    if (row.reasonType !== 'deny' && row.reasonType !== 'out_over' && row.reasonType !== 'late') {
      return { ok: false, reason: 'not_a_penalty' };
    }
    const [already] = await tx
      .select({ id: turnLedger.id })
      .from(turnLedger)
      .where(eq(turnLedger.reversesId, row.id));
    if (already) return { ok: false, reason: 'already_excused' };
    // Today's penalties only (the screen's promise), and never one's own.
    const [who] = await tx
      .select({
        isToday: sql<boolean>`${shifts.date} = (now() at time zone (select l.timezone from ${locations} l where l.id = ${row.locationId}))::date`,
        userId: technicians.userId,
      })
      .from(shifts)
      .innerJoin(technicians, eq(technicians.id, shifts.technicianId))
      .where(eq(shifts.id, row.shiftId));
    if (!who?.isToday) return { ok: false, reason: 'not_today' };
    if (input.actor.userId && who.userId === input.actor.userId) {
      return { ok: false, reason: 'own_points' };
    }

    const now = new Date();
    const [excuse] = await tx
      .insert(turnLedger)
      .values({
        organizationId: row.organizationId,
        locationId: row.locationId,
        technicianId: row.technicianId,
        shiftId: row.shiftId,
        delta: (-Number(row.delta)).toFixed(1),
        reasonType: 'excuse',
        visitId: row.visitId,
        actorUserId: input.actor.userId,
        // The manager's words go to the audit log only (the ledger is floor-readable).
        note: 'excused',
        reversesId: row.id,
      })
      .returning({ id: turnLedger.id });
    if (!excuse) throw new Error('ledger insert returned nothing');
    if (row.reasonType === 'deny' && row.visitId) {
      await tx
        .update(turnCalls)
        .set({ excusedBy: input.actor.userId, excusedAt: now })
        .where(
          eq(
            turnCalls.id,
            sql`(select c.id from ${turnCalls} c where c.visit_id = ${row.visitId} and c.technician_id = ${row.technicianId} and c.response = 'denied' and c.excused_at is null order by c.responded_at desc limit 1)`,
          ),
        );
    }
    await writeAudit(tx, {
      organizationId: row.organizationId,
      locationId: row.locationId,
      actorUserId: input.actor.userId,
      entityType: 'turn_ledger',
      entityId: excuse.id,
      action: row.reasonType === 'deny' ? 'deny_excused' : 'penalty_excused',
      before: { ledgerId: row.id, delta: Number(row.delta), reasonType: row.reasonType },
      after: { delta: -Number(row.delta), technicianId: row.technicianId },
      reason,
    });
    return { ok: true };
  });
}

/**
 * A manager adds or removes points by hand, with a reason (design doc:
 * "Manual adjustments post with the manager's reason"). Half steps, never
 * zero, only for a technician on shift at the manager's own location.
 */
export async function adjustPoints(
  db: Db,
  input: { technicianId: string; delta: number; actor: ManagerActor; reason: string },
): Promise<{ ok: true } | EngineError> {
  const reason = input.reason.trim().slice(0, 300);
  if (!reason) return { ok: false, reason: 'reason_required' };
  const delta = input.delta;
  if (
    !Number.isFinite(delta) ||
    delta === 0 ||
    Math.abs(delta) > 20 ||
    Math.round(delta * 2) !== delta * 2
  ) {
    return { ok: false, reason: 'bad_delta' };
  }
  return db.transaction(async (tx) => {
    const [tech] = await tx
      .select({
        organizationId: technicians.organizationId,
        locationId: technicians.locationId,
        userId: technicians.userId,
        shiftId: technicianStatus.shiftId,
        status: technicianStatus.status,
      })
      .from(technicians)
      .leftJoin(technicianStatus, eq(technicianStatus.technicianId, technicians.id))
      .where(and(eq(technicians.id, input.technicianId), eq(technicians.active, true)))
      .for('update', { of: technicians });
    if (!tech) return { ok: false, reason: 'unknown_technician' };
    if (input.actor.userId && tech.userId === input.actor.userId) {
      return { ok: false, reason: 'own_points' };
    }
    if (
      tech.locationId !== input.actor.locationId ||
      tech.organizationId !== input.actor.organizationId
    ) {
      return { ok: false, reason: 'wrong_location' };
    }
    if (!tech.shiftId || tech.status === 'off') return { ok: false, reason: 'not_on_shift' };
    const ledgerId = await postPoints(tx, {
      organizationId: tech.organizationId,
      locationId: tech.locationId,
      technicianId: input.technicianId,
      shiftId: tech.shiftId,
      delta,
      reasonType: 'manual',
      actorUserId: input.actor.userId,
      // The manager's words go to the audit log only (the ledger is floor-readable).
      note: 'adjusted',
    });
    await writeAudit(tx, {
      organizationId: tech.organizationId,
      locationId: tech.locationId,
      actorUserId: input.actor.userId,
      entityType: 'turn_ledger',
      entityId: ledgerId,
      action: 'points_adjusted',
      after: { technicianId: input.technicianId, delta },
      reason,
    });
    return { ok: true };
  });
}

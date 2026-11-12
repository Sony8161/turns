// The turn engine (design doc, Rule engine and Call flow). Server only. App
// code decides, the database enforces: one open call per technician and per
// visit (partial unique indexes), and every move writes the audit log.
// Every number comes from rule_config (rules.ts); nothing here is hard-coded.
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { normalizePhone, upsertClient, type ClientGender, type ClientInput } from './clients';
import { byTurn, loadLevels, type SkillLevel } from './levels';
import { doesEverything, loadProfiles, restrictionOf, type TechnicianProfile } from './profile';
import {
  activeRules,
  compareQueue,
  DENY_REASONS,
  visitPointsUnder,
  type DenyReason,
  type RuleConfig,
} from './rules';
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
import {
  HAD_APPOINTMENT_LAST,
  postPoints,
  shiftTotal,
  transition,
  writeAudit,
  type Actor,
} from './status';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A manager or owner acting at their own location (threat model T10). */
export type ManagerActor = { userId: string | null; organizationId: string; locationId: string };

// The deny reasons and the queue order live with the rules (v0.15.0); they
// are re-exported here because the engine is where callers look for them.
export { compareQueue, DENY_REASONS };
export type { DenyReason, RuleConfig };

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
    /** Part 9: a kiosk check-in waits for the desk to confirm (kiosk.ts). The
     *  phone stays on the visit; no client row is touched until the desk
     *  confirms (v0.9.1). */
    kiosk?: {
      deviceId: string;
      name: string;
      lastName?: string | null;
      phone?: string | null;
    } | null;
    /** v0.16.0: people who came in together share this id (party.ts). */
    partyId?: string | null;
    /** v0.16.0: the person's place in the group; their arrival is that many
     *  milliseconds later, so the desk lists the group in the order added. */
    partyIndex?: number;
    /** v0.16.0: a nail fix or repair entered at the desk (fixes.ts). The role
     *  decides whether it waits for a manager's approval; ofVisitId is the
     *  earlier visit it fixes, when the desk found one in the window. */
    fix?: {
      enteredBy: 'owner' | 'manager' | 'receptionist';
      ofVisitId?: string | null;
    } | null;
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
        isFix: services.isFix,
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
    // v0.16.0: a fix is desk only (never the kiosk) and goes on its own visit.
    const isFix = rows.some((r) => r.isFix);
    if (isFix && (input.kiosk || !input.fix)) return { ok: false, reason: 'unknown_service' };
    if (isFix && rows.length > 1) return { ok: false, reason: 'fix_alone' };
    if (!isFix && input.fix) return { ok: false, reason: 'not_a_fix' };
    let fixOf: { id: string; clientId: string | null } | null = null;
    if (isFix && input.fix?.ofVisitId) {
      const [orig] = await tx
        .select({ id: visits.id, clientId: visits.clientId })
        .from(visits)
        .where(
          and(
            eq(visits.id, input.fix.ofVisitId),
            eq(visits.locationId, input.locationId),
            eq(visits.organizationId, input.organizationId),
            eq(visits.status, 'completed'),
          ),
        );
      if (!orig) return { ok: false, reason: 'unknown_fix_visit' };
      fixOf = orig;
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
    // A kiosk check-in is unverified input: it keeps the phone on the visit and
    // touches no client row until the desk confirms (review finding 1).
    let kioskPhone: string | null = null;
    if (input.kiosk?.phone?.trim()) {
      kioskPhone = normalizePhone(input.kiosk.phone);
      if (!kioskPhone) return { ok: false, reason: 'bad_phone' };
    }
    const client = input.kiosk
      ? ({ ok: true, clientId: null } as const)
      : fixOf?.clientId
        ? // v0.16.0: a fix belongs to the client of the visit it fixes.
          ({ ok: true, clientId: fixOf.clientId } as const)
        : await upsertClient(tx, {
            organizationId: input.organizationId,
            locationId: input.locationId,
            name: input.client?.name ?? null,
            ...(input.client?.firstName !== undefined || input.client?.lastName !== undefined
              ? {
                  firstName: input.client?.firstName ?? null,
                  lastName: input.client?.lastName ?? null,
                }
              : {}),
            phone: input.client?.phone ?? null,
            gender,
          });
    if (!client.ok) return { ok: false, reason: client.reason };

    const rules = await activeRules(tx, input.locationId);
    const source = input.source ?? 'walk_in';
    // v0.16.0: a receptionist's fix waits for a manager or owner (rules);
    // a manager's or owner's is approved as it is entered.
    const needsApproval =
      isFix && input.fix?.enteredBy === 'receptionist' && rules.fixes.receptionist_needs_approval;
    const approvedNow = isFix && !needsApproval;
    const groupId = sameTime ? randomUUID() : null;
    const groups = sameTime ? rows.map((s) => [s]) : [rows];
    const visitIds: string[] = [];
    for (const group of groups) {
      // A same-time pair: the request goes with the first visit; the second
      // one needs a second technician. An appointment keeps its source with
      // its booked technician (Part 7). A kiosk request stays self_checkin
      // until the desk accepts it (v0.9.1, review finding 2).
      const requested = visitIds.length === 0 ? (input.requestedTechnicianId ?? null) : null;
      const storedSource =
        requested && source !== 'appointment' && !input.kiosk ? 'request' : source;
      const [visit] = await tx
        .insert(visits)
        .values({
          organizationId: input.organizationId,
          locationId: input.locationId,
          source: storedSource,
          requestedTechnicianId: requested,
          note: input.note?.trim().slice(0, 300) || null,
          createdBy: input.actor.userId,
          clientId: client.clientId,
          clientGender: gender,
          clientIsKid: input.attributes?.isKid ?? null,
          clientAge: age,
          groupId,
          kioskDeviceId: input.kiosk?.deviceId ?? null,
          kioskName: input.kiosk?.name ?? null,
          kioskLastName: input.kiosk?.lastName ?? null,
          kioskPhone,
          needsConfirm: !!input.kiosk,
          partyId: input.partyId ?? null,
          isFix,
          fixOfVisitId: fixOf?.id ?? null,
          needsApproval,
          ...(approvedNow ? { approvedBy: input.actor.userId, approvedAt: new Date() } : {}),
        })
        .returning({ id: visits.id });
      if (!visit) throw new Error('visit insert returned nothing');
      if (input.partyIndex) {
        await tx
          .update(visits)
          .set({
            arrivedAt: sql`${visits.arrivedAt} + (${input.partyIndex} * interval '1 millisecond')`,
          })
          .where(eq(visits.id, visit.id));
      }
      await tx.insert(visitServices).values(
        group.map((s) => ({
          organizationId: input.organizationId,
          visitId: visit.id,
          serviceId: s.id,
          pointsValueSnapshot: visitPointsUnder(
            rules,
            [{ ...s, serviceId: s.id }],
            'walk_in',
          ).toFixed(1),
        })),
      );
      // The attributes the engine used, never the name or phone (T11).
      await writeAudit(tx, {
        organizationId: input.organizationId,
        locationId: input.locationId,
        actorUserId: input.actor.userId,
        entityType: 'visits',
        entityId: visit.id,
        action: input.kiosk ? 'kiosk_check_in' : isFix ? 'fix_entered' : 'visit_created',
        after: {
          ...(input.partyId ? { partyId: input.partyId } : {}),
          ...(isFix
            ? {
                fixOfVisitId: fixOf?.id ?? null,
                // No visit found in the window: the approver saw the warning.
                inWindow: fixOf !== null,
                needsApproval,
              }
            : {}),
          source: storedSource,
          requestedTechnicianId: requested,
          ...(input.kiosk ? { kioskDeviceId: input.kiosk.deviceId } : {}),
          serviceIds: group.map((s) => s.id),
          gender,
          isKid: input.attributes?.isKid ?? null,
          age,
          groupId,
          hasClient: client.clientId !== null,
          // The note itself is free text: only whether there is one (T11).
          hasNote: !!input.note?.trim(),
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
  | 'appointment_soon'
  | 'not_by_turn'
  | 'said_no';

/** Reasons a manager may override with reassign (force); status reasons never. */
export const SOFT_SKIPS: readonly SkipReason[] = [
  'no_skill',
  'no_male_clients',
  'no_kids',
  'min_client_age',
  'no_same_time',
  'appointment_soon',
  'not_by_turn',
  'said_no',
];

export type Candidate = {
  technicianId: string;
  displayName: string;
  points: number;
  checkedInAt: Date | null;
  status: string;
  eligible: boolean;
  why: SkipReason;
  /** For no_skill: the category or service names missing. For appointment_soon:
   *  minutes until it. For not_by_turn: the services that are not this level's by turn. */
  detail?: string;
  /** v0.14.0: the technician's level, when one is set. */
  level?: SkillLevel;
  /** v0.15.0, a visit of several services: the ones she does, when that is
   *  not all of them. She is called for those; the rest go on after her. */
  takes?: string[];
  /** A custom restriction's text: shown to the desk, never applied by the engine. */
  note?: string;
  /** With skill_match "preferred": does the technician have every skill? */
  skilled: boolean;
  /** The last visit this shift was an appointment: sorts after a true 0 (shows 00). */
  hadAppointmentLast: boolean;
};

/** What the engine needs to know about the visit being called. */
export type VisitContext = {
  categoryIds: string[];
  /** v0.14.0: the services themselves: technicians with a level are matched
   *  per service, and each service names the levels that get it by turn. */
  serviceIds?: string[];
  /** The technician the client asked for: the by-turn level rule never holds
   *  a technician out of a visit that asked for her. */
  requestedTechnicianId?: string | null;
  /** v0.15.0: the visit itself, so a technician who said no to it for a
   *  reason the rules excuse is not called for it again. */
  visitId?: string;
  gender: ClientGender | null;
  isKid: boolean | null;
  age: number | null;
  sameTime: boolean;
  /** For an arrived appointment: its technician, whom the appointment buffer
   *  never holds out of their own appointment (v0.7.1). */
  bookedTechnicianId?: string | null;
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
  const bufferMs = rules.eligibility.upcoming_appointment_buffer_min * 60_000;
  const bufferEnd = new Date(now.getTime() + bufferMs);
  // A client this much past their start time is a no-show: the technician is
  // free again even when the row cannot be cancelled (a calendar row).
  const noShowBefore = new Date(now.getTime() - bufferMs);
  const serviceIds = [...new Set(ctx.serviceIds ?? [])];
  const [rows, profiles, categories, upcoming, levels, menu, saidNo] = await Promise.all([
    tx
      .select({
        technicianId: technicians.id,
        displayName: technicians.displayName,
        skillLevel: technicians.skillLevel,
        status: technicianStatus.status,
        checkedInAt: shifts.checkedInAt,
        points: sql<string>`coalesce((select sum(${turnLedger.delta}) from ${turnLedger} where ${turnLedger.shiftId} = ${technicianStatus.shiftId}), 0)`,
        hadAppointmentLast: HAD_APPOINTMENT_LAST,
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
          // An appointment whose client is here is a visit now (Part 7).
          isNull(appointments.arrivedAt),
          gt(appointments.endAt, now),
          gt(appointments.startAt, noShowBefore),
          lt(appointments.startAt, bufferEnd),
        ),
      )
      .orderBy(asc(appointments.startAt)),
    loadLevels(tx, locationId),
    serviceIds.length
      ? tx
          .select({
            id: services.id,
            name: services.name,
            turnLevels: services.turnLevels,
            categoryId: services.categoryId,
          })
          .from(services)
          .where(inArray(services.id, serviceIds))
          .orderBy(asc(services.name))
      : Promise.resolve(
          [] as {
            id: string;
            name: string;
            turnLevels: SkillLevel[] | null;
            categoryId: string;
          }[],
        ),
    // v0.15.0: who already said no to this visit for a reason the rules excuse.
    ctx.visitId
      ? tx
          .select({ technicianId: turnCalls.technicianId })
          .from(turnCalls)
          .where(and(eq(turnCalls.visitId, ctx.visitId), eq(turnCalls.autoExcused, true)))
      : Promise.resolve([] as { technicianId: string }[]),
  ]);
  const declined = new Set(saidNo.map((r) => r.technicianId));
  const required = rules.eligibility.skill_match === 'required';
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
      // v0.14.0: a technician with a level is matched per service (the ticks
      // on her settings page); without one, the Part 6 category skills decide.
      const lv = levels.get(r.technicianId);
      const skills = profile ? new Set(profile.skillCategoryIds) : null;
      const missing = lv
        ? menu.filter((m) => !lv.serviceIds.has(m.id)).map((m) => m.name)
        : !profile || doesEverything(profile)
          ? []
          : needed.filter((c) => !skills!.has(c)).map((c) => nameOf.get(c) ?? c);
      const skilled = missing.length === 0;
      // Services that are not this level's by turn. Never for the technician
      // the client asked for or booked.
      const asked =
        ctx.requestedTechnicianId === r.technicianId || ctx.bookedTechnicianId === r.technicianId;
      const notHers =
        lv && !asked ? menu.filter((m) => !byTurn(lv.level, m.turnLevels)).map((m) => m.name) : [];
      // v0.15.0 (Duong: "called first by turn; if need be they just do one
      // service and the other is called after they are done"): on a visit of
      // several services she is called when at least one of them is hers. What
      // she does (her ticks, or her categories without a level), and of that,
      // what her level gets by turn.
      const does = !required
        ? menu
        : lv
          ? menu.filter((m) => lv.serviceIds.has(m.id))
          : !profile || doesEverything(profile)
            ? menu
            : menu.filter((m) => skills!.has(m.categoryId));
      const hers = does.filter((m) => !lv || asked || byTurn(lv.level, m.turnLevels));
      const custom = profile ? (restrictionOf(profile, 'custom')?.note ?? undefined) : undefined;
      const base = {
        technicianId: r.technicianId,
        displayName: r.displayName,
        points: Number(r.points),
        checkedInAt: r.checkedInAt,
        status: r.status,
        skilled,
        hadAppointmentLast: r.hadAppointmentLast === true,
        ...(custom ? { note: custom } : {}),
        ...(lv ? { level: lv.level } : {}),
        ...(menu.length > 1 && does.length > 0 && does.length < menu.length
          ? { takes: does.map((m) => m.name) }
          : {}),
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
      // She said no to this client (break, personal): no points, and no second call for it.
      if (declined.has(r.technicianId)) return skip('said_no');
      // With the services known: skipped only when she does none of them.
      if (required && (menu.length ? does.length === 0 : !skilled)) {
        return skip('no_skill', missing.join(', '));
      }
      if (profile && rules.eligibility.honor_restrictions) {
        const blocked = restrictionBlocking(profile, ctx);
        if (blocked) return skip(blocked);
      }
      const appointment = nextAppointment.get(r.technicianId);
      // The booked technician is being called for an appointment: the next
      // one on their book follows it, it does not block it.
      if (appointment && ctx.bookedTechnicianId !== r.technicianId) {
        const minutes = Math.max(0, Math.ceil((appointment.getTime() - now.getTime()) / 60_000));
        return skip('appointment_soon', String(minutes));
      }
      // Last on purpose: a technician skipped as not_by_turn is held out by
      // the level rule alone, so the desk may ask her (offerToHigherLevel).
      // No penalty and no change to her place: a skip never posts points.
      if (menu.length ? hers.length === 0 : notHers.length > 0) {
        return skip('not_by_turn', notHers.join(', '));
      }
      return { ...base, eligible: true, why: 'available' };
    })
    .sort((a, b) => {
      // "preferred": a technician with the skills goes ahead of one without, at any points.
      if (rules.eligibility.skill_match === 'preferred' && a.skilled !== b.skilled) {
        return a.skilled ? -1 : 1;
      }
      return compareQueue(rules, a, b);
    });
}

/** The engine's view of a visit: its categories and the client attributes. */
export async function contextOf(tx: Tx, visit: typeof visits.$inferSelect): Promise<VisitContext> {
  const items = await tx
    .select({ categoryId: services.categoryId, serviceId: services.id })
    .from(visitServices)
    .innerJoin(services, eq(services.id, visitServices.serviceId))
    .where(eq(visitServices.visitId, visit.id));
  return {
    categoryIds: items.map((i) => i.categoryId),
    serviceIds: items.map((i) => i.serviceId),
    requestedTechnicianId: visit.requestedTechnicianId,
    visitId: visit.id,
    gender: visit.clientGender,
    isKid: visit.clientIsKid,
    age: visit.clientAge,
    sameTime: visit.groupId !== null,
    bookedTechnicianId: visit.source === 'appointment' ? visit.requestedTechnicianId : null,
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

const OPEN_VISIT = ['waiting', 'called', 'in_service'];

/**
 * v0.15.0: the rest of a split visit waits until the first part is finished
 * (the client is in that chair). Returns the visit it waits behind, or null
 * when it may be called. A same-time visit never waits: two technicians work
 * at once.
 */
async function waitsBehind(
  tx: Tx | Db,
  visit: { splitFromVisitId: string | null },
): Promise<{ id: string; assignedTechnicianId: string | null } | null> {
  if (!visit.splitFromVisitId) return null;
  const [first] = await tx
    .select({
      id: visits.id,
      status: visits.status,
      groupId: visits.groupId,
      assignedTechnicianId: visits.assignedTechnicianId,
    })
    .from(visits)
    .where(eq(visits.id, visit.splitFromVisitId));
  if (!first || first.groupId !== null || !OPEN_VISIT.includes(first.status)) return null;
  return { id: first.id, assignedTechnicianId: first.assignedTechnicianId };
}

/**
 * The services of a visit this technician does (her ticks, or her category
 * skills without a level). Everything when the rules do not require skills.
 */
async function doableServices(
  tx: Tx | Db,
  locationId: string,
  technicianId: string,
  items: { serviceId: string; categoryId: string }[],
  rules: RuleConfig,
): Promise<string[]> {
  const all = items.map((i) => i.serviceId);
  if (rules.eligibility.skill_match !== 'required') return all;
  const lv = (await loadLevels(tx, locationId)).get(technicianId);
  if (lv) return all.filter((id) => lv.serviceIds.has(id));
  const profile = (await loadProfiles(tx, locationId)).get(technicianId);
  if (!profile || doesEverything(profile)) return all;
  const skills = new Set(profile.skillCategoryIds);
  return items.filter((i) => skills.has(i.categoryId)).map((i) => i.serviceId);
}

/** Does this visit hold a service the desk picks the technician for? */
async function hasDeskPick(tx: Tx, visitId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: services.id })
    .from(visitServices)
    .innerJoin(services, eq(services.id, visitServices.serviceId))
    .where(and(eq(visitServices.visitId, visitId), eq(services.deskPicks, true)))
    .limit(1);
  return rows.length > 0;
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
    // Part 9: a kiosk check-in is confirmed by the desk first (a trigger also refuses).
    if (visit.needsConfirm) return { ok: false, reason: 'needs_confirm' };
    // v0.16.0: a receptionist's fix waits for a manager or owner (a trigger also refuses).
    if (visit.needsApproval) return { ok: false, reason: 'needs_approval' };
    // v0.14.0: a service the desk picks the technician for is never called by turn.
    if (await hasDeskPick(tx, visit.id)) return { ok: false, reason: 'desk_picks' };
    // v0.15.0: the rest of a split visit waits for the first part to finish.
    if (await waitsBehind(tx, visit)) return { ok: false, reason: 'waits_for_first_part' };

    const rules = await activeRules(tx, visit.locationId);
    const queue = await queueFor(tx, visit.locationId, await contextOf(tx, visit));
    // With the bypass rule on, a requested technician is the only pick: when
    // they cannot take it, the visit waits for them and the desk sees why. With
    // the rule off, the request is a note and the line decides. An appointment
    // always belongs to the technician it was booked with (Part 7); whether it
    // may fall back to the line is not decided (open with Phu).
    const bookedOnly =
      !!visit.requestedTechnicianId &&
      (visit.source === 'appointment' || rules.requests.requested_tech_bypasses_queue);
    const pick = bookedOnly
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
    // Two desks pressing Call next at the same second both pick her; the one
    // that waited for the row above now sees the other's call and loses
    // cleanly (v0.15.0: it used to reach the unique index and throw).
    const [taken] = await tx
      .select({ id: turnCalls.id })
      .from(turnCalls)
      .where(and(eq(turnCalls.technicianId, pick.technicianId), isNull(turnCalls.respondedAt)))
      .limit(1);
    if (taken) {
      return {
        ok: false,
        reason: 'nobody_eligible',
        detail: `${pick.displayName}: already_called`,
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
    /** v0.14.0, a visit with two or more services: the ones this technician
     *  keeps. The rest go back to the line as a linked visit. Omitted or all
     *  of them = "do all". */
    keepServiceIds?: string[];
    actor: Actor;
  },
): Promise<{ ok: true; splitVisitId?: string } | EngineError> {
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
      // Decide the split before anything is written.
      const items = await tx
        .select({ serviceId: visitServices.serviceId, categoryId: services.categoryId })
        .from(visitServices)
        .innerJoin(services, eq(services.id, visitServices.serviceId))
        .where(eq(visitServices.visitId, call.visitId));
      const all = items.map((i) => i.serviceId);
      // v0.15.0: she keeps only services she does. "Do all" is all of those.
      // A manager who sent her a visit she does none of overrode that (force).
      const snapshot = Array.isArray(call.queueSnapshot)
        ? (call.queueSnapshot as Candidate[]).find((c) => c.technicianId === call.technicianId)
        : undefined;
      const forced = !!snapshot && !snapshot.eligible && snapshot.why === 'no_skill';
      const does = forced
        ? all
        : await doableServices(
            tx,
            call.locationId,
            call.technicianId,
            items,
            await activeRules(tx, call.locationId),
          );
      const able = does.length ? does : all;
      const keep = input.keepServiceIds ? [...new Set(input.keepServiceIds)] : able;
      if (keep.length === 0 || keep.some((k) => !able.includes(k))) {
        return { ok: false, reason: 'bad_split' };
      }
      const sendBack = all.filter((a) => !keep.includes(a));
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
      const splitVisitId = sendBack.length
        ? await splitVisit(tx, call.visitId, keep, sendBack, input.actor)
        : null;
      await writeAudit(tx, {
        organizationId: call.organizationId,
        locationId: call.locationId,
        actorUserId: input.actor.userId,
        entityType: 'turn_calls',
        entityId: call.id,
        action: call.kind === 'offer' ? 'offer_accepted' : 'call_accepted',
        after: {
          visitId: call.visitId,
          ...(call.kind !== 'turn' ? { kind: call.kind } : {}),
          // The technician's choice on a visit with more than one service.
          ...(all.length > 1 ? { choice: sendBack.length ? 'split' : 'all' } : {}),
          // She does only part of it: the rest was never hers to choose.
          ...(able.length < all.length ? { takesOnly: able } : {}),
        },
      });
      return { ok: true, ...(splitVisitId ? { splitVisitId } : {}) };
    }

    // v0.14.0: the desk asked (an offer to a higher level, or a desk pick).
    // Saying no is never a deny: no points, the visit waits again.
    if (call.kind !== 'turn') {
      await tx
        .update(turnCalls)
        .set({ respondedAt: now, response: 'denied', denyReason: 'declined' })
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
        action: call.kind === 'offer' ? 'offer_declined' : 'desk_pick_declined',
        after: { visitId: call.visitId, kind: call.kind },
      });
      return { ok: true };
    }

    const reason = input.denyReason ?? 'other';
    if (!DENY_REASONS.includes(reason)) return { ok: false, reason: 'bad_deny_reason' };
    const rules = await activeRules(tx, call.locationId);
    // v0.15.0: a reason the rules excuse (Heavenly: break, personal) costs
    // nothing and needs no manager. She is not called for this visit again.
    const excused = rules.penalties.deny_excused_reasons.includes(reason);
    await tx
      .update(turnCalls)
      .set({
        respondedAt: now,
        response: 'denied',
        denyReason: reason,
        ...(excused ? { autoExcused: true, excusedAt: now } : {}),
      })
      .where(eq(turnCalls.id, call.id));
    await tx
      .update(visits)
      .set({ status: 'waiting', updatedAt: now })
      .where(eq(visits.id, call.visitId));
    const [st] = await tx
      .select({ shiftId: technicianStatus.shiftId })
      .from(technicianStatus)
      .where(eq(technicianStatus.technicianId, call.technicianId));
    if (st?.shiftId && !excused) {
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
      after: {
        visitId: call.visitId,
        denyReason: reason,
        ...(excused ? { excused: 'by_rule' } : {}),
      },
      reason,
    });
    return { ok: true };
  });
}

/**
 * v0.14.0: the called technician keeps some services of a visit and sends
 * the rest back to the line. The rest become a linked visit that keeps the
 * client and their arrival time (so their wait and their place on the desk's
 * list stay), for the next technician who can take them. v0.15.0: that visit
 * waits until this one is finished (waitsBehind): the client is in her chair. Each technician is
 * paid points only for the services on the visit she finishes. A request or
 * an appointment stays with the first visit; the rest go by turn.
 */
async function splitVisit(
  tx: Tx,
  visitId: string,
  keep: string[],
  sendBack: string[],
  actor: Actor,
): Promise<string> {
  const [visit] = await tx.select().from(visits).where(eq(visits.id, visitId));
  if (!visit) throw new Error('split: visit not found');
  const [rest] = await tx
    .insert(visits)
    .values({
      organizationId: visit.organizationId,
      locationId: visit.locationId,
      source: visit.source === 'self_checkin' ? 'self_checkin' : 'walk_in',
      clientId: visit.clientId,
      clientGender: visit.clientGender,
      clientIsKid: visit.clientIsKid,
      clientAge: visit.clientAge,
      createdBy: visit.createdBy,
      arrivedAt: visit.arrivedAt,
      note: visit.note,
      // The desk's row still shows who this is when no client row exists.
      kioskName: visit.kioskName,
      kioskLastName: visit.kioskLastName,
      splitFromVisitId: visit.id,
    })
    .returning({ id: visits.id });
  if (!rest) throw new Error('split: visit insert returned nothing');
  await tx
    .update(visitServices)
    .set({ visitId: rest.id })
    .where(and(eq(visitServices.visitId, visit.id), inArray(visitServices.serviceId, sendBack)));
  await writeAudit(tx, {
    organizationId: visit.organizationId,
    locationId: visit.locationId,
    actorUserId: actor.userId,
    entityType: 'visits',
    entityId: visit.id,
    action: 'visit_split',
    after: { keptServiceIds: keep, sentBackServiceIds: sendBack, newVisitId: rest.id },
  });
  return rest.id;
}

/**
 * v0.14.0: the desk calls one technician outside the turn order. Two cases:
 *  - 'offer': a service is waiting and a higher-level technician could do it
 *    but is held out only by the by-turn level rule. The desk asks her.
 *  - 'desk_pick': the visit holds a service the desk picks the technician
 *    for (nail art, design). Anyone who can do it and is free may be picked.
 * She can say no without a penalty; if she takes it, points post as normal.
 * Never automatic: only this function writes such a call.
 */
export async function deskCall(
  db: Db,
  input: {
    kind: 'offer' | 'desk_pick';
    visitId: string;
    technicianId: string;
    actor: Actor;
    /** The caller's own location (threat model T10). */
    locationId: string;
  },
): Promise<{ ok: true; callId: string } | EngineError> {
  return db.transaction(async (tx) => {
    const [visit] = await tx
      .select()
      .from(visits)
      .where(eq(visits.id, input.visitId))
      .for('update');
    if (!visit) return { ok: false, reason: 'unknown_visit' };
    if (visit.locationId !== input.locationId) return { ok: false, reason: 'wrong_location' };
    if (visit.status !== 'waiting') return { ok: false, reason: 'visit_not_waiting' };
    if (visit.needsConfirm) return { ok: false, reason: 'needs_confirm' };
    if (visit.needsApproval) return { ok: false, reason: 'needs_approval' };
    if (await waitsBehind(tx, visit)) return { ok: false, reason: 'waits_for_first_part' };
    const picks = await hasDeskPick(tx, visit.id);
    if (input.kind === 'desk_pick' && !picks) return { ok: false, reason: 'not_desk_pick' };
    if (input.kind === 'offer' && picks) return { ok: false, reason: 'desk_picks' };
    const queue = await queueFor(tx, visit.locationId, await contextOf(tx, visit));
    const target = queue.find((c) => c.technicianId === input.technicianId);
    const allowed =
      !!target &&
      (input.kind === 'offer'
        ? target.why === 'not_by_turn'
        : target.eligible || target.why === 'not_by_turn');
    if (!target || !allowed) {
      return {
        ok: false,
        reason: 'target_not_eligible',
        detail: target?.why ?? 'off',
        skipped: target ? skippedOf([target]) : [],
      };
    }
    const [held] = await tx
      .select({ status: technicianStatus.status })
      .from(technicianStatus)
      .where(eq(technicianStatus.technicianId, target.technicianId))
      .for('update');
    if (held?.status !== 'available') {
      return { ok: false, reason: 'target_not_eligible', detail: held?.status ?? 'off' };
    }
    const [taken] = await tx
      .select({ id: turnCalls.id })
      .from(turnCalls)
      .where(and(eq(turnCalls.technicianId, target.technicianId), isNull(turnCalls.respondedAt)))
      .limit(1);
    if (taken) return { ok: false, reason: 'target_not_eligible', detail: 'already_called' };
    const [call] = await tx
      .insert(turnCalls)
      .values({
        organizationId: visit.organizationId,
        locationId: visit.locationId,
        visitId: visit.id,
        technicianId: target.technicianId,
        calledBy: input.actor.userId,
        kind: input.kind,
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
      action: input.kind === 'offer' ? 'offer_sent' : 'desk_pick_sent',
      after: { visitId: visit.id, technicianId: target.technicianId, queue },
    });
    return { ok: true, callId: call.id };
  });
}

export type DeskOption = {
  technicianId: string;
  displayName: string;
  /** v0.16.0: she did the work this fix repairs: the desk's first choice. */
  original?: boolean;
  level: SkillLevel | null;
  /** Place in today's line, 1 = next. */
  turn: number;
  points: number;
  status: string;
  /** Free right now: the desk may call her for this visit. */
  canCall: boolean;
};

/**
 * What the desk may do outside the turn order, per waiting visit:
 *  - deskPicks true: "Pick a tech", with everyone who does the services, their
 *    status and their turn.
 *  - otherwise: the higher-level technicians held out only by the level rule
 *    ("Ask a higher-level tech"). Empty when there is nobody to ask.
 */
export async function deskOptions(
  db: Db,
  locationId: string,
): Promise<Map<string, { deskPicks: boolean; technicians: DeskOption[] }>> {
  return db.transaction(async (tx) => {
    const waiting = await tx
      .select()
      .from(visits)
      .where(
        and(
          eq(visits.locationId, locationId),
          eq(visits.status, 'waiting'),
          eq(visits.needsConfirm, false),
          eq(visits.needsApproval, false),
        ),
      );
    const out = new Map<string, { deskPicks: boolean; technicians: DeskOption[] }>();
    for (const visit of waiting) {
      // The rest of a split visit cannot be called yet: nothing to offer.
      if (await waitsBehind(tx, visit)) continue;
      const picks = await hasDeskPick(tx, visit.id);
      const queue = await queueFor(tx, locationId, await contextOf(tx, visit));
      const option = (c: Candidate, i: number): DeskOption => ({
        technicianId: c.technicianId,
        displayName: c.displayName,
        level: c.level ?? null,
        turn: i + 1,
        points: c.points,
        status: c.status,
        canCall: c.eligible || c.why === 'not_by_turn',
      });
      const technicians = queue
        .map((c, i) => ({ c, o: option(c, i) }))
        .filter(({ c }) =>
          picks
            ? // Everyone who does it and whom no restriction keeps from this client.
              c.skilled &&
              !['no_male_clients', 'no_kids', 'min_client_age', 'no_same_time'].includes(c.why)
            : c.why === 'not_by_turn',
        )
        .map(({ o }) => o);
      // Asking a higher level is for when nobody gets it by turn right now
      // (Duong: "if it is very busy"); while someone does, Call next is the way.
      const byTurnFree = queue.some((c) => c.eligible);
      // v0.16.0: a fix: the technician who did the original work comes first,
      // marked, when she is working today.
      if (visit.fixOfVisitId) {
        const [orig] = await tx
          .select({ technicianId: visits.assignedTechnicianId })
          .from(visits)
          .where(eq(visits.id, visit.fixOfVisitId));
        const at = technicians.findIndex((o) => o.technicianId === orig?.technicianId);
        if (at >= 0) {
          const [mine] = technicians.splice(at, 1);
          technicians.unshift({ ...mine!, original: true });
        }
      }
      if (picks) out.set(visit.id, { deskPicks: true, technicians });
      else if (technicians.length && !byTurnFree) {
        out.set(visit.id, { deskPicks: false, technicians });
      }
    }
    return out;
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
        serviceId: visitServices.serviceId,
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
    // Part 9: the desk confirms a kiosk check-in first (the call trigger would
    // refuse anyway; this keeps the answer clean, review finding 3).
    if (visit.needsConfirm) return { ok: false, reason: 'needs_confirm' };
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

export type SlipPart = {
  /** Who did (or is doing) this part; null while nobody has it. */
  technician: string | null;
  services: string[];
};

/**
 * v0.15.0, the on-screen slip (Heavenly hands the next technician a paper
 * one): the earlier parts of a split visit, first part first. null for a
 * visit that is not the rest of another.
 */
async function slipFor(
  db: Db | Tx,
  visit: { splitFromVisitId: string | null },
): Promise<SlipPart[] | null> {
  const parts: SlipPart[] = [];
  let parentId = visit.splitFromVisitId;
  // A visit has at most a handful of services, so the chain is short.
  for (let i = 0; parentId && i < 12; i++) {
    const [p] = await db
      .select({
        id: visits.id,
        splitFromVisitId: visits.splitFromVisitId,
        technician: technicians.displayName,
      })
      .from(visits)
      .leftJoin(technicians, eq(technicians.id, visits.assignedTechnicianId))
      .where(eq(visits.id, parentId));
    if (!p) break;
    const items = await db
      .select({ name: services.name })
      .from(visitServices)
      .innerJoin(services, eq(services.id, visitServices.serviceId))
      .where(eq(visitServices.visitId, p.id))
      .orderBy(asc(services.name));
    parts.unshift({ technician: p.technician, services: items.map((i) => i.name) });
    parentId = p.splitFromVisitId;
  }
  return parts.length ? parts : null;
}

/** What the technician's phone needs: their open call with its services. */
export async function openCallFor(db: Db, technicianId: string) {
  const [call] = await db
    .select({
      callId: turnCalls.id,
      visitId: turnCalls.visitId,
      calledAt: turnCalls.calledAt,
      source: visits.source,
      note: visits.note,
      requestedTechnicianId: visits.requestedTechnicianId,
      kind: turnCalls.kind,
      locationId: turnCalls.locationId,
      queueSnapshot: turnCalls.queueSnapshot,
      splitFromVisitId: visits.splitFromVisitId,
    })
    .from(turnCalls)
    .innerJoin(visits, eq(visits.id, turnCalls.visitId))
    .where(and(eq(turnCalls.technicianId, technicianId), isNull(turnCalls.respondedAt)))
    .orderBy(asc(turnCalls.calledAt))
    .limit(1);
  if (!call) return null;
  const items = await db
    .select({ id: services.id, name: services.name, categoryId: services.categoryId })
    .from(visitServices)
    .innerJoin(services, eq(services.id, visitServices.serviceId))
    .where(eq(visitServices.visitId, call.visitId))
    .orderBy(asc(services.name));
  // v0.15.0: which of them she does (respondToCall holds the same line).
  const snapshot = Array.isArray(call.queueSnapshot)
    ? (call.queueSnapshot as Candidate[]).find((c) => c.technicianId === technicianId)
    : undefined;
  const forced = !!snapshot && !snapshot.eligible && snapshot.why === 'no_skill';
  const does = forced
    ? []
    : await doableServices(
        db,
        call.locationId,
        technicianId,
        items.map((i) => ({ serviceId: i.id, categoryId: i.categoryId })),
        await activeRules(db, call.locationId),
      );
  const able = new Set(does.length ? does : items.map((i) => i.id));
  const {
    requestedTechnicianId,
    locationId: _locationId,
    queueSnapshot: _queueSnapshot,
    splitFromVisitId,
    ...rest
  } = call;
  void _locationId;
  void _queueSnapshot;
  // The note goes only to the technician this visit is called to (v0.10.2).
  return {
    ...rest,
    requested: requestedTechnicianId === technicianId,
    services: items.map((i) => i.name),
    /** v0.14.0: with ids, so the technician can keep some and send the rest back.
     *  v0.15.0: canDo false = not hers to keep; it goes on to the next technician. */
    serviceItems: items.map((i) => ({ id: i.id, name: i.name, canDo: able.has(i.id) })),
    /** v0.15.0: the earlier parts of this client's visit, when this is the rest of one. */
    slip: await slipFor(db, { splitFromVisitId }),
  };
}

export const VISIT_NOTE_MAX = 300;

/**
 * The desk adds, edits or clears the special request on an open visit
 * (v0.10.2). Same location only. The audit row says whether there is a note,
 * never the text (T11).
 */
export async function setVisitNote(
  db: Db,
  input: {
    actor: ManagerActor;
    visitId: string;
    note: unknown;
  },
): Promise<{ ok: true } | { ok: false; reason: 'unknown_visit' | 'visit_closed' }> {
  const raw = typeof input.note === 'string' ? input.note : '';
  const note =
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, VISIT_NOTE_MAX)
      .trim() || null;
  return db.transaction(async (tx) => {
    const [visit] = await tx
      .select({ id: visits.id, status: visits.status, note: visits.note })
      .from(visits)
      .where(
        and(
          eq(visits.id, input.visitId),
          eq(visits.locationId, input.actor.locationId),
          eq(visits.organizationId, input.actor.organizationId),
        ),
      )
      .for('update');
    if (!visit) return { ok: false, reason: 'unknown_visit' } as const;
    if (visit.status === 'completed' || visit.status === 'cancelled' || visit.status === 'left') {
      return { ok: false, reason: 'visit_closed' } as const;
    }
    if ((visit.note ?? null) === note) return { ok: true } as const;
    await tx.update(visits).set({ note }).where(eq(visits.id, visit.id));
    await writeAudit(tx, {
      organizationId: input.actor.organizationId,
      locationId: input.actor.locationId,
      actorUserId: input.actor.userId,
      entityType: 'visits',
      entityId: visit.id,
      action: 'visit_note_changed',
      before: { hasNote: visit.note !== null },
      after: { hasNote: note !== null },
    });
    return { ok: true } as const;
  });
}

/** v0.16.0: the earlier visit a fix repairs, as the desk shows it. */
export type FixOrigin = {
  visitId: string;
  at: Date;
  services: string[];
  technicianId: string | null;
  technician: string | null;
};

export async function fixOrigin(db: Db | Tx, visitId: string): Promise<FixOrigin | null> {
  const [v] = await db
    .select({
      id: visits.id,
      at: visits.arrivedAt,
      technicianId: visits.assignedTechnicianId,
      technician: technicians.displayName,
    })
    .from(visits)
    .leftJoin(technicians, eq(technicians.id, visits.assignedTechnicianId))
    .where(eq(visits.id, visitId));
  if (!v) return null;
  const items = await db
    .select({ name: services.name })
    .from(visitServices)
    .innerJoin(services, eq(services.id, visitServices.serviceId))
    .where(eq(visitServices.visitId, v.id))
    .orderBy(asc(services.name));
  return {
    visitId: v.id,
    at: v.at,
    services: items.map((i) => i.name),
    technicianId: v.technicianId,
    technician: v.technician,
  };
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
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
      kioskLastName: visits.kioskLastName,
      fromKiosk: sql<boolean>`${visits.kioskDeviceId} is not null`,
      kioskName: visits.kioskName,
      needsConfirm: visits.needsConfirm,
      splitFromVisitId: visits.splitFromVisitId,
      requestedTechnicianId: visits.requestedTechnicianId,
      callKind: turnCalls.kind,
      // v0.16.0
      partyId: visits.partyId,
      isFix: visits.isFix,
      fixOfVisitId: visits.fixOfVisitId,
      needsApproval: visits.needsApproval,
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
        .select({
          visitId: visitServices.visitId,
          name: services.name,
          deskPicks: services.deskPicks,
        })
        .from(visitServices)
        .innerJoin(services, eq(services.id, visitServices.serviceId))
        .where(inArray(visitServices.visitId, ids))
    : [];
  // v0.15.0: the rest of a split visit: the slip, and whether it still waits
  // for the first part to finish.
  const split = new Map<
    string,
    { slip: SlipPart[] | null; held: { technician: string | null } | null }
  >();
  for (const r of rows) {
    if (!r.splitFromVisitId) continue;
    const slip = await slipFor(db, r);
    const behind = r.status === 'waiting' ? await waitsBehind(db, r) : null;
    split.set(r.id, {
      slip,
      held: behind ? { technician: slip?.at(-1)?.technician ?? null } : null,
    });
  }
  // v0.16.0: how many people came in together ("Group of 3").
  const partyIds = [...new Set(rows.map((r) => r.partyId).filter((p): p is string => !!p))];
  const partySizes = new Map<string, number>();
  if (partyIds.length) {
    const sizes = await db
      .select({ partyId: visits.partyId, n: sql<number>`count(*)::int` })
      .from(visits)
      .where(and(inArray(visits.partyId, partyIds), eq(visits.locationId, locationId)))
      .groupBy(visits.partyId);
    for (const z of sizes) if (z.partyId) partySizes.set(z.partyId, Number(z.n));
  }
  // v0.16.0: the visit a fix repairs: when, what, and who did it.
  const fixes = new Map<string, FixOrigin>();
  for (const r of rows) {
    if (!r.fixOfVisitId) continue;
    const origin = await fixOrigin(db, r.fixOfVisitId);
    if (origin) fixes.set(r.id, origin);
  }
  return rows.map((r) => ({
    ...r,
    partySize: r.partyId ? (partySizes.get(r.partyId) ?? 1) : null,
    fixOf: fixes.get(r.id) ?? null,
    services: items.filter((i) => i.visitId === r.id).map((i) => i.name),
    /** v0.14.0: the desk picks the technician for this visit (never by turn). */
    deskPicks: items.some((i) => i.visitId === r.id && i.deskPicks),
    /** v0.15.0: who did the earlier parts (the on-screen slip). */
    slip: split.get(r.id)?.slip ?? null,
    /** v0.15.0: not callable yet: it waits until this technician finishes her part. */
    held: split.get(r.id)?.held ?? null,
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
        // An unconfirmed kiosk check-in may be nobody (v0.9.1, review finding 5).
        eq(visits.needsConfirm, false),
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
        // An offer or desk pick that was declined is not a deny (v0.14.0).
        eq(turnCalls.kind, 'turn'),
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
    // The design doc's audit table asks for before and after on an adjustment.
    const pointsBefore = await shiftTotal(tx, tech.shiftId);
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
      before: { technicianId: input.technicianId, points: pointsBefore },
      after: { technicianId: input.technicianId, delta, points: pointsBefore + delta },
      reason,
    });
    return { ok: true };
  });
}

/**
 * v0.16.0, "Client left": the visit was called but the service had not started
 * and the client walked out. The desk (receptionist, manager, owner) or the
 * called technician marks it. The call closes as client_left, the visit
 * closes as left, no points post, and the technician keeps her place: she is
 * still available, as before the call. Visits already in service are not
 * touched (they finish or are reassigned as before).
 */
export async function clientLeft(
  db: Db,
  input: {
    visitId: string;
    actor: Actor;
    /** The caller's own location (threat model T10). */
    locationId: string;
    /** Set when the called technician marks it on her phone: it must be her call. */
    technicianId?: string;
  },
): Promise<{ ok: true; technicianId: string } | EngineError> {
  return db.transaction(async (tx) => {
    const [visit] = await tx
      .select()
      .from(visits)
      .where(eq(visits.id, input.visitId))
      .for('update');
    if (!visit) return { ok: false, reason: 'unknown_visit' };
    if (visit.locationId !== input.locationId) return { ok: false, reason: 'wrong_location' };
    if (visit.status !== 'called') return { ok: false, reason: 'not_called' };
    const [call] = await tx
      .select()
      .from(turnCalls)
      .where(and(eq(turnCalls.visitId, visit.id), isNull(turnCalls.respondedAt)))
      .for('update');
    if (!call) return { ok: false, reason: 'not_called' };
    if (input.technicianId && call.technicianId !== input.technicianId) {
      return { ok: false, reason: 'not_your_call' };
    }
    const now = new Date();
    await tx
      .update(turnCalls)
      .set({ respondedAt: now, response: 'client_left' })
      .where(eq(turnCalls.id, call.id));
    await tx
      .update(visits)
      .set({ status: 'left', leftAt: now, updatedAt: now })
      .where(eq(visits.id, visit.id));
    await writeAudit(tx, {
      organizationId: visit.organizationId,
      locationId: visit.locationId,
      actorUserId: input.actor.userId,
      entityType: 'visits',
      entityId: visit.id,
      action: 'client_left',
      after: {
        callId: call.id,
        technicianId: call.technicianId,
        by: input.technicianId ? 'technician' : 'desk',
        points: 0,
      },
    });
    return { ok: true, technicianId: call.technicianId };
  });
}

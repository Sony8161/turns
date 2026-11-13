// Technician status machine, points ledger and audit writes (design doc,
// Technician status machine; threat model T2, T5, T17). Server only: callers
// decide who may act (technician on their own row; the engine in Part 4), this
// module decides what is a legal move and records every move.
//
// Every number comes from rule_config (geofence requirement) or the location
// row (geofence centre and radius); nothing here is hard-coded.
import { and, asc, eq, gte, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { closeOutDay, type DayEndClosed } from './day-end';
import { activeRules, type RuleConfig } from './rules';
import {
  auditLog,
  locations,
  shifts,
  technicianStatus,
  technicians,
  turnCalls,
  turnLedger,
  visits,
} from './schema';
import type { Db } from './server';

export type TechnicianState = 'off' | 'checked_in' | 'available' | 'in_service' | 'break' | 'out';

/** From state → the states a technician (or the engine) may move to. */
export const TRANSITIONS: Record<TechnicianState, readonly TechnicianState[]> = {
  off: ['checked_in'],
  checked_in: ['available', 'off'],
  available: ['in_service', 'break', 'out', 'off'],
  in_service: ['available'],
  break: ['available', 'off'],
  out: ['available', 'off'],
};

export function canTransition(from: TechnicianState, to: TechnicianState): boolean {
  return TRANSITIONS[from].includes(to);
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type Actor = { userId: string | null };

export type StatusError =
  | { ok: false; reason: 'illegal_transition'; from: TechnicianState; to: TechnicianState }
  | { ok: false; reason: 'outside_geofence'; distanceM: number; radiusM: number }
  | { ok: false; reason: 'no_location_fix' }
  | { ok: false; reason: 'poor_location_accuracy'; accuracyM: number; radiusM: number }
  | { ok: false; reason: 'unknown_technician' }
  | { ok: false; reason: 'open_call' };

export type StatusOk = { ok: true; status: TechnicianState; shiftId: string | null };

// Haversine, metres. Good to a few metres at salon scale.
export function distanceMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function loadTechnician(tx: Tx, technicianId: string) {
  const [row] = await tx
    .select({
      id: technicians.id,
      organizationId: technicians.organizationId,
      locationId: technicians.locationId,
      geofenceLat: locations.geofenceLat,
      geofenceLng: locations.geofenceLng,
      geofenceRadiusM: locations.geofenceRadiusM,
      timezone: locations.timezone,
    })
    .from(technicians)
    .innerJoin(locations, eq(locations.id, technicians.locationId))
    .where(eq(technicians.id, technicianId))
    .for('update', { of: technicians });
  return row ?? null;
}

async function currentStatus(tx: Tx, technicianId: string) {
  const [row] = await tx
    .select()
    .from(technicianStatus)
    .where(eq(technicianStatus.technicianId, technicianId))
    .for('update');
  return row ?? null;
}

function localDate(now: Date, timezone: string): string {
  // en-CA gives YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function lateMinutes(now: Date, timezone: string, scheduledStart: string | null): number {
  if (!scheduledStart) return 0;
  const [h = 0, m = 0] = scheduledStart.split(':').map(Number);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const nowH = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const nowM = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return Math.max(0, nowH * 60 + nowM - (h * 60 + m));
}

export async function writeAudit(
  tx: Tx,
  entry: {
    organizationId: string;
    locationId: string;
    actorUserId: string | null;
    entityType: string;
    entityId: string | null;
    action: string;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    organizationId: entry.organizationId,
    locationId: entry.locationId,
    actorUserId: entry.actorUserId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
  });
}

/** Posts one ledger row and its audit entry. The daily total is never stored. */
export async function postPoints(
  tx: Tx,
  entry: {
    organizationId: string;
    locationId: string;
    technicianId: string;
    shiftId: string;
    delta: number;
    reasonType: 'visit' | 'deny' | 'out_over' | 'late' | 'manual';
    visitId?: string | null;
    actorUserId: string | null;
    note?: string | null;
  },
): Promise<string> {
  const [row] = await tx
    .insert(turnLedger)
    .values({
      organizationId: entry.organizationId,
      locationId: entry.locationId,
      technicianId: entry.technicianId,
      shiftId: entry.shiftId,
      delta: entry.delta.toFixed(1),
      reasonType: entry.reasonType,
      visitId: entry.visitId ?? null,
      actorUserId: entry.actorUserId,
      note: entry.note ?? null,
    })
    .returning({ id: turnLedger.id });
  if (!row) throw new Error('ledger insert returned nothing');
  await writeAudit(tx, {
    organizationId: entry.organizationId,
    locationId: entry.locationId,
    actorUserId: entry.actorUserId,
    entityType: 'turn_ledger',
    entityId: row.id,
    action: 'points_posted',
    after: { delta: entry.delta, reasonType: entry.reasonType, visitId: entry.visitId ?? null },
    reason: entry.note ?? null,
  });
  return row.id;
}

/** Sum of a shift's ledger rows: the only source of a technician's daily points. */
export async function shiftTotal(db: Db | Tx, shiftId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${turnLedger.delta}), 0)` })
    .from(turnLedger)
    .where(eq(turnLedger.shiftId, shiftId));
  return Number(row?.total ?? 0);
}

/**
 * Check in: the only move from `off`. Server time, server-side geofence check
 * when the location has one and the rules require being on site. Opens today's
 * shift (or re-joins it after a check-out).
 */
export async function checkIn(
  db: Db,
  input: {
    technicianId: string;
    actor: Actor;
    position: { lat: number; lng: number; accuracyM?: number } | null;
    now?: Date;
  },
): Promise<StatusOk | StatusError> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const tech = await loadTechnician(tx, input.technicianId);
    if (!tech) return { ok: false, reason: 'unknown_technician' };
    const status = await currentStatus(tx, tech.id);
    const from: TechnicianState = status?.status ?? 'off';
    if (!canTransition(from, 'checked_in')) {
      return { ok: false, reason: 'illegal_transition', from, to: 'checked_in' };
    }

    const rules = await activeRules(tx, tech.locationId);
    const eligibility = rules.eligibility;
    const hasFence = tech.geofenceLat != null && tech.geofenceLng != null && !!tech.geofenceRadiusM;
    // The raw report is kept with the result so a dispute can see what the phone
    // said (threat model T5). passed is null when no check could be made.
    const geofence: {
      required: boolean;
      passed: boolean | null;
      reason: 'ok' | 'not_required' | 'no_fence' | null;
      distanceM: number | null;
      radiusM: number | null;
      position: { lat: number; lng: number; accuracyM: number | null } | null;
    } = {
      required: !!eligibility.require_on_site,
      passed: null,
      reason: eligibility.require_on_site ? (hasFence ? null : 'no_fence') : 'not_required',
      distanceM: null,
      radiusM: tech.geofenceRadiusM ?? null,
      position: input.position
        ? {
            lat: input.position.lat,
            lng: input.position.lng,
            accuracyM: input.position.accuracyM ?? null,
          }
        : null,
    };
    if (eligibility.require_on_site && hasFence) {
      const p = input.position;
      if (
        !p ||
        !Number.isFinite(p.lat) ||
        !Number.isFinite(p.lng) ||
        Math.abs(p.lat) > 90 ||
        Math.abs(p.lng) > 180
      ) {
        return { ok: false, reason: 'no_location_fix' };
      }
      const radiusM = tech.geofenceRadiusM!;
      // A fix looser than the fence cannot prove anything.
      if (p.accuracyM != null && p.accuracyM > radiusM) {
        return { ok: false, reason: 'poor_location_accuracy', accuracyM: p.accuracyM, radiusM };
      }
      const distanceM = distanceMetres(p, { lat: tech.geofenceLat!, lng: tech.geofenceLng! });
      geofence.distanceM = distanceM;
      geofence.passed = distanceM <= radiusM;
      geofence.reason = geofence.passed ? 'ok' : null;
      if (!geofence.passed) return { ok: false, reason: 'outside_geofence', distanceM, radiusM };
    }

    const today = localDate(now, tech.timezone);
    let [shift] = await tx
      .select()
      .from(shifts)
      .where(and(eq(shifts.technicianId, tech.id), eq(shifts.date, today)));
    // The day's first check-in: no row yet, or a row made ahead by a schedule
    // that nobody has checked in on. A return after a check-out is not one,
    // so the lateness recorded at the first check-in is kept, not recomputed.
    const firstCheckInToday = !shift || (!shift.readyAt && !shift.checkedOutAt && !status?.shiftId);
    if (!shift) {
      [shift] = await tx
        .insert(shifts)
        .values({
          organizationId: tech.organizationId,
          locationId: tech.locationId,
          technicianId: tech.id,
          date: today,
          checkedInAt: now,
          lateMinutes: 0,
        })
        .returning();
    } else if (shift.checkedOutAt) {
      // Back after a check-out the same day: keep the shift, clear the check-out.
      [shift] = await tx
        .update(shifts)
        .set({ checkedOutAt: null })
        .where(eq(shifts.id, shift.id))
        .returning();
    }
    if (!shift) throw new Error('shift upsert returned nothing');
    const late = firstCheckInToday
      ? lateMinutes(now, tech.timezone, shift.scheduledStart)
      : shift.lateMinutes;
    if (late !== shift.lateMinutes) {
      await tx.update(shifts).set({ lateMinutes: late }).where(eq(shifts.id, shift.id));
    }
    // Part 6: a late start posts the tier's start points, once per shift, at
    // the first check-in of the day. An unset tier (null) posts nothing until
    // the owner decides; the manager can adjust by hand.
    const startPoints = lateStartPoints(rules, late);
    if (startPoints !== null && startPoints !== 0 && firstCheckInToday) {
      const [posted] = await tx
        .select({ id: turnLedger.id })
        .from(turnLedger)
        .where(and(eq(turnLedger.shiftId, shift.id), eq(turnLedger.reasonType, 'late')))
        .limit(1);
      if (!posted) {
        await postPoints(tx, {
          organizationId: tech.organizationId,
          locationId: tech.locationId,
          technicianId: tech.id,
          shiftId: shift.id,
          delta: startPoints,
          reasonType: 'late',
          actorUserId: input.actor.userId,
          note: `${late} min late`,
        });
      }
    }

    await tx
      .insert(technicianStatus)
      .values({
        technicianId: tech.id,
        organizationId: tech.organizationId,
        locationId: tech.locationId,
        status: 'checked_in',
        since: now,
        shiftId: shift.id,
        outStartedAt: null,
        expectedBackAt: null,
      })
      .onConflictDoUpdate({
        target: technicianStatus.technicianId,
        set: {
          status: 'checked_in',
          since: now,
          shiftId: shift.id,
          outStartedAt: null,
          expectedBackAt: null,
          updatedAt: now,
        },
      });
    await writeAudit(tx, {
      organizationId: tech.organizationId,
      locationId: tech.locationId,
      actorUserId: input.actor.userId,
      entityType: 'technician_status',
      entityId: tech.id,
      action: 'check_in',
      before: { status: from },
      after: { status: 'checked_in', shiftId: shift.id, geofence, lateMinutes: late },
    });
    return { ok: true, status: 'checked_in', shiftId: shift.id };
  });
}

/**
 * Every other move. `in_service` in and out is for the engine (Part 4); the
 * technician's own moves are available, break, out and off.
 */
export async function transition(
  db: Db,
  input: {
    technicianId: string;
    to: Exclude<TechnicianState, 'checked_in'>;
    actor: Actor;
    expectedBackAt?: Date | null;
    reason?: string | null;
    now?: Date;
  },
): Promise<StatusOk | StatusError> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const tech = await loadTechnician(tx, input.technicianId);
    if (!tech) return { ok: false, reason: 'unknown_technician' };
    const status = await currentStatus(tx, tech.id);
    const from: TechnicianState = status?.status ?? 'off';
    if (!canTransition(from, input.to)) {
      return { ok: false, reason: 'illegal_transition', from, to: input.to };
    }
    const shiftId = status?.shiftId ?? null;

    // No auto-pass (design doc): a called technician answers before stepping
    // away. Break, out and check-out wait for the call.
    if (input.to === 'break' || input.to === 'out' || input.to === 'off') {
      const [open] = await tx
        .select({ id: turnCalls.id })
        .from(turnCalls)
        .where(and(eq(turnCalls.technicianId, tech.id), isNull(turnCalls.respondedAt)))
        .limit(1);
      if (open) return { ok: false, reason: 'open_call' };
    }

    if (input.to === 'available' && from === 'checked_in' && shiftId) {
      // The readiness checklist: the timestamp is kept on the shift.
      await tx.update(shifts).set({ readyAt: now }).where(eq(shifts.id, shiftId));
    }
    // Part 6: coming back from an out that ran over the limit posts the
    // penalty if the sweep has not already (design doc, Points).
    if (from === 'out' && status?.outStartedAt && shiftId) {
      const rules = await activeRules(tx, tech.locationId);
      await postOutOverIfDue(tx, {
        organizationId: tech.organizationId,
        locationId: tech.locationId,
        technicianId: tech.id,
        shiftId,
        outStartedAt: status.outStartedAt,
        rules,
        now,
      });
    }
    if (input.to === 'off' && shiftId) {
      await tx.update(shifts).set({ checkedOutAt: now }).where(eq(shifts.id, shiftId));
    }

    await tx
      .update(technicianStatus)
      .set({
        status: input.to,
        since: now,
        outStartedAt: input.to === 'out' ? now : null,
        expectedBackAt: input.to === 'out' ? (input.expectedBackAt ?? null) : null,
        shiftId: input.to === 'off' ? null : shiftId,
        updatedAt: now,
      })
      .where(eq(technicianStatus.technicianId, tech.id));
    await writeAudit(tx, {
      organizationId: tech.organizationId,
      locationId: tech.locationId,
      actorUserId: input.actor.userId,
      entityType: 'technician_status',
      entityId: tech.id,
      action: input.to,
      before: { status: from },
      after: { status: input.to, expectedBackAt: input.expectedBackAt ?? null },
      reason: input.reason ?? null,
    });
    return { ok: true, status: input.to, shiftId: input.to === 'off' ? null : shiftId };
  });
}

/** Start points for a late arrival: the highest tier reached, or null when
 *  none is reached or that tier is still unset. Pure. */
export function lateStartPoints(rules: RuleConfig, lateMinutes: number): number | null {
  let hit: number | null | undefined;
  for (const tier of rules.penalties.late_tiers) {
    if (lateMinutes >= tier.after_minutes) hit = tier.start_points;
  }
  return hit === undefined ? null : hit;
}

/** Posts the out-over penalty for one out episode if it is due and not yet
 *  posted. One row per episode: a row of reason out_over after out_started_at. */
async function postOutOverIfDue(
  tx: Tx,
  input: {
    organizationId: string;
    locationId: string;
    technicianId: string;
    shiftId: string;
    outStartedAt: Date;
    rules: RuleConfig;
    now: Date;
  },
): Promise<boolean> {
  const limitMs = input.rules.penalties.out_over_minutes * 60_000;
  if (input.now.getTime() - input.outStartedAt.getTime() < limitMs) return false;
  if (input.rules.penalties.out_over_penalty === 0) return false;
  const [posted] = await tx
    .select({ id: turnLedger.id })
    .from(turnLedger)
    .where(
      and(
        eq(turnLedger.shiftId, input.shiftId),
        eq(turnLedger.reasonType, 'out_over'),
        gte(turnLedger.createdAt, input.outStartedAt),
      ),
    )
    .limit(1);
  if (posted) return false;
  await postPoints(tx, {
    organizationId: input.organizationId,
    locationId: input.locationId,
    technicianId: input.technicianId,
    shiftId: input.shiftId,
    delta: input.rules.penalties.out_over_penalty,
    reasonType: 'out_over',
    actorUserId: null,
    note: `out over ${input.rules.penalties.out_over_minutes} min`,
  });
  return true;
}

/**
 * The floor sweep (Part 6): run when the board or a phone loads. Posts the
 * out-over penalty for anyone still out past the limit, and closes shifts
 * left open from an earlier day (queue.reset daily_at_open): a technician who
 * forgot to check out is checked out, unless they are in service or have an
 * open call. Idempotent; every change is audited.
 *
 * v0.17.0 (DAY-001): first it runs the day-end close-out (day-end.ts), so
 * yesterday's visits, calls and help requests are closed and nobody is left
 * in service or called on a day that is over; then every old shift closes.
 */
export async function sweepFloor(
  db: Db,
  locationId: string,
  now = new Date(),
): Promise<{ outOverPosted: string[]; autoCheckedOut: string[]; closed: DayEndClosed }> {
  return db.transaction(async (tx) => {
    const [loc] = await tx
      .select({ organizationId: locations.organizationId, timezone: locations.timezone })
      .from(locations)
      .where(eq(locations.id, locationId));
    const none = { visits: 0, autoFinished: 0, calls: 0, help: 0 };
    if (!loc) return { outOverPosted: [], autoCheckedOut: [], closed: none };
    const rules = await activeRules(tx, locationId);
    const today = localDate(now, loc.timezone);
    const closed = await closeOutDay(
      tx,
      { id: locationId, organizationId: loc.organizationId, timezone: loc.timezone },
      today,
      rules,
      now,
    );
    const outCutoff = new Date(now.getTime() - rules.penalties.out_over_minutes * 60_000);
    // Scan without locks: a quiet floor touches nothing. Each candidate is
    // then locked in the order transition() uses (technicians, then
    // technician_status) and re-read, so a move saved meanwhile wins and
    // the two can never wait on each other.
    const candidates = await tx
      .select({ technicianId: technicianStatus.technicianId })
      .from(technicianStatus)
      .innerJoin(technicians, eq(technicians.id, technicianStatus.technicianId))
      .leftJoin(shifts, eq(shifts.id, technicianStatus.shiftId))
      .where(
        and(
          eq(technicians.locationId, locationId),
          eq(technicians.active, true),
          ne(technicianStatus.status, 'off'),
          or(
            and(eq(technicianStatus.status, 'out'), lte(technicianStatus.outStartedAt, outCutoff)),
            lt(shifts.date, today),
          ),
        ),
      )
      .orderBy(asc(technicianStatus.technicianId));

    const outOverPosted: string[] = [];
    const autoCheckedOut: string[] = [];
    for (const c of candidates) {
      await tx
        .select({ id: technicians.id })
        .from(technicians)
        .where(eq(technicians.id, c.technicianId))
        .for('update');
      const [r] = await tx
        .select({
          status: technicianStatus.status,
          shiftId: technicianStatus.shiftId,
          outStartedAt: technicianStatus.outStartedAt,
          shiftDate: shifts.date,
          openCall: sql<number>`(select count(*) from ${turnCalls} oc where oc.technician_id = ${technicianStatus.technicianId} and oc.responded_at is null)`,
          // v0.17.0: in service on a visit that is still open (the close-out
          // above closes yesterday's, so this is one from today).
          openVisit: sql<number>`(select count(*) from ${visits} ov where ov.assigned_technician_id = ${technicianStatus.technicianId} and ov.status = 'in_service')`,
        })
        .from(technicianStatus)
        .leftJoin(shifts, eq(shifts.id, technicianStatus.shiftId))
        .where(eq(technicianStatus.technicianId, c.technicianId))
        .for('update', { of: technicianStatus });
      if (!r || r.status === 'off') continue;
      const stale = r.shiftDate !== null && r.shiftDate < today;
      if (stale) {
        // Yesterday's shift: close it (no out-over on a day that is over).
        if (Number(r.openVisit) > 0 || Number(r.openCall) > 0) continue;
        if (r.shiftId) {
          await tx
            .update(shifts)
            .set({ checkedOutAt: now })
            .where(and(eq(shifts.id, r.shiftId), isNull(shifts.checkedOutAt)));
        }
        await tx
          .update(technicianStatus)
          .set({
            status: 'off',
            since: now,
            shiftId: null,
            outStartedAt: null,
            expectedBackAt: null,
            updatedAt: now,
          })
          .where(eq(technicianStatus.technicianId, c.technicianId));
        await writeAudit(tx, {
          organizationId: loc.organizationId,
          locationId,
          actorUserId: null,
          entityType: 'technician_status',
          entityId: c.technicianId,
          action: 'auto_check_out',
          before: { status: r.status, shiftId: r.shiftId, shiftDate: r.shiftDate },
          after: { status: 'off', forDay: r.shiftDate },
          reason: 'shift from an earlier day was still open',
        });
        autoCheckedOut.push(c.technicianId);
        continue;
      }
      if (r.status === 'out' && r.outStartedAt && r.shiftId) {
        const posted = await postOutOverIfDue(tx, {
          organizationId: loc.organizationId,
          locationId,
          technicianId: c.technicianId,
          shiftId: r.shiftId,
          outStartedAt: r.outStartedAt,
          rules,
          now,
        });
        if (posted) outOverPosted.push(c.technicianId);
      }
    }
    return { outOverPosted, autoCheckedOut, closed };
  });
}

/**
 * The last visit posted on the technician's current shift came from an
 * appointment. With `had_appointment_last` in the queue sort, such a
 * technician sorts after one at the same points who did not: 0 before 00.
 * v0.16.0: a nail fix does not count: it is a free redo of earlier work, so
 * it never moves her in the line (a 00 stays 00).
 */
export const HAD_APPOINTMENT_LAST = sql<boolean | null>`(
  select v.source = 'appointment' from ${turnLedger} l
  join ${visits} v on v.id = l.visit_id
  where l.shift_id = ${technicianStatus.shiftId} and l.reason_type = 'visit' and not v.is_fix
  order by l.created_at desc limit 1
)`;

/** Status and today's points for every technician at a location, for the board. */
export async function locationStatus(db: Db, locationId: string) {
  const rows = await db
    .select({
      technicianId: technicians.id,
      displayName: technicians.displayName,
      status: technicianStatus.status,
      since: technicianStatus.since,
      shiftId: technicianStatus.shiftId,
      expectedBackAt: technicianStatus.expectedBackAt,
      checkedInAt: shifts.checkedInAt,
      points: sql<string>`coalesce((select sum(${turnLedger.delta}) from ${turnLedger} where ${turnLedger.shiftId} = ${technicianStatus.shiftId}), 0)`,
      hadAppointmentLast: HAD_APPOINTMENT_LAST,
    })
    .from(technicians)
    .leftJoin(technicianStatus, eq(technicianStatus.technicianId, technicians.id))
    .leftJoin(shifts, eq(shifts.id, technicianStatus.shiftId))
    .where(and(eq(technicians.locationId, locationId), eq(technicians.active, true)));
  return rows.map((r) => ({
    ...r,
    status: (r.status ?? 'off') as TechnicianState,
    points: Number(r.points),
    hadAppointmentLast: r.hadAppointmentLast === true,
  }));
}

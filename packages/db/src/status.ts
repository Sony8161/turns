// Technician status machine, points ledger and audit writes (design doc,
// Technician status machine; threat model T2, T5, T17). Server only: callers
// decide who may act (technician on their own row; the engine in Part 4), this
// module decides what is a legal move and records every move.
//
// Every number comes from rule_config (geofence requirement) or the location
// row (geofence centre and radius); nothing here is hard-coded.
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  auditLog,
  locations,
  ruleConfigs,
  shifts,
  technicianStatus,
  technicians,
  turnLedger,
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
  | { ok: false; reason: 'unknown_technician' };

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

async function activeRuleConfig(tx: Tx, locationId: string): Promise<Record<string, unknown>> {
  const [row] = await tx
    .select({ config: ruleConfigs.config })
    .from(ruleConfigs)
    .where(eq(ruleConfigs.locationId, locationId))
    .orderBy(desc(ruleConfigs.version))
    .limit(1);
  return (row?.config as Record<string, unknown>) ?? {};
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

    const rules = await activeRuleConfig(tx, tech.locationId);
    const eligibility = (rules.eligibility ?? {}) as { require_on_site?: boolean };
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
    const late = lateMinutes(now, tech.timezone, shift.scheduledStart);
    if (late !== shift.lateMinutes && !shift.readyAt) {
      await tx.update(shifts).set({ lateMinutes: late }).where(eq(shifts.id, shift.id));
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

    if (input.to === 'available' && from === 'checked_in' && shiftId) {
      // The readiness checklist: the timestamp is kept on the shift.
      await tx.update(shifts).set({ readyAt: now }).where(eq(shifts.id, shiftId));
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
    })
    .from(technicians)
    .leftJoin(technicianStatus, eq(technicianStatus.technicianId, technicians.id))
    .leftJoin(shifts, eq(shifts.id, technicianStatus.shiftId))
    .where(and(eq(technicians.locationId, locationId), eq(technicians.active, true)));
  return rows.map((r) => ({
    ...r,
    status: (r.status ?? 'off') as TechnicianState,
    points: Number(r.points),
  }));
}

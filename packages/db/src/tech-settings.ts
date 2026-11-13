// A technician's settings screen (v0.13.0, Duong 2026-11-12): owners,
// managers and, unless the owner turns it off, receptionists change a
// technician's status today, adjust their points with a reason, and edit
// skills, tags and restrictions. Technicians never can. The check lives here,
// next to the writes, so no screen can skip it; every change is audited with
// before and after (status: status.ts; points: engine.ts; profile: profile.ts).
import { and, eq } from 'drizzle-orm';
import { adjustPoints, type EngineError } from './engine';
import type { Role } from './invites';
import { allowedAt } from './permissions';
import { locations, technicianStatus, technicians, visits } from './schema';
import type { Db } from './server';
import type { StaffActor } from './staff';
import {
  checkIn,
  transition,
  writeAudit,
  type StatusError,
  type StatusOk,
  type TechnicianState,
} from './status';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Does this location let receptionists change technicians? (Default yes.) */
export async function receptionistMayEdit(db: Db | Tx, locationId: string): Promise<boolean> {
  const [row] = await db
    .select({ on: locations.receptionistEditsTechnicians })
    .from(locations)
    .where(eq(locations.id, locationId));
  return row?.on ?? false;
}

/** Owners and managers always; receptionists when the location allows it.
 *  v0.17.1: the shared permissions table decides (permissions.ts). */
export async function mayEditTechnicians(
  db: Db | Tx,
  actor: { role: Role; locationId: string },
): Promise<boolean> {
  return allowedAt(db, actor, 'edit_technicians');
}

/** The owner switches receptionist edits on or off for their location. */
export async function setReceptionistEdits(
  db: Db,
  input: { actor: StaffActor; on: boolean },
): Promise<{ ok: true } | { ok: false; reason: 'not_allowed' }> {
  if (input.actor.role !== 'owner') return { ok: false, reason: 'not_allowed' };
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ on: locations.receptionistEditsTechnicians })
      .from(locations)
      .where(
        and(
          eq(locations.id, input.actor.locationId),
          eq(locations.organizationId, input.actor.organizationId),
        ),
      )
      .for('update');
    if (!before) return { ok: false as const, reason: 'not_allowed' as const };
    if (before.on === input.on) return { ok: true as const };
    await tx
      .update(locations)
      .set({ receptionistEditsTechnicians: input.on, updatedAt: new Date() })
      .where(eq(locations.id, input.actor.locationId));
    await writeAudit(tx, {
      organizationId: input.actor.organizationId,
      locationId: input.actor.locationId,
      actorUserId: input.actor.userId,
      entityType: 'locations',
      entityId: input.actor.locationId,
      action: 'technician_edits_setting',
      before: { receptionistEditsTechnicians: before.on },
      after: { receptionistEditsTechnicians: input.on },
    });
    return { ok: true as const };
  });
}

type Refused = {
  ok: false;
  reason: 'not_allowed' | 'wrong_location' | 'unknown_technician' | 'in_service';
};

async function techHere(db: Db, actor: StaffActor, technicianId: string) {
  const [t] = await db
    .select({
      id: technicians.id,
      locationId: technicians.locationId,
      orgId: technicians.organizationId,
    })
    .from(technicians)
    .where(and(eq(technicians.id, technicianId), eq(technicians.active, true)));
  if (!t) return { ok: false as const, reason: 'unknown_technician' as const };
  if (t.locationId !== actor.locationId || t.orgId !== actor.organizationId) {
    return { ok: false as const, reason: 'wrong_location' as const };
  }
  return { ok: true as const };
}

/** The moves the desk may make for a technician today. In service is the
 *  engine's (accept and finish), never set by hand. */
export const STAFF_STATUS_MOVES = ['checked_in', 'available', 'break', 'out', 'off'] as const;
export type StaffStatusMove = (typeof STAFF_STATUS_MOVES)[number];

/**
 * Sets a technician's status for them (a phone that died, a forgotten tap).
 * The same rules as the technician's own taps: an open call blocks a break,
 * an out over the limit posts its penalty on the way back. The audit row
 * names the staff member who did it.
 */
export async function staffSetStatus(
  db: Db,
  input: { actor: StaffActor; technicianId: string; to: StaffStatusMove; reason?: string | null },
): Promise<StatusOk | StatusError | Refused> {
  if (!(await mayEditTechnicians(db, input.actor))) return { ok: false, reason: 'not_allowed' };
  if (!(STAFF_STATUS_MOVES as readonly string[]).includes(input.to)) {
    return { ok: false, reason: 'not_allowed' };
  }
  const here = await techHere(db, input.actor, input.technicianId);
  if (!here.ok) return here;
  // v0.17.0 (review #1): while she is with a client her status follows the
  // visit. Setting it by hand left the visit open for good; finish it first
  // (the desk can press Finish for her).
  const [busy] = await db
    .select({ id: visits.id })
    .from(visits)
    .where(
      and(eq(visits.assignedTechnicianId, input.technicianId), eq(visits.status, 'in_service')),
    )
    .limit(1);
  if (busy || (await statusOf(db, input.technicianId)) === 'in_service') {
    return { ok: false, reason: 'in_service' };
  }
  const reason = input.reason?.trim().slice(0, 300) || 'set by staff';
  if (input.to === 'checked_in') {
    return checkIn(db, {
      technicianId: input.technicianId,
      actor: { userId: input.actor.userId },
      position: null,
    });
  }
  return transition(db, {
    technicianId: input.technicianId,
    to: input.to as Exclude<TechnicianState, 'checked_in'>,
    actor: { userId: input.actor.userId },
    reason,
  });
}

/** Adds or removes points with a reason (engine.adjustPoints), for anyone who
 *  may edit technicians. Half steps; never one's own points. */
export async function staffAdjustPoints(
  db: Db,
  input: { actor: StaffActor; technicianId: string; delta: number; reason: string },
): Promise<{ ok: true } | EngineError | Refused> {
  if (!(await allowedAt(db, input.actor, 'adjust_points'))) {
    return { ok: false, reason: 'not_allowed' };
  }
  return adjustPoints(db, {
    technicianId: input.technicianId,
    delta: input.delta,
    reason: input.reason,
    actor: {
      userId: input.actor.userId,
      organizationId: input.actor.organizationId,
      locationId: input.actor.locationId,
    },
  });
}

/** Today's status of one technician, for the settings screen. */
export async function statusOf(db: Db, technicianId: string): Promise<TechnicianState> {
  const [row] = await db
    .select({ status: technicianStatus.status })
    .from(technicianStatus)
    .where(eq(technicianStatus.technicianId, technicianId));
  return (row?.status ?? 'off') as TechnicianState;
}

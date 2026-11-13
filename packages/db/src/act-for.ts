// v0.17.0 (DESK-001): the desk acts for a technician whose phone is not to
// hand. Accept (which starts the service, as on her phone), deny with a
// reason under the same penalty rules, and finish. Owners and managers
// always; receptionists while the owner leaves the switch on (default on,
// Staff page). The check lives here, next to the writes, so no screen can
// skip it. Every move is the engine's own move with `onBehalf`: the audit row
// names the desk person as the actor and the technician in after.actedFor,
// and her phone lists today's moves made for her (actedForToday).
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { finishVisit, respondToCall, type EngineError } from './engine';
import type { Role } from './invites';
import type { DenyReason } from './rules';
import { auditLog, locations, profiles, technicians, turnCalls, visits } from './schema';
import type { Db } from './server';
import type { StaffActor } from './staff';
import { writeAudit } from './status';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Refused = { ok: false; reason: 'not_allowed' | 'wrong_location' };

/** Owners and managers always; receptionists when the location allows it. */
export async function mayActForTechnicians(
  db: Db | Tx,
  actor: { role: Role; locationId: string },
): Promise<boolean> {
  if (actor.role === 'owner' || actor.role === 'manager') return true;
  if (actor.role !== 'receptionist') return false;
  const [row] = await db
    .select({ on: locations.receptionistActsForTechnicians })
    .from(locations)
    .where(eq(locations.id, actor.locationId));
  return row?.on ?? false;
}

/** Does this location let receptionists act for technicians? (Default yes.) */
export async function receptionistMayActFor(db: Db | Tx, locationId: string): Promise<boolean> {
  const [row] = await db
    .select({ on: locations.receptionistActsForTechnicians })
    .from(locations)
    .where(eq(locations.id, locationId));
  return row?.on ?? false;
}

/** The owner switches it on or off for their location (audited). */
export async function setReceptionistActsFor(
  db: Db,
  input: { actor: StaffActor; on: boolean },
): Promise<{ ok: true } | { ok: false; reason: 'not_allowed' }> {
  if (input.actor.role !== 'owner') return { ok: false, reason: 'not_allowed' };
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ on: locations.receptionistActsForTechnicians })
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
      .set({ receptionistActsForTechnicians: input.on, updatedAt: new Date() })
      .where(eq(locations.id, input.actor.locationId));
    await writeAudit(tx, {
      organizationId: input.actor.organizationId,
      locationId: input.actor.locationId,
      actorUserId: input.actor.userId,
      entityType: 'locations',
      entityId: input.actor.locationId,
      action: 'act_for_setting',
      before: { receptionistActsForTechnicians: before.on },
      after: { receptionistActsForTechnicians: input.on },
    });
    return { ok: true as const };
  });
}

/** The desk answers a call for the called technician: accept or deny. */
export async function deskAnswerCall(
  db: Db,
  input: {
    actor: StaffActor;
    callId: string;
    response: 'accepted' | 'denied';
    denyReason?: DenyReason;
    keepServiceIds?: string[];
  },
): Promise<{ ok: true; splitVisitId?: string } | EngineError | Refused> {
  if (!(await mayActForTechnicians(db, input.actor))) return { ok: false, reason: 'not_allowed' };
  const [call] = await db
    .select({ technicianId: turnCalls.technicianId, locationId: turnCalls.locationId })
    .from(turnCalls)
    .where(eq(turnCalls.id, input.callId));
  if (!call) return { ok: false, reason: 'unknown_call' };
  if (call.locationId !== input.actor.locationId) return { ok: false, reason: 'wrong_location' };
  if (input.response === 'denied' && !input.denyReason) {
    return { ok: false, reason: 'bad_deny_reason' };
  }
  return respondToCall(db, {
    callId: input.callId,
    technicianId: call.technicianId,
    response: input.response,
    ...(input.denyReason ? { denyReason: input.denyReason } : {}),
    ...(input.keepServiceIds ? { keepServiceIds: input.keepServiceIds } : {}),
    actor: { userId: input.actor.userId },
    onBehalf: true,
  });
}

/** The desk presses Finished for a technician: her visit in service ends,
 *  points post on her shift exactly as from her phone. */
export async function deskFinishVisit(
  db: Db,
  input: { actor: StaffActor; technicianId: string; visitId?: string },
): Promise<{ ok: true; points: number } | EngineError | Refused> {
  if (!(await mayActForTechnicians(db, input.actor))) return { ok: false, reason: 'not_allowed' };
  const [tech] = await db
    .select({ locationId: technicians.locationId })
    .from(technicians)
    .where(eq(technicians.id, input.technicianId));
  if (!tech) return { ok: false, reason: 'unknown_technician' };
  if (tech.locationId !== input.actor.locationId) return { ok: false, reason: 'wrong_location' };
  return finishVisit(db, {
    technicianId: input.technicianId,
    ...(input.visitId ? { visitId: input.visitId } : {}),
    actor: { userId: input.actor.userId },
    onBehalf: true,
  });
}

/** What the desk did for her today, for her phone: "Accepted for you by Hạnh, 2:14 PM". */
export type ActedFor = {
  what: 'accepted' | 'denied' | 'declined' | 'finished';
  /** The desk person's display name. */
  by: string | null;
  at: Date;
  /** For a deny: the reason the desk picked. */
  reason?: string;
};

const ACTED_ACTIONS: Record<string, ActedFor['what']> = {
  call_accepted: 'accepted',
  offer_accepted: 'accepted',
  call_denied: 'denied',
  offer_declined: 'declined',
  desk_pick_declined: 'declined',
  visit_completed: 'finished',
};

export async function actedForToday(
  db: Db,
  technicianId: string,
  now = new Date(),
): Promise<ActedFor[]> {
  const [tech] = await db
    .select({ locationId: technicians.locationId, timezone: locations.timezone })
    .from(technicians)
    .innerJoin(locations, eq(locations.id, technicians.locationId))
    .where(eq(technicians.id, technicianId));
  if (!tech) return [];
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: tech.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const rows = await db
    .select({
      action: auditLog.action,
      at: auditLog.at,
      by: profiles.displayName,
      reason: sql<string | null>`${auditLog.after}->>'denyReason'`,
    })
    .from(auditLog)
    .leftJoin(profiles, eq(profiles.id, auditLog.actorUserId))
    .where(
      and(
        eq(auditLog.locationId, tech.locationId),
        inArray(auditLog.action, Object.keys(ACTED_ACTIONS)),
        sql`${auditLog.after}->>'actedFor' = ${technicianId}`,
        gte(auditLog.at, sql`(${day}::date::timestamp at time zone ${tech.timezone})`),
      ),
    )
    .orderBy(asc(auditLog.at), asc(auditLog.id));
  return rows.map((r) => ({
    what: ACTED_ACTIONS[r.action]!,
    by: r.by,
    at: r.at,
    ...(r.reason ? { reason: r.reason } : {}),
  }));
}

/** The visit this technician has in service, for a desk "Finish for her". */
export async function inServiceVisitOf(db: Db, technicianId: string) {
  const [v] = await db
    .select({ id: visits.id })
    .from(visits)
    .where(and(eq(visits.assignedTechnicianId, technicianId), eq(visits.status, 'in_service')));
  return v?.id ?? null;
}

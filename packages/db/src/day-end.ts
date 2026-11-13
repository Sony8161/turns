// v0.17.0 (DAY-001): the day-end close-out. Run from the floor sweep (every
// board or phone load) and from the nightly job, before the end-of-day
// summary is written. Whatever an earlier local day left open is closed so
// the next morning starts on a clean board:
//  - waiting, called, unconfirmed (kiosk) and pending (fix approval) visits,
//    held second parts and request holds close as "closed at day end"
//    (cancelled, close_reason day_end): no points, no penalty to anyone;
//  - a visit still in service is finished and its points post to that day's
//    shift, marked auto-finished (rules: closing.day_end_in_service; 'close'
//    closes it with no points instead);
//  - open calls close as expired, with no penalty;
//  - open help requests close;
//  - v0.18.0 (F1): finished visits still on the "To check out" list are
//    cleared (checked_out_at set, checked_out_by null), when the list is on.
// Shifts are then checked out by the sweep. Every change is audited with the
// day it belonged to (after.forDay), which the end-of-day summary counts.
// Idempotent: a second run finds nothing. Server only.
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { visitPointsUnder, type RuleConfig } from './rules';
import {
  helpRequests,
  locations,
  serviceCategories,
  services,
  shifts,
  technicianStatus,
  turnCalls,
  visitServices,
  visits,
} from './schema';
import type { Db } from './server';
import { postPoints, writeAudit } from './status';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type DayEndClosed = {
  visits: number;
  autoFinished: number;
  calls: number;
  help: number;
  /** v0.18.0: finished visits nobody checked out. */
  checkouts: number;
};

/** The audit actions the close-out writes; the summary counts them by day. */
export const DAY_END_ACTIONS = [
  'visit_closed_day_end',
  'visit_auto_finished',
  'call_closed_day_end',
  'help_closed_day_end',
  'auto_check_out',
  'checkout_closed_day_end',
] as const;

const localDay = (col: unknown, tz: string) =>
  sql<string>`to_char((${col} at time zone ${tz})::date, 'YYYY-MM-DD')`;
const beforeDay = (col: unknown, tz: string, today: string) =>
  sql`(${col} at time zone ${tz})::date < ${today}::date`;

export async function closeOutDay(
  tx: Tx,
  loc: { id: string; organizationId: string; timezone: string },
  today: string,
  rules: RuleConfig,
  now: Date,
): Promise<DayEndClosed> {
  const tz = loc.timezone;
  const out: DayEndClosed = { visits: 0, autoFinished: 0, calls: 0, help: 0, checkouts: 0 };

  // Visits first, then their calls: the lock order of the engine.
  const old = await tx
    .select({
      id: visits.id,
      status: visits.status,
      source: visits.source,
      assignedTechnicianId: visits.assignedTechnicianId,
      needsConfirm: visits.needsConfirm,
      needsApproval: visits.needsApproval,
      requestedTechnicianId: visits.requestedTechnicianId,
      splitFromVisitId: visits.splitFromVisitId,
      forDay: localDay(visits.arrivedAt, tz),
      startDay: localDay(sql`coalesce(${visits.startedAt}, ${visits.arrivedAt})`, tz),
    })
    .from(visits)
    .where(
      and(
        eq(visits.locationId, loc.id),
        inArray(visits.status, ['waiting', 'called', 'in_service']),
        beforeDay(visits.arrivedAt, tz, today),
      ),
    )
    .orderBy(visits.id)
    .for('update');

  // Every open call from an earlier day, and any open call on a visit that
  // closes now (a call made after midnight for yesterday's client).
  const oldIds = old.map((v) => v.id);
  const calls = await tx
    .select({
      id: turnCalls.id,
      visitId: turnCalls.visitId,
      technicianId: turnCalls.technicianId,
      forDay: localDay(turnCalls.calledAt, tz),
    })
    .from(turnCalls)
    .where(
      and(
        eq(turnCalls.locationId, loc.id),
        isNull(turnCalls.respondedAt),
        oldIds.length
          ? or(beforeDay(turnCalls.calledAt, tz, today), inArray(turnCalls.visitId, oldIds))
          : beforeDay(turnCalls.calledAt, tz, today),
      ),
    )
    .orderBy(turnCalls.id)
    .for('update');
  for (const c of calls) {
    await tx
      .update(turnCalls)
      .set({ respondedAt: now, response: 'expired' })
      .where(eq(turnCalls.id, c.id));
    await writeAudit(tx, {
      organizationId: loc.organizationId,
      locationId: loc.id,
      actorUserId: null,
      entityType: 'turn_calls',
      entityId: c.id,
      action: 'call_closed_day_end',
      after: { visitId: c.visitId, technicianId: c.technicianId, forDay: c.forDay, penalty: 0 },
      reason: 'day ended',
    });
    out.calls++;
  }

  const freed = new Set<string>();
  for (const v of old) {
    if (v.status === 'in_service' && rules.closing.day_end_in_service === 'finish') {
      const items = await tx
        .select({
          isFillOrFullSet: serviceCategories.isFillOrFullSet,
          categoryId: serviceCategories.id,
          serviceId: visitServices.serviceId,
          isFix: services.isFix,
        })
        .from(visitServices)
        .innerJoin(services, eq(services.id, visitServices.serviceId))
        .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
        .where(eq(visitServices.visitId, v.id));
      const points = visitPointsUnder(rules, items, v.source);
      // Her shift on the day the service started; else the one she is on.
      const techId = v.assignedTechnicianId;
      let shiftId: string | null = null;
      if (techId) {
        const [s] = await tx
          .select({ id: shifts.id })
          .from(shifts)
          .where(and(eq(shifts.technicianId, techId), eq(shifts.date, v.startDay)));
        shiftId = s?.id ?? null;
        if (!shiftId) {
          const [st] = await tx
            .select({ shiftId: technicianStatus.shiftId })
            .from(technicianStatus)
            .where(eq(technicianStatus.technicianId, techId));
          shiftId = st?.shiftId ?? null;
        }
      }
      if (techId && shiftId) {
        await postPoints(tx, {
          organizationId: loc.organizationId,
          locationId: loc.id,
          technicianId: techId,
          shiftId,
          delta: points,
          reasonType: 'visit',
          visitId: v.id,
          actorUserId: null,
          note: 'auto-finished at day end',
        });
      }
      await tx
        .update(visits)
        .set({
          status: 'completed',
          completedAt: now,
          pointsPosted: points.toFixed(1),
          autoFinished: true,
          // v0.18.0: closed by the day end, so it never lands on the next
          // day's "To check out" list.
          checkedOutAt: now,
          updatedAt: now,
        })
        .where(eq(visits.id, v.id));
      await writeAudit(tx, {
        organizationId: loc.organizationId,
        locationId: loc.id,
        actorUserId: null,
        entityType: 'visits',
        entityId: v.id,
        action: 'visit_auto_finished',
        after: { technicianId: techId, points, forDay: v.startDay, shiftId },
        reason: 'still in service when the day ended',
      });
      out.autoFinished++;
    } else {
      await tx
        .update(visits)
        .set({ status: 'cancelled', cancelledAt: now, closeReason: 'day_end', updatedAt: now })
        .where(eq(visits.id, v.id));
      await writeAudit(tx, {
        organizationId: loc.organizationId,
        locationId: loc.id,
        actorUserId: null,
        entityType: 'visits',
        entityId: v.id,
        action: 'visit_closed_day_end',
        after: {
          was: v.status,
          forDay: v.forDay,
          points: 0,
          ...(v.needsConfirm ? { unconfirmed: true } : {}),
          ...(v.needsApproval ? { pendingFix: true } : {}),
          ...(v.requestedTechnicianId && v.status === 'waiting' ? { requestHold: true } : {}),
          ...(v.splitFromVisitId ? { heldPart: true } : {}),
        },
        reason: 'day ended',
      });
      out.visits++;
    }
    if (v.status === 'in_service' && v.assignedTechnicianId) freed.add(v.assignedTechnicianId);
  }

  // A technician whose in-service visit closed is not in service any more.
  // On a shift from an earlier day the sweep checks her out next (its audit
  // row says she was in service); on today's shift she is available again.
  for (const techId of [...freed].sort()) {
    const [other] = await tx
      .select({ id: visits.id })
      .from(visits)
      .where(and(eq(visits.assignedTechnicianId, techId), eq(visits.status, 'in_service')))
      .limit(1);
    if (other) continue;
    const [st] = await tx
      .select({ status: technicianStatus.status, shiftDate: shifts.date })
      .from(technicianStatus)
      .leftJoin(shifts, eq(shifts.id, technicianStatus.shiftId))
      .where(eq(technicianStatus.technicianId, techId))
      .for('update', { of: technicianStatus });
    if (st?.status !== 'in_service' || !st.shiftDate || st.shiftDate < today) continue;
    await tx
      .update(technicianStatus)
      .set({ status: 'available', since: now, updatedAt: now })
      .where(eq(technicianStatus.technicianId, techId));
    await writeAudit(tx, {
      organizationId: loc.organizationId,
      locationId: loc.id,
      actorUserId: null,
      entityType: 'technician_status',
      entityId: techId,
      action: 'available',
      before: { status: 'in_service' },
      after: { status: 'available' },
      reason: 'day ended',
    });
  }

  const help = await tx
    .select({
      id: helpRequests.id,
      technicianId: helpRequests.technicianId,
      forDay: localDay(helpRequests.createdAt, tz),
    })
    .from(helpRequests)
    .where(
      and(
        eq(helpRequests.locationId, loc.id),
        isNull(helpRequests.acknowledgedAt),
        beforeDay(helpRequests.createdAt, tz, today),
      ),
    )
    .for('update');
  for (const h of help) {
    await tx.update(helpRequests).set({ acknowledgedAt: now }).where(eq(helpRequests.id, h.id));
    await writeAudit(tx, {
      organizationId: loc.organizationId,
      locationId: loc.id,
      actorUserId: null,
      entityType: 'help_requests',
      entityId: h.id,
      action: 'help_closed_day_end',
      after: { technicianId: h.technicianId, forDay: h.forDay },
      reason: 'day ended',
    });
    out.help++;
  }

  // v0.18.0 (F1): an earlier day's finished visits still waiting on the
  // desk's "To check out" list. Only while the list is on: with it off
  // nothing waits there.
  const [list] = await tx
    .select({ on: locations.checkoutList })
    .from(locations)
    .where(eq(locations.id, loc.id));
  if (list?.on) {
    const unchecked = await tx
      .select({ id: visits.id, forDay: localDay(visits.completedAt, tz) })
      .from(visits)
      .where(
        and(
          eq(visits.locationId, loc.id),
          eq(visits.status, 'completed'),
          isNull(visits.checkedOutAt),
          beforeDay(visits.completedAt, tz, today),
        ),
      )
      .orderBy(visits.id)
      .for('update');
    for (const v of unchecked) {
      await tx.update(visits).set({ checkedOutAt: now, updatedAt: now }).where(eq(visits.id, v.id));
      await writeAudit(tx, {
        organizationId: loc.organizationId,
        locationId: loc.id,
        actorUserId: null,
        entityType: 'visits',
        entityId: v.id,
        action: 'checkout_closed_day_end',
        after: { forDay: v.forDay },
        reason: 'day ended',
      });
      out.checkouts++;
    }
  }
  return out;
}

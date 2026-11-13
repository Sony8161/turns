// v0.16.0 (Duong, 2026-11-12): a nail fix or repair. Free (0 points, rules
// by_service), desk only (never on the kiosk). The desk looks the client up
// and sees their visits inside the fix window (rules: fixes.window_days,
// Heavenly 14). A receptionist's fix waits for a manager or owner to approve
// it (rules: fixes.receptionist_needs_approval); a manager's or owner's is
// approved at once (engine.createWalkIn). The desk picks the technician, the
// one who did the original work first when she is in; saying no is never a
// penalty (a desk pick). Every step is audited, never with a client's name or
// phone (T11). Server only.
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  consumeClientLookup,
  nameParts,
  parseClientQuery,
  shortName,
  type ClientViewer,
} from './clients';
import type { ManagerActor } from './engine';
import { can } from './permissions';
import { localDate } from './reports';
import { activeRules } from './rules';
import {
  clients,
  locations,
  services,
  technicianStatus,
  technicians,
  visitServices,
  visits,
} from './schema';
import type { Db } from './server';
import { writeAudit } from './status';

export type FixCandidate = {
  visitId: string;
  clientId: string;
  /** "Lan N.": the desk's screen only. */
  client: string | null;
  at: Date;
  services: string[];
  technicianId: string | null;
  technician: string | null;
  /** She is checked in today: the desk can pick her for the fix. */
  technicianWorking: boolean;
};

const likeSafe = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The client's completed visits inside the fix window, newest first, for a
 * phone (4+ digits) or a name (3+ letters) typed at the desk. Up to 10 rows. An empty list
 * is the "no visit in the window" warning; the fix can still be entered.
 */
export async function fixCandidates(
  db: Db,
  input: { locationId: string; query: string; now?: Date },
): Promise<{ windowDays: number; visits: FixCandidate[] }> {
  const rules = await activeRules(db, input.locationId);
  const windowDays = rules.fixes.window_days;
  const parsed = parseClientQuery(input.query);
  if (!parsed) return { windowDays, visits: [] };
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60_000);
  const match =
    'phone' in parsed
      ? sql`${clients.phone} like ${`%${likeSafe(parsed.phone)}%`}`
      : sql`(${clients.searchName} like ${`${likeSafe(parsed.name)}%`} or ${clients.searchName} like ${`% ${likeSafe(parsed.name)}%`})`;
  const rows = await db
    .select({
      visitId: visits.id,
      clientId: clients.id,
      firstName: clients.firstName,
      lastName: clients.lastName,
      name: clients.name,
      at: visits.arrivedAt,
      technicianId: visits.assignedTechnicianId,
      technician: technicians.displayName,
      working: sql<boolean>`coalesce(${technicianStatus.status} <> 'off', false)`,
    })
    .from(visits)
    .innerJoin(clients, eq(clients.id, visits.clientId))
    .leftJoin(technicians, eq(technicians.id, visits.assignedTechnicianId))
    .leftJoin(technicianStatus, eq(technicianStatus.technicianId, visits.assignedTechnicianId))
    .where(
      and(
        eq(visits.locationId, input.locationId),
        eq(visits.status, 'completed'),
        eq(visits.isFix, false),
        gte(visits.arrivedAt, since),
        lte(visits.arrivedAt, now),
        isNull(clients.anonymisedAt),
        match,
      ),
    )
    .orderBy(desc(visits.arrivedAt))
    .limit(10);
  const items = rows.length
    ? await db
        .select({ visitId: visitServices.visitId, name: services.name })
        .from(visitServices)
        .innerJoin(services, eq(services.id, visitServices.serviceId))
        .where(
          inArray(
            visitServices.visitId,
            rows.map((r) => r.visitId),
          ),
        )
        .orderBy(asc(services.name))
    : [];
  return {
    windowDays,
    visits: rows.map((r) => {
      const parts =
        r.firstName || r.lastName
          ? { firstName: r.firstName, lastName: r.lastName }
          : nameParts({ name: r.name });
      return {
        visitId: r.visitId,
        clientId: r.clientId,
        client: shortName(parts.firstName, parts.lastName),
        at: r.at,
        services: items.filter((i) => i.visitId === r.visitId).map((i) => i.name),
        technicianId: r.technicianId,
        technician: r.technician,
        technicianWorking: r.working === true,
      };
    }),
  };
}

/**
 * v0.17.1 (review #4): the desk's fix lookup, counted against the same
 * per-person budget as client search and client pages (clients.ts), so it
 * cannot be used to page through the client list either.
 */
export async function findFixVisits(
  db: Db,
  input: { viewer: ClientViewer; query: string; now?: Date },
): Promise<
  | { ok: true; windowDays: number; visits: FixCandidate[] }
  | { ok: false; reason: 'not_allowed' | 'too_many' }
> {
  if (!can(input.viewer.role, 'enter_walkins')) return { ok: false, reason: 'not_allowed' };
  // Too short to be a lookup: the window only, nothing counted.
  if (!parseClientQuery(input.query)) {
    const rules = await activeRules(db, input.viewer.locationId);
    return { ok: true, windowDays: rules.fixes.window_days, visits: [] };
  }
  if (!(await consumeClientLookup(db, input.viewer.userId))) {
    return { ok: false, reason: 'too_many' };
  }
  const found = await fixCandidates(db, {
    locationId: input.viewer.locationId,
    query: input.query,
    ...(input.now ? { now: input.now } : {}),
  });
  return { ok: true, ...found };
}

export type FixDecision = 'approve' | 'decline';

/**
 * A manager or owner approves a receptionist's fix (it may then go to a
 * technician) or declines it (the visit is cancelled). The web checks the
 * role; this checks the location. The audit row says whether the desk had
 * found a visit in the window, so an approval past the warning is on record.
 */
export async function reviewFix(
  db: Db,
  input: { actor: ManagerActor; visitId: string; decision: FixDecision; now?: Date },
): Promise<
  { ok: true } | { ok: false; reason: 'unknown_visit' | 'wrong_location' | 'not_pending' }
> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [visit] = await tx
      .select({
        id: visits.id,
        organizationId: visits.organizationId,
        locationId: visits.locationId,
        status: visits.status,
        needsApproval: visits.needsApproval,
        fixOfVisitId: visits.fixOfVisitId,
      })
      .from(visits)
      .where(eq(visits.id, input.visitId))
      .for('update');
    if (!visit) return { ok: false as const, reason: 'unknown_visit' as const };
    if (
      visit.locationId !== input.actor.locationId ||
      visit.organizationId !== input.actor.organizationId
    ) {
      return { ok: false as const, reason: 'wrong_location' as const };
    }
    if (!visit.needsApproval || visit.status !== 'waiting') {
      return { ok: false as const, reason: 'not_pending' as const };
    }
    if (input.decision === 'decline') {
      await tx
        .update(visits)
        .set({ needsApproval: false, status: 'cancelled', cancelledAt: now, updatedAt: now })
        .where(eq(visits.id, visit.id));
    } else {
      await tx
        .update(visits)
        .set({
          needsApproval: false,
          approvedBy: input.actor.userId,
          approvedAt: now,
          updatedAt: now,
        })
        .where(eq(visits.id, visit.id));
    }
    await writeAudit(tx, {
      organizationId: visit.organizationId,
      locationId: visit.locationId,
      actorUserId: input.actor.userId,
      entityType: 'visits',
      entityId: visit.id,
      action: input.decision === 'approve' ? 'fix_approved' : 'fix_declined',
      after: { fixOfVisitId: visit.fixOfVisitId, inWindow: visit.fixOfVisitId !== null },
    });
    return { ok: true as const };
  });
}

export type FixReportRow = {
  technicianId: string | null;
  /** Who did the original work; null = no visit was found in the window. */
  technician: string | null;
  fixes: number;
  /** Of those, done by the same technician. */
  doneBySameTech: number;
};

/**
 * Reports: fixes per original technician for one local date (approved or
 * done; declined fixes are not counted). Owners and managers read it.
 */
export async function fixesByOriginalTech(
  db: Db,
  locationId: string,
  date: string,
): Promise<FixReportRow[]> {
  const [loc] = await db
    .select({ timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, locationId));
  if (!loc) return [];
  // A day's window wide enough for any time zone; localDate trims it.
  const from = new Date(`${date}T00:00:00Z`);
  const lo = new Date(from.getTime() - 14 * 60 * 60_000);
  const hi = new Date(from.getTime() + 38 * 60 * 60_000);
  const original = alias(visits, 'original');
  const rows = await db
    .select({
      at: visits.arrivedAt,
      fixedBy: visits.assignedTechnicianId,
      originalId: original.assignedTechnicianId,
    })
    .from(visits)
    .leftJoin(original, eq(original.id, visits.fixOfVisitId))
    .where(
      and(
        eq(visits.locationId, locationId),
        eq(visits.isFix, true),
        ne(visits.status, 'cancelled'),
        gte(visits.arrivedAt, lo),
        lte(visits.arrivedAt, hi),
      ),
    );
  const today = rows.filter((r) => localDate(r.at, loc.timezone) === date);
  if (today.length === 0) return [];
  const ids = [...new Set(today.map((r) => r.originalId).filter((x): x is string => !!x))];
  const names = ids.length
    ? await db
        .select({ id: technicians.id, name: technicians.displayName })
        .from(technicians)
        .where(inArray(technicians.id, ids))
    : [];
  const out = new Map<string, FixReportRow>();
  for (const r of today) {
    const key = r.originalId ?? '';
    const row = out.get(key) ?? {
      technicianId: r.originalId,
      technician: names.find((n) => n.id === r.originalId)?.name ?? null,
      fixes: 0,
      doneBySameTech: 0,
    };
    row.fixes += 1;
    if (r.originalId && r.fixedBy === r.originalId) row.doneBySameTech += 1;
    out.set(key, row);
  }
  return [...out.values()].sort(
    (a, b) => b.fixes - a.fixes || (a.technician ?? '~').localeCompare(b.technician ?? '~'),
  );
}

// v0.18.0 (F1, Duong 2026-11-13): "To check out". After a visit is finished
// it waits on the desk's list (who, what was done, by whom, when it finished)
// until the desk taps "Checked out". No payment and no prices: this is where a
// POS plugs in later. A client's visit in parts (split, or two services at
// the same time) is one row, shown once every part is finished. Whatever is
// still on the list at day end is cleared by the day-end close-out
// (day-end.ts) and counted in that day's summary. The owner can turn the list
// off (locations.checkout_list, default on). Whoever enters walk-ins may use
// it; a technician never sees it. Server only.
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Role } from './invites';
import { can } from './permissions';
import { clients, locations, services, technicians, visitServices, visits } from './schema';
import type { Db } from './server';
import { writeAudit } from './status';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type CheckoutActor = {
  userId: string;
  role: Role;
  organizationId: string;
  locationId: string;
};

export type CheckoutRow = {
  /** The visit the row is keyed on (the first part); "Checked out" sends it. */
  visitId: string;
  clientFirstName: string | null;
  clientLastName: string | null;
  /** A client row with only a full name (before v0.13.0). */
  clientName: string | null;
  kioskName: string | null;
  kioskLastName: string | null;
  /** Who did what, in the order the parts finished. */
  parts: { technician: string | null; services: string[] }[];
  /** When the last part finished. */
  finishedAt: Date;
};

const OPEN = ['waiting', 'called', 'in_service'] as const;

/** Is the list on at this location? (Default yes.) */
export async function checkoutListAt(db: Db | Tx, locationId: string): Promise<boolean> {
  const [row] = await db
    .select({ on: locations.checkoutList })
    .from(locations)
    .where(eq(locations.id, locationId));
  return row?.on ?? false;
}

/** The owner turns the list on or off (audited). */
export async function setCheckoutList(
  db: Db,
  input: { actor: CheckoutActor; on: boolean },
): Promise<{ ok: true } | { ok: false; reason: 'not_allowed' }> {
  if (input.actor.role !== 'owner') return { ok: false, reason: 'not_allowed' };
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ on: locations.checkoutList })
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
      .set({ checkoutList: input.on, updatedAt: new Date() })
      .where(eq(locations.id, input.actor.locationId));
    await writeAudit(tx, {
      organizationId: input.actor.organizationId,
      locationId: input.actor.locationId,
      actorUserId: input.actor.userId,
      entityType: 'locations',
      entityId: input.actor.locationId,
      action: 'checkout_list_setting',
      before: { checkoutList: before.on },
      after: { checkoutList: input.on },
    });
    return { ok: true as const };
  });
}

type Part = {
  id: string;
  status: string;
  splitFromVisitId: string | null;
  groupId: string | null;
};

/** One row per client visit: the parts of a split share the first part's
 *  key; two services at the same time share their group. Pure. */
export function checkoutKeys(parts: Part[]): Map<string, string> {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const rootOf = (p: Part): Part => {
    let at = p;
    const seen = new Set<string>();
    while (at.splitFromVisitId && byId.has(at.splitFromVisitId) && !seen.has(at.id)) {
      seen.add(at.id);
      at = byId.get(at.splitFromVisitId)!;
    }
    return at;
  };
  const keys = new Map<string, string>();
  for (const p of parts) {
    const root = rootOf(p);
    keys.set(p.id, root.groupId ? `g:${root.groupId}` : `v:${root.id}`);
  }
  return keys;
}

/** Today's finished visits not yet checked out, with the open visits that
 *  can still belong to the same client (split parts, same-time services). */
async function candidates(db: Db | Tx, locationId: string, today: string, timezone: string) {
  const done = await db
    .select({
      id: visits.id,
      status: visits.status,
      splitFromVisitId: visits.splitFromVisitId,
      groupId: visits.groupId,
      completedAt: visits.completedAt,
      assignedTechnicianId: visits.assignedTechnicianId,
      clientId: visits.clientId,
      kioskName: visits.kioskName,
      kioskLastName: visits.kioskLastName,
    })
    .from(visits)
    .where(
      and(
        eq(visits.locationId, locationId),
        eq(visits.status, 'completed'),
        isNull(visits.checkedOutAt),
        // Today only: an earlier day's are the close-out's (the partial
        // index visits_to_check_out serves this).
        sql`(${visits.completedAt} at time zone ${timezone})::date = ${today}::date`,
      ),
    )
    .orderBy(asc(visits.completedAt));
  const open = await db
    .select({
      id: visits.id,
      status: visits.status,
      splitFromVisitId: visits.splitFromVisitId,
      groupId: visits.groupId,
    })
    .from(visits)
    .where(and(eq(visits.locationId, locationId), inArray(visits.status, [...OPEN])));
  return { done, open };
}

function localToday(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

type ClientName = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
};

/** The desk's list: one row per client, oldest finish first. */
export async function toCheckOut(
  db: Db,
  viewer: CheckoutActor,
  now = new Date(),
): Promise<{ ok: true; on: boolean; rows: CheckoutRow[] } | { ok: false; reason: 'not_allowed' }> {
  if (!can(viewer.role, 'enter_walkins')) return { ok: false, reason: 'not_allowed' };
  const [loc] = await db
    .select({ on: locations.checkoutList, timezone: locations.timezone })
    .from(locations)
    .where(
      and(eq(locations.id, viewer.locationId), eq(locations.organizationId, viewer.organizationId)),
    );
  if (!loc) return { ok: false, reason: 'not_allowed' };
  if (!loc.on) return { ok: true, on: false, rows: [] };
  const { done, open } = await candidates(
    db,
    viewer.locationId,
    localToday(now, loc.timezone),
    loc.timezone,
  );
  if (done.length === 0) return { ok: true, on: true, rows: [] };
  const keys = checkoutKeys([...done, ...open]);
  const stillOpen = new Set(open.map((o) => keys.get(o.id)));
  const ids = done.map((d) => d.id);
  const clientIds = [...new Set(done.map((d) => d.clientId).filter((c): c is string => !!c))];
  const [items, names, people] = await Promise.all([
    db
      .select({ visitId: visitServices.visitId, name: services.name })
      .from(visitServices)
      .innerJoin(services, eq(services.id, visitServices.serviceId))
      .where(inArray(visitServices.visitId, ids))
      .orderBy(asc(services.name)),
    db
      .select({ id: technicians.id, name: technicians.displayName })
      .from(technicians)
      .where(eq(technicians.locationId, viewer.locationId)),
    clientIds.length
      ? db
          .select({
            id: clients.id,
            firstName: clients.firstName,
            lastName: clients.lastName,
            name: clients.name,
          })
          .from(clients)
          .where(and(inArray(clients.id, clientIds), isNull(clients.anonymisedAt)))
      : Promise.resolve([] as ClientName[]),
  ]);
  const techName = new Map(names.map((n) => [n.id, n.name]));
  const person = new Map(people.map((p) => [p.id, p]));
  const rows = new Map<string, CheckoutRow>();
  for (const d of done) {
    const key = keys.get(d.id)!;
    if (stillOpen.has(key)) continue;
    const list = items.filter((i) => i.visitId === d.id).map((i) => i.name);
    const technician = d.assignedTechnicianId
      ? (techName.get(d.assignedTechnicianId) ?? null)
      : null;
    const c = d.clientId ? person.get(d.clientId) : undefined;
    const row = rows.get(key);
    if (row) {
      row.parts.push({ technician, services: list });
      if (d.completedAt && d.completedAt > row.finishedAt) row.finishedAt = d.completedAt;
      row.clientFirstName ??= c?.firstName ?? null;
      row.clientLastName ??= c?.lastName ?? null;
      row.clientName ??= c?.name ?? null;
      row.kioskName ??= d.kioskName;
      row.kioskLastName ??= d.kioskLastName;
      continue;
    }
    rows.set(key, {
      visitId: d.id,
      clientFirstName: c?.firstName ?? null,
      clientLastName: c?.lastName ?? null,
      clientName: c?.name ?? null,
      kioskName: d.kioskName,
      kioskLastName: d.kioskLastName,
      parts: [{ technician, services: list }],
      finishedAt: d.completedAt ?? now,
    });
  }
  return {
    ok: true,
    on: true,
    rows: [...rows.values()].sort((a, b) => a.finishedAt.getTime() - b.finishedAt.getTime()),
  };
}

export type CheckOutError = {
  ok: false;
  reason:
    | 'not_allowed'
    | 'unknown_visit'
    | 'wrong_location'
    | 'not_finished'
    | 'already_checked_out'
    | 'still_open'
    | 'list_off';
};

/** "Checked out": every finished part of this client's visit leaves the list. */
export async function checkOutVisit(
  db: Db,
  input: { actor: CheckoutActor; visitId: string; now?: Date },
): Promise<{ ok: true; visits: number } | CheckOutError> {
  if (!can(input.actor.role, 'enter_walkins')) return { ok: false, reason: 'not_allowed' };
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [visit] = await tx
      .select({
        id: visits.id,
        organizationId: visits.organizationId,
        locationId: visits.locationId,
        status: visits.status,
        checkedOutAt: visits.checkedOutAt,
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
    const [loc] = await tx
      .select({ on: locations.checkoutList, timezone: locations.timezone })
      .from(locations)
      .where(eq(locations.id, visit.locationId));
    if (!loc?.on) return { ok: false as const, reason: 'list_off' as const };
    if (visit.status !== 'completed')
      return { ok: false as const, reason: 'not_finished' as const };
    if (visit.checkedOutAt) return { ok: false as const, reason: 'already_checked_out' as const };
    const { done, open } = await candidates(
      tx,
      visit.locationId,
      localToday(now, loc.timezone),
      loc.timezone,
    );
    const keys = checkoutKeys([...done, ...open]);
    const key = keys.get(visit.id);
    if (!key) return { ok: false as const, reason: 'already_checked_out' as const };
    if (open.some((o) => keys.get(o.id) === key)) {
      return { ok: false as const, reason: 'still_open' as const };
    }
    const ids = done.filter((d) => keys.get(d.id) === key).map((d) => d.id);
    await tx
      .update(visits)
      .set({ checkedOutAt: now, checkedOutBy: input.actor.userId, updatedAt: now })
      .where(and(inArray(visits.id, ids), isNull(visits.checkedOutAt)));
    await writeAudit(tx, {
      organizationId: visit.organizationId,
      locationId: visit.locationId,
      actorUserId: input.actor.userId,
      entityType: 'visits',
      entityId: visit.id,
      action: 'visit_checked_out',
      // Counts only: never a client's name or phone (T11).
      after: { parts: ids.length },
    });
    return { ok: true as const, visits: ids.length };
  });
}

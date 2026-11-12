// The tech board (v0.12.0, Duong 2026-11-12): one card per technician on
// shift, in queue order, with what they do, who they do not take, their next
// appointment, the client in their chair, and every ledger row behind their
// points ("Why this order?"). Read-only; the engine's own order (compareQueue).
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { compareQueue } from './engine';
import { doesEverything, loadProfiles, type Restriction } from './profile';
import { activeRules } from './rules';
import {
  appointments,
  serviceCategories,
  services,
  turnCalls,
  turnLedger,
  visitServices,
  visits,
} from './schema';
import type { Db } from './server';
import { locationStatus, type TechnicianState } from './status';

export type LedgerKind = 'visit' | 'deny' | 'excuse' | 'late' | 'out_over' | 'manual';

export type LedgerLine = {
  delta: number;
  kind: LedgerKind;
  /** For a visit: its services. */
  services: string[];
  /** For a visit: where it came from (an appointment visit is worth −½ less). */
  source: 'walk_in' | 'appointment' | 'request' | 'self_checkin' | null;
  /** The engine's short note: "17 min late", "out over 60 min", a deny reason. */
  note: string | null;
  at: Date;
};

export type TechCard = {
  technicianId: string;
  displayName: string;
  /** 1 = next in line among everyone on shift. */
  turn: number;
  status: TechnicianState | 'called';
  points: number;
  hadAppointmentLast: boolean;
  checkedInAt: Date | null;
  /** 1 = first to check in today. */
  checkInRank: number;
  /** null = does every service; else the category names. */
  skills: string[] | null;
  tags: string[];
  restrictions: Restriction[];
  nextAppointmentAt: Date | null;
  /** That appointment is inside the buffer: the engine holds them out of the line. */
  heldForAppointment: boolean;
  /** The services of the client in the chair (in service) or being called. */
  currentServices: string[];
  lines: LedgerLine[];
};

export async function techBoard(db: Db, locationId: string, now = new Date()): Promise<TechCard[]> {
  const [rows, rules, profiles, cats] = await Promise.all([
    locationStatus(db, locationId),
    activeRules(db, locationId),
    loadProfiles(db, locationId),
    db
      .select({ id: serviceCategories.id, name: serviceCategories.name })
      .from(serviceCategories)
      .where(eq(serviceCategories.locationId, locationId)),
  ]);
  const onShift = rows.filter((r) => r.status !== 'off').sort((a, b) => compareQueue(rules, a, b));
  if (onShift.length === 0) return [];
  const ids = onShift.map((r) => r.technicianId);
  const shiftIds = onShift.map((r) => r.shiftId).filter((s): s is string => !!s);
  const bufferMs = rules.eligibility.upcoming_appointment_buffer_min * 60_000;

  const [ledger, upcoming, open, current] = await Promise.all([
    shiftIds.length
      ? db
          .select({
            shiftId: turnLedger.shiftId,
            delta: turnLedger.delta,
            kind: turnLedger.reasonType,
            note: turnLedger.note,
            visitId: turnLedger.visitId,
            source: visits.source,
            at: turnLedger.createdAt,
          })
          .from(turnLedger)
          .leftJoin(visits, eq(visits.id, turnLedger.visitId))
          .where(inArray(turnLedger.shiftId, shiftIds))
          .orderBy(asc(turnLedger.createdAt))
      : Promise.resolve([]),
    db
      .select({ technicianId: appointments.technicianId, startAt: appointments.startAt })
      .from(appointments)
      .where(
        and(
          eq(appointments.locationId, locationId),
          inArray(appointments.technicianId, ids),
          isNull(appointments.cancelledAt),
          isNull(appointments.arrivedAt),
          // A client past the buffer is a no-show and no longer holds anyone.
          gt(appointments.startAt, new Date(now.getTime() - bufferMs)),
        ),
      )
      .orderBy(asc(appointments.startAt)),
    db
      .select({ technicianId: turnCalls.technicianId, visitId: turnCalls.visitId })
      .from(turnCalls)
      .where(and(eq(turnCalls.locationId, locationId), isNull(turnCalls.respondedAt))),
    db
      .select({ technicianId: visits.assignedTechnicianId, visitId: visits.id })
      .from(visits)
      .where(
        and(
          eq(visits.locationId, locationId),
          eq(visits.status, 'in_service'),
          inArray(visits.assignedTechnicianId, ids),
        ),
      ),
  ]);
  const chairVisit = new Map<string, string>();
  for (const c of current) if (c.technicianId) chairVisit.set(c.technicianId, c.visitId);
  for (const c of open)
    if (!chairVisit.has(c.technicianId)) chairVisit.set(c.technicianId, c.visitId);
  const visitIds = [
    ...new Set([
      ...ledger.map((l) => l.visitId).filter((v): v is string => !!v),
      ...chairVisit.values(),
    ]),
  ];
  const items = visitIds.length
    ? await db
        .select({ visitId: visitServices.visitId, name: services.name })
        .from(visitServices)
        .innerJoin(services, eq(services.id, visitServices.serviceId))
        .where(inArray(visitServices.visitId, visitIds))
    : [];
  const namesOf = (visitId: string | null | undefined) =>
    visitId ? items.filter((i) => i.visitId === visitId).map((i) => i.name) : [];
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const next = new Map<string, Date>();
  for (const a of upcoming) if (!next.has(a.technicianId)) next.set(a.technicianId, a.startAt);
  const called = new Set(open.map((c) => c.technicianId));
  const byCheckIn = [...onShift].sort(
    (a, b) => (a.checkedInAt?.getTime() ?? 0) - (b.checkedInAt?.getTime() ?? 0),
  );

  return onShift.map((r, i) => {
    const profile = profiles.get(r.technicianId);
    return {
      technicianId: r.technicianId,
      displayName: r.displayName,
      turn: i + 1,
      status: called.has(r.technicianId) ? 'called' : r.status,
      points: r.points,
      hadAppointmentLast: r.hadAppointmentLast,
      checkedInAt: r.checkedInAt,
      checkInRank: byCheckIn.indexOf(r) + 1,
      skills:
        !profile || doesEverything(profile)
          ? null
          : profile.skillCategoryIds.map((c) => catName.get(c) ?? c),
      tags: profile?.tags ?? [],
      restrictions: profile?.restrictions ?? [],
      nextAppointmentAt: next.get(r.technicianId) ?? null,
      heldForAppointment:
        (next.get(r.technicianId)?.getTime() ?? Infinity) <= now.getTime() + bufferMs,
      currentServices: namesOf(chairVisit.get(r.technicianId)),
      lines: ledger
        .filter((l) => l.shiftId === r.shiftId)
        .map((l) => ({
          delta: Number(l.delta),
          kind: l.kind as LedgerKind,
          services: namesOf(l.visitId),
          source: l.kind === 'visit' ? (l.source ?? null) : null,
          note: l.note,
          at: l.at,
        })),
    };
  });
}

/** Why `a` is ahead of `b` in the line, as the rules decide it. */
export function aheadBecause(
  a: Pick<TechCard, 'points' | 'hadAppointmentLast' | 'checkInRank'>,
  b: Pick<TechCard, 'points' | 'hadAppointmentLast' | 'checkInRank'>,
): 'fewer_points' | 'appointment_last' | 'earlier_check_in' {
  if (a.points !== b.points) return 'fewer_points';
  if (a.hadAppointmentLast !== b.hadAppointmentLast) return 'appointment_last';
  return 'earlier_check_in';
}

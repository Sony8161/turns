// The tech board (v0.12.0, Duong 2026-11-12): one card per technician on
// shift, in queue order, with what they do, who they do not take, their next
// appointment, the client in their chair, and every ledger row behind their
// points ("Why this order?"). Read-only; the engine's own order (compareQueue).
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { compareQueue } from './engine';
import { loadLevels, menuLevels, type SkillLevel } from './levels';
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

/** 'deny_excused' (v0.15.0) is not a ledger row: a deny for a reason the
 *  rules excuse on their own. It posts nothing; it is listed so the card says why. */
export type LedgerKind =
  'visit' | 'deny' | 'deny_excused' | 'excuse' | 'late' | 'out_over' | 'manual';

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
  /** null = does every service; else the category names (no level set). */
  skills: string[] | null;
  /** v0.14.0: the technician's level, and with it the services ticked for her. */
  level: SkillLevel | null;
  services: string[] | null;
  tags: string[];
  restrictions: Restriction[];
  nextAppointmentAt: Date | null;
  /** That appointment is inside the buffer: the engine holds them out of the line. */
  heldForAppointment: boolean;
  /** The services of the client in the chair (in service) or being called. */
  currentServices: string[];
  lines: LedgerLine[];
  /** v0.17.0: her open call (the desk may accept for her), or the visit she
   *  is in service on (the desk may finish for her). */
  openCallId: string | null;
  openCallKind: string | null;
  inServiceVisitId: string | null;
  /** v0.17.0 (FAIR-001): denies the rules excused today, and whether that
   *  reaches the rules' flag (fairness.free_deny_flag; 0 = never). */
  freeDenies: number;
  freeDenyFlag: boolean;
};

export async function techBoard(db: Db, locationId: string, now = new Date()): Promise<TechCard[]> {
  const [rows, rules, profiles, cats, levels, menu] = await Promise.all([
    locationStatus(db, locationId),
    activeRules(db, locationId),
    loadProfiles(db, locationId),
    db
      .select({ id: serviceCategories.id, name: serviceCategories.name })
      .from(serviceCategories)
      .where(eq(serviceCategories.locationId, locationId)),
    loadLevels(db, locationId),
    menuLevels(db, locationId),
  ]);
  const onShift = rows.filter((r) => r.status !== 'off').sort((a, b) => compareQueue(rules, a, b));
  if (onShift.length === 0) return [];
  const ids = onShift.map((r) => r.technicianId);
  const shiftIds = onShift.map((r) => r.shiftId).filter((s): s is string => !!s);
  const bufferMs = rules.eligibility.upcoming_appointment_buffer_min * 60_000;

  const [ledger, upcoming, open, current, saidNo] = await Promise.all([
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
          // v0.17.0: one the desk marked a no-show holds nobody.
          isNull(appointments.noShowAt),
          // A client past the buffer is a no-show and no longer holds anyone.
          gt(appointments.startAt, new Date(now.getTime() - bufferMs)),
        ),
      )
      .orderBy(asc(appointments.startAt)),
    db
      .select({
        technicianId: turnCalls.technicianId,
        visitId: turnCalls.visitId,
        callId: turnCalls.id,
        kind: turnCalls.kind,
      })
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
    // v0.15.0: denies the rules excused on their own (no ledger row).
    db
      .select({
        technicianId: turnCalls.technicianId,
        reason: turnCalls.denyReason,
        at: turnCalls.respondedAt,
      })
      .from(turnCalls)
      .where(
        and(
          eq(turnCalls.locationId, locationId),
          eq(turnCalls.autoExcused, true),
          inArray(turnCalls.technicianId, ids),
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

  const flagAt = rules.fairness.free_deny_flag;
  return onShift.map((r, i) => {
    const profile = profiles.get(r.technicianId);
    const lv = levels.get(r.technicianId);
    const myCall = open.find((c) => c.technicianId === r.technicianId);
    const myChair = current.find((c) => c.technicianId === r.technicianId);
    // Since this shift's check-in only: yesterday's are not today's story.
    const freeToday = saidNo.filter(
      (d) =>
        d.technicianId === r.technicianId &&
        !!d.at &&
        (!r.checkedInAt || d.at.getTime() >= r.checkedInAt.getTime()),
    );
    return {
      openCallId: myCall?.callId ?? null,
      openCallKind: myCall?.kind ?? null,
      inServiceVisitId: myChair?.visitId ?? null,
      freeDenies: freeToday.length,
      freeDenyFlag: flagAt > 0 && freeToday.length >= flagAt,
      level: lv?.level ?? null,
      services: lv ? menu.filter((m) => lv.serviceIds.has(m.id)).map((m) => m.name) : null,
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
      lines: [
        ...ledger
          .filter((l) => l.shiftId === r.shiftId)
          .map((l): LedgerLine => ({
            delta: Number(l.delta),
            kind: l.kind as LedgerKind,
            services: namesOf(l.visitId),
            source: l.kind === 'visit' ? (l.source ?? null) : null,
            note: l.note,
            at: l.at,
          })),
        ...freeToday.map((d): LedgerLine => ({
          delta: 0,
          kind: 'deny_excused',
          services: [],
          source: null,
          note: d.reason,
          at: d.at!,
        })),
      ].sort((x, y) => x.at.getTime() - y.at.getTime()),
    };
  });
}

/**
 * Why `a` is ahead of `b` in the line, as the rules decide it. `sort` is the
 * rules' queue.sort: with 'double_zero_last' (v0.15.0) the appointment only
 * counts at zero (0 before 00); with 'had_appointment_last' at every score.
 */
export function aheadBecause(
  a: Pick<TechCard, 'points' | 'hadAppointmentLast' | 'checkInRank'>,
  b: Pick<TechCard, 'points' | 'hadAppointmentLast' | 'checkInRank'>,
  sort: readonly string[] = ['points_asc', 'double_zero_last', 'check_in_asc'],
): 'fewer_points' | 'appointment_last' | 'earlier_check_in' {
  if (a.points !== b.points) return 'fewer_points';
  const counts =
    sort.includes('had_appointment_last') || (sort.includes('double_zero_last') && a.points === 0);
  if (counts && a.hadAppointmentLast !== b.hadAppointmentLast) return 'appointment_last';
  return 'earlier_check_in';
}

// Demo day (v0.12.0, Duong 2026-11-12): a salon morning built by the engine
// itself, so the numbers on the board are the numbers the engine computes.
// Every point comes from a real check-in, call, deny, excuse, finish or
// out-over; nothing is written to the ledger by hand. buildDemoDay runs on an
// empty day at a location; demoReport reads the result back and simulates the
// next calls inside a transaction that is rolled back, so the cheat sheet
// (docs/DEMO-EXPECTED.md) is what the engine would really do.
//
// Times: the morning is laid out backwards from now, inside today's local
// date. It needs about an hour of today behind it (the out-over needs 60
// minutes), so it refuses to run in the first 66 minutes after midnight.
// Clock times never appear in the cheat sheet, only order and minutes, so the
// sheet is the same on every run.
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { addAppointment, appointmentArrived } from './appointments';
import {
  callNext,
  createWalkIn,
  excusePenalty,
  finishVisit,
  queueFor,
  respondToCall,
  waitingVisits,
  type Candidate,
  type Skipped,
} from './engine';
import { createKioskDevice, kioskCheckIn, pairKiosk } from './kiosk';
import { saveProfile, type ProfileInput } from './profile';
import { activeRules, type RuleConfig } from './rules';
import {
  appointments,
  calendarFeeds,
  locations,
  serviceCategories,
  services,
  shifts,
  technicians,
  turnLedger,
  visitServices,
  visits,
} from './schema';
import type { Db } from './server';
import { checkIn, transition, writeAudit } from './status';

export const DEMO_TECH_NAMES = ['Vân', 'Mai', 'Hoa', 'Linh', 'Thảo', 'Tâm'] as const;
export type DemoTechName = (typeof DEMO_TECH_NAMES)[number];

/** Who each demo technician is: tags and restrictions are shown as chips;
 *  `skills` names the categories they do (null = everything). */
export const DEMO_PROFILES: Record<
  DemoTechName,
  { skills: string[] | null; tags: string[]; restrictions: ProfileInput['restrictions'] }
> = {
  Vân: { skills: ['manicure', 'pedicure'], tags: ['pedicure', 'design'], restrictions: [] },
  Mai: {
    skills: ['manicure', 'pedicure', 'fill'],
    tags: ['pedicure'],
    restrictions: [
      { type: 'no_same_time', value: null, note: null },
      { type: 'custom', value: null, note: 'prefers mornings' },
    ],
  },
  Hoa: {
    skills: null,
    tags: ['gel', 'acrylic', 'design'],
    restrictions: [{ type: 'min_client_age', value: 12, note: null }],
  },
  Linh: {
    skills: null,
    tags: ['design', 'gel'],
    restrictions: [{ type: 'no_kids', value: null, note: null }],
  },
  Thảo: {
    skills: null,
    tags: ['fast', 'dip'],
    restrictions: [{ type: 'no_male_clients', value: null, note: null }],
  },
  Tâm: { skills: null, tags: ['acrylic', 'dip'], restrictions: [] },
};

/** Minutes of today that must be behind us: the out-over needs 60. */
export const DEMO_MIN_MINUTES = 66;
const LATE_MIN = 17;
const OUT_MIN = 62;

export type DemoContext = {
  organizationId: string;
  locationId: string;
  ownerUserId: string;
  receptionistUserId: string;
  /** For the kiosk check-in that waits for the desk. */
  kioskPin: string;
};

function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

function hhmm(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${String(h).padStart(2, '0')}:${m}`;
}

function localDay(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

const minus = (now: Date, min: number) => new Date(now.getTime() - min * 60_000);
const plus = (now: Date, min: number) => new Date(now.getTime() + min * 60_000);

function must<T extends { ok: boolean }>(r: T, what: string): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`demo: ${what}: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

/** The placeholder a demo calendar row carries: the reserved .invalid name
 *  (RFC 2606), which the feed code never fetches (feeds.ts). */
export function demoFeedUrl(name: string): string {
  return `https://demo-calendar.invalid/${encodeURIComponent(name)}.ics`;
}

/**
 * Builds the morning. Refuses a location that already has shifts today, so a
 * second run never piles on: reset the local database first (TESTING.md).
 */
export async function buildDemoDay(db: Db, ctx: DemoContext): Promise<void> {
  const now = new Date();
  const [loc] = await db
    .select({ timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, ctx.locationId));
  if (!loc) throw new Error('demo: unknown location');
  const tz = loc.timezone;
  const today = localDay(now, tz);
  const sinceMidnight = localMinutes(now, tz);
  if (sinceMidnight < DEMO_MIN_MINUTES) {
    throw new Error(
      `demo: the demo day needs ${DEMO_MIN_MINUTES} minutes of today behind it (the out-over penalty needs 60). ` +
        `Run it again after ${Math.floor(DEMO_MIN_MINUTES / 60)}:${String(DEMO_MIN_MINUTES % 60).padStart(2, '0')} AM.`,
    );
  }
  const started = await db
    .select({ id: shifts.id })
    .from(shifts)
    .where(and(eq(shifts.locationId, ctx.locationId), eq(shifts.date, today)))
    .limit(1);
  if (started.length) {
    throw new Error(
      'demo: this location already has shifts today. Reset first: npm run up -- -Demo',
    );
  }

  const techRows = await db
    .select({ id: technicians.id, userId: technicians.userId, name: technicians.displayName })
    .from(technicians)
    .where(and(eq(technicians.locationId, ctx.locationId), eq(technicians.active, true)));
  const tech = {} as Record<DemoTechName, { id: string; userId: string }>;
  for (const n of DEMO_TECH_NAMES) {
    const row = techRows.find((t) => t.name === n);
    if (!row) throw new Error(`demo: technician ${n} is missing`);
    tech[n] = { id: row.id, userId: row.userId };
  }
  const cats = await db
    .select({ id: serviceCategories.id, name: serviceCategories.name })
    .from(serviceCategories)
    .where(eq(serviceCategories.locationId, ctx.locationId));
  const catId = new Map(cats.map((c) => [c.name, c.id]));
  const menu = await db
    .select({ id: services.id, name: services.name })
    .from(services)
    .where(and(eq(services.locationId, ctx.locationId), isNull(services.archivedAt)));
  const svc = (name: string) => {
    const s = menu.find((m) => m.name === name);
    if (!s) throw new Error(`demo: service ${name} is missing`);
    return s.id;
  };
  const owner = {
    userId: ctx.ownerUserId,
    role: 'owner' as const,
    organizationId: ctx.organizationId,
    locationId: ctx.locationId,
  };
  const desk = {
    userId: ctx.receptionistUserId,
    organizationId: ctx.organizationId,
    locationId: ctx.locationId,
  };

  // Profiles (Staff -> Skills and restrictions).
  for (const n of DEMO_TECH_NAMES) {
    const p = DEMO_PROFILES[n];
    must(
      await saveProfile(db, {
        actor: owner,
        technicianId: tech[n].id,
        profile: {
          skillCategoryIds: p.skills ? p.skills.map((c) => catId.get(c)!) : null,
          tags: p.tags,
          restrictions: p.restrictions,
        },
      }),
      `profile ${n}`,
    );
  }

  // Check-ins, oldest first, laid out backwards from now inside today.
  const span = Math.min(125, sinceMidnight - 2);
  const step = Math.min(15, Math.floor((span - 5) / 6));
  const checkInAt = (k: number) => minus(now, span - k * step);
  const actorOf = (n: DemoTechName) => ({ userId: tech[n].userId });
  for (const [k, n] of DEMO_TECH_NAMES.entries()) {
    const at = checkInAt(k);
    if (n === 'Tâm') {
      // A schedule made ahead: Tâm was due 17 minutes before she checked in.
      await db.insert(shifts).values({
        organizationId: ctx.organizationId,
        locationId: ctx.locationId,
        technicianId: tech[n].id,
        date: today,
        scheduledStart: hhmm(minus(at, LATE_MIN), tz),
        checkedInAt: at,
      });
    }
    must(
      await checkIn(db, { technicianId: tech[n].id, actor: actorOf(n), position: null, now: at }),
      `check in ${n}`,
    );
  }
  const ready = async (n: DemoTechName, at = new Date()) =>
    must(
      await transition(db, {
        technicianId: tech[n].id,
        to: 'available',
        actor: actorOf(n),
        now: at,
      }),
      `${n} available`,
    );
  const walkIn = async (names: string[], extra: Partial<Parameters<typeof createWalkIn>[1]> = {}) =>
    must(
      await createWalkIn(db, {
        organizationId: ctx.organizationId,
        locationId: ctx.locationId,
        serviceIds: names.map(svc),
        actor: { userId: ctx.receptionistUserId },
        ...extra,
      }),
      `walk-in ${names.join(' + ')}`,
    );
  const call = async (visitId: string, expect: DemoTechName) => {
    const r = must(
      await callNext(db, {
        visitId,
        actor: { userId: ctx.receptionistUserId },
        locationId: ctx.locationId,
      }),
      `call for ${expect}`,
    );
    if (r.technicianId !== tech[expect].id) {
      throw new Error(`demo: expected ${expect} to be called, the engine called someone else`);
    }
    return r.callId;
  };
  const accept = async (callId: string, n: DemoTechName) =>
    must(
      await respondToCall(db, {
        callId,
        technicianId: tech[n].id,
        response: 'accepted',
        actor: actorOf(n),
      }),
      `${n} accepts`,
    );
  const deny = async (callId: string, n: DemoTechName, reason: 'other' | 'break_needed') =>
    must(
      await respondToCall(db, {
        callId,
        technicianId: tech[n].id,
        response: 'denied',
        denyReason: reason,
        actor: actorOf(n),
      }),
      `${n} denies`,
    );
  const finish = async (n: DemoTechName) =>
    must(await finishVisit(db, { technicianId: tech[n].id, actor: actorOf(n) }), `${n} finishes`);

  // Vân: on the floor first, then out for 62 minutes (back at the end: +1).
  await ready('Vân', plus(checkInAt(0), 1));
  must(
    await transition(db, {
      technicianId: tech['Vân'].id,
      to: 'out',
      actor: actorOf('Vân'),
      now: minus(now, OUT_MIN),
    }),
    'Vân out',
  );

  // Mai and Hoa: an acrylic fill. Mai is first (checked in earlier) and
  // denies it without an excuse (+1); Hoa takes it (½).
  await ready('Mai', plus(checkInAt(1), 1));
  await ready('Hoa', plus(checkInAt(2), 1));
  const fill = await walkIn(['Acrylic fill']);
  await deny(await call(fill.visitId, 'Mai'), 'Mai', 'other');
  await accept(await call(fill.visitId, 'Hoa'), 'Hoa');
  await finish('Hoa');
  // A gel manicure: Hoa (½) is now below Mai (1). +1 for Hoa.
  const gel = await walkIn(['Gel manicure']);
  await accept(await call(gel.visitId, 'Hoa'), 'Hoa');
  await finish('Hoa');

  // Linh: her calendar client arrived (gel manicure): 1 - ½ = ½, and her last
  // visit was an appointment, so she sorts after anyone else at ½.
  await ready('Linh', plus(checkInAt(3), 1));
  const feeds = await demoFeeds(db, ctx, tech, now);
  const arrivedAppt = await calendarAppointment(db, ctx, feeds, tech, {
    name: 'Linh',
    key: 'arrived',
    start: minus(now, 45),
    minutes: 45,
    client: 'Calendar client',
  });
  const arrived = must(
    await appointmentArrived(db, {
      appointmentId: arrivedAppt,
      serviceIds: [svc('Gel manicure')],
      actor: desk,
    }),
    'Linh appointment arrived',
  );
  await accept(await call(arrived.visitId, 'Linh'), 'Linh');
  await finish('Linh');

  // Thảo: a gel fill. She is lowest (0), denies for a break (+1), the owner
  // excuses it (back to 0), she is called again and takes it (½).
  await ready('Thảo', plus(checkInAt(4), 1));
  const gelFill = await walkIn(['Gel fill']);
  await deny(await call(gelFill.visitId, 'Thảo'), 'Thảo', 'break_needed');
  const [denyRow] = await db
    .select({ id: turnLedger.id })
    .from(turnLedger)
    .where(and(eq(turnLedger.technicianId, tech['Thảo'].id), eq(turnLedger.reasonType, 'deny')));
  must(
    await excusePenalty(db, {
      ledgerId: denyRow!.id,
      actor: owner,
      reason: 'Demo: break needed, excused by the owner',
    }),
    'excuse Thảo',
  );
  await accept(await call(gelFill.visitId, 'Thảo'), 'Thảo');
  await finish('Thảo');

  // Hoa again: a client asked for her (a request skips the line). In service now.
  const request = await walkIn(['Spa pedicure'], {
    requestedTechnicianId: tech['Hoa'].id,
    client: { name: 'Kim Le', phone: '813-555-0210' },
  });
  await accept(await call(request.visitId, 'Hoa'), 'Hoa');

  // Tâm: 17 minutes late (+½ at check-in), now on break.
  await ready('Tâm');
  must(
    await transition(db, { technicianId: tech['Tâm'].id, to: 'break', actor: actorOf('Tâm') }),
    'Tâm break',
  );
  // Vân back from her 62 minutes out: the out-over penalty posts (+1).
  await ready('Vân');

  // The rest of today's book.
  await calendarAppointment(db, ctx, feeds, tech, {
    name: 'Thảo',
    key: 'soon',
    start: plus(now, 20),
    minutes: 75,
    client: 'Calendar client',
  });
  await calendarAppointment(db, ctx, feeds, tech, {
    name: 'Tâm',
    key: 'no-show',
    start: minus(now, 40),
    minutes: 60,
    client: 'Calendar client',
  });
  for (const a of [
    { name: 'Mai' as const, start: 120, minutes: 45, client: 'Desk: pedicure' },
    { name: 'Linh' as const, start: 180, minutes: 60, client: 'Desk: gel-X full set' },
  ]) {
    must(
      await addAppointment(db, {
        actor: desk,
        technicianId: tech[a.name].id,
        clientName: a.client,
        startAt: plus(now, a.start),
        endAt: plus(now, a.start + a.minutes),
      }),
      `desk appointment ${a.name}`,
    );
  }

  // Waiting, oldest first: the cheat sheet calls them top to bottom.
  await walkIn(['Basic pedicure'], {
    client: { name: 'An Do' },
    attributes: { gender: 'female', isKid: true, age: 8 },
  });
  await walkIn(['Gel manicure'], {
    client: { name: 'Lan Nguyen', phone: '813-555-0201' },
    attributes: { gender: 'female', isKid: false, age: null },
  });
  await walkIn(['Basic manicure'], {
    client: { name: 'Minh Tran', phone: '813-555-0202', gender: 'male' },
    attributes: { gender: 'male', isKid: false, age: null },
  });
  await walkIn(['Gel manicure'], {
    requestedTechnicianId: tech['Hoa'].id,
    client: { name: 'Thu Pham', phone: '813-555-0203' },
    attributes: { gender: 'female', isKid: false, age: null },
  });
  await walkIn(['Gel manicure', 'Spa pedicure'], {
    client: { name: 'Ngoc Vo', phone: '813-555-0204' },
    attributes: { gender: 'female', isKid: false, age: null },
  });
  const device = must(
    await createKioskDevice(db, { actor: owner, name: 'Demo kiosk', pin: ctx.kioskPin }),
    'demo kiosk',
  );
  const paired = must(await pairKiosk(db, { code: device.pairingCode }), 'pair demo kiosk');
  must(
    await kioskCheckIn(db, {
      device: paired.device,
      name: 'Bích',
      serviceIds: [svc('Basic manicure')],
      attributes: { gender: 'female', isKid: false, age: null },
      note: 'French tip, almond shape',
    }),
    'kiosk check-in',
  );
}

/** One calendar row per demo technician who has calendar appointments:
 *  connected, synced five minutes ago, with a placeholder link. */
async function demoFeeds(
  db: Db,
  ctx: DemoContext,
  tech: Record<DemoTechName, { id: string }>,
  now: Date,
): Promise<Map<DemoTechName, string>> {
  const out = new Map<DemoTechName, string>();
  for (const n of ['Linh', 'Thảo', 'Tâm'] as const) {
    const [row] = await db
      .insert(calendarFeeds)
      .values({
        organizationId: ctx.organizationId,
        locationId: ctx.locationId,
        technicianId: tech[n].id,
        url: demoFeedUrl(n),
        urlHint: 'demo calendar',
        lastAttemptAt: minus(now, 5),
        lastSyncedAt: minus(now, 5),
        lastEventCount: 1,
        createdBy: ctx.ownerUserId,
      })
      .returning({ id: calendarFeeds.id });
    out.set(n, row!.id);
  }
  return out;
}

async function calendarAppointment(
  db: Db,
  ctx: DemoContext,
  feeds: Map<DemoTechName, string>,
  tech: Record<DemoTechName, { id: string }>,
  a: { name: DemoTechName; key: string; start: Date; minutes: number; client: string },
): Promise<string> {
  const feedId = feeds.get(a.name)!;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(appointments)
      .values({
        organizationId: ctx.organizationId,
        locationId: ctx.locationId,
        technicianId: tech[a.name].id,
        externalId: `${feedId}:demo-${a.key}`,
        clientName: a.client,
        startAt: a.start,
        endAt: plus(a.start, a.minutes),
        source: 'ics',
        feedId,
        syncedAt: new Date(),
      })
      .returning({ id: appointments.id });
    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      locationId: ctx.locationId,
      actorUserId: null,
      entityType: 'appointments',
      entityId: row!.id,
      action: 'appointment_synced',
      after: { technicianId: tech[a.name].id, startAt: a.start, demo: true },
    });
    return row!.id;
  });
}

// The report --------------------------------------------------------------------

export type DemoLedgerLine = { delta: number; what: string };
export type DemoTechLine = {
  turn: number;
  name: string;
  status: string;
  points: number;
  hadAppointmentLast: boolean;
  checkInRank: number;
  lines: DemoLedgerLine[];
};
export type DemoCall = {
  client: string;
  services: string[];
  picked: string | null;
  skipped: { name: string; why: string; detail?: string }[];
  waitingFor?: string | null;
  needsConfirm?: boolean;
};
export type DemoAppointment = {
  name: string;
  source: 'calendar' | 'desk';
  startMin: number;
  state: 'arrived' | 'upcoming' | 'no_show';
};
export type DemoReport = {
  rules: RuleConfig;
  board: DemoTechLine[];
  calls: DemoCall[];
  appointments: DemoAppointment[];
};

class Rollback extends Error {}

function describeLine(
  l: { reasonType: string; delta: number; note: string | null; source: string | null },
  serviceNames: string[],
): string {
  switch (l.reasonType) {
    case 'visit': {
      const what = serviceNames.join(' + ') || 'visit';
      if (l.source === 'appointment') return `${what} (appointment)`;
      if (l.source === 'request') return `${what} (requested)`;
      return what;
    }
    case 'deny':
      return `denied a call (${(l.note ?? 'other').replace(/_/g, ' ')})`;
    case 'excuse':
      return 'deny excused by the owner';
    case 'late':
      return `late start (${l.note ?? ''})`;
    case 'out_over':
      return l.note ?? 'out over the limit';
    case 'manual':
      return 'manual adjustment';
    default:
      return l.reasonType;
  }
}

/** Reads the board back and simulates the waiting rows' calls, top to
 *  bottom, each called technician accepting. Nothing it does is kept. */
export async function demoReport(db: Db, locationId: string): Promise<DemoReport> {
  const now = new Date();
  const rules = await activeRules(db, locationId);
  const queue = await db.transaction((tx) => queueFor(tx, locationId, undefined, now));
  const shiftRows = await db
    .select({ technicianId: shifts.technicianId, checkedInAt: shifts.checkedInAt, id: shifts.id })
    .from(shifts)
    .where(eq(shifts.locationId, locationId));
  const ranked = [...shiftRows].sort((a, b) => a.checkedInAt.getTime() - b.checkedInAt.getTime());
  const ledger = shiftRows.length
    ? await db
        .select({
          shiftId: turnLedger.shiftId,
          delta: turnLedger.delta,
          reasonType: turnLedger.reasonType,
          note: turnLedger.note,
          visitId: turnLedger.visitId,
          source: visits.source,
          at: turnLedger.createdAt,
        })
        .from(turnLedger)
        .leftJoin(visits, eq(visits.id, turnLedger.visitId))
        .where(
          inArray(
            turnLedger.shiftId,
            shiftRows.map((s) => s.id),
          ),
        )
        .orderBy(asc(turnLedger.createdAt))
    : [];
  const visitIds = [...new Set(ledger.map((l) => l.visitId).filter((v): v is string => !!v))];
  const items = visitIds.length
    ? await db
        .select({ visitId: visitServices.visitId, name: services.name })
        .from(visitServices)
        .innerJoin(services, eq(services.id, visitServices.serviceId))
        .where(inArray(visitServices.visitId, visitIds))
    : [];
  const statusOf = (c: Candidate) => c.status;
  const board: DemoTechLine[] = queue.map((c, i) => {
    const shift = shiftRows.find((s) => s.technicianId === c.technicianId);
    return {
      turn: i + 1,
      name: c.displayName,
      status: statusOf(c),
      points: c.points,
      hadAppointmentLast: c.hadAppointmentLast,
      checkInRank: shift ? ranked.findIndex((s) => s.id === shift.id) + 1 : 0,
      lines: ledger
        .filter((l) => l.shiftId === shift?.id)
        .map((l) => ({
          delta: Number(l.delta),
          what: describeLine(
            { ...l, delta: Number(l.delta) },
            items.filter((it) => it.visitId === l.visitId).map((it) => it.name),
          ),
        })),
    };
  });

  const nameOfTech = new Map(queue.map((c) => [c.technicianId, c.displayName]));
  const calls: DemoCall[] = [];
  try {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const waiting = (await waitingVisits(txDb, locationId)).filter((v) => v.status === 'waiting');
      for (const v of waiting) {
        const client = v.kioskName ?? v.clientName ?? 'Walk-in';
        if (v.needsConfirm) {
          calls.push({
            client,
            services: v.services,
            picked: null,
            skipped: [],
            needsConfirm: true,
          });
          continue;
        }
        const r = await callNext(txDb, { visitId: v.id, actor: { userId: null }, locationId });
        const skipped = (list: Skipped[]) =>
          list.map((s) => ({
            name: s.displayName,
            why: s.why,
            ...(s.detail ? { detail: s.detail } : {}),
          }));
        if (r.ok) {
          calls.push({
            client,
            services: v.services,
            picked: nameOfTech.get(r.technicianId) ?? '?',
            skipped: skipped(r.skipped),
          });
          must(
            await respondToCall(txDb, {
              callId: r.callId,
              technicianId: r.technicianId,
              response: 'accepted',
              actor: { userId: null },
            }),
            'simulated accept',
          );
        } else {
          calls.push({
            client,
            services: v.services,
            picked: null,
            skipped: skipped(r.skipped ?? []),
            waitingFor: v.requestedTechnician ?? null,
          });
        }
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const appts = await db
    .select({
      technicianId: appointments.technicianId,
      source: appointments.source,
      startAt: appointments.startAt,
      arrivedAt: appointments.arrivedAt,
    })
    .from(appointments)
    .where(and(eq(appointments.locationId, locationId), isNull(appointments.cancelledAt)))
    .orderBy(asc(appointments.startAt));
  const bufferMs = rules.eligibility.upcoming_appointment_buffer_min * 60_000;
  return {
    rules,
    board,
    calls,
    appointments: appts.map((a) => ({
      name: nameOfTech.get(a.technicianId) ?? '?',
      source: a.source === 'ics' ? 'calendar' : 'desk',
      startMin: Math.round((a.startAt.getTime() - now.getTime()) / 60_000),
      state: a.arrivedAt
        ? 'arrived'
        : a.startAt.getTime() < now.getTime() - bufferMs
          ? 'no_show'
          : 'upcoming',
    })),
  };
}

// Rendering ---------------------------------------------------------------------

export function fmtPoints(p: number, hadAppointmentLast = false): string {
  if (p === 0) return hadAppointmentLast ? '00' : '0';
  const sign = p < 0 ? '−' : '';
  const a = Math.abs(p);
  const whole = Math.floor(a);
  const half = a - whole >= 0.5;
  return `${sign}${whole === 0 && half ? '' : whole}${half ? '½' : ''}`;
}

const signed = (p: number) => (p >= 0 ? `+${fmtPoints(p)}` : fmtPoints(p));
const ordinal = (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;

const STATUS: Record<string, string> = {
  available: 'available',
  in_service: 'with a client',
  break: 'on break',
  out: 'out',
  checked_in: 'checked in, not ready',
};

const WHY: Record<string, (detail?: string) => string> = {
  in_service: () => 'with a client',
  break: () => 'on break',
  out: () => 'out',
  checked_in: () => 'not ready yet',
  already_called: () => 'already being called',
  busy: () => 'busy',
  no_skill: (d) => `does not do ${d ?? 'this service'}`,
  no_male_clients: () => 'takes no male clients',
  no_kids: () => 'takes no kids',
  min_client_age: () => 'client under her minimum age',
  no_same_time: () => 'no both-at-once visits',
  appointment_soon: (d) => `appointment in ${d ?? '?'} min`,
};

export function renderDemoExpected(r: DemoReport): string {
  const out: string[] = [];
  const p = r.rules.points;
  out.push(
    '# Demo day: what the engine should do',
    '',
    '<!-- Generated by `npm run -w @turn/db db:seed:demo` from the engine itself.',
    '     packages/db/test/demo.test.ts rebuilds the demo and fails if this file drifts. -->',
    '',
    'Load it with `npm run up -- -Demo` (resets the local database). Then sign in as Phu or Hạnh',
    'and open the board. Clock times change with every load; the order and the numbers below do not.',
    "Valid for about 10 minutes after loading: after that Thảo's appointment gets close enough to",
    'start, and timers move on. Load again for a fresh copy.',
    '',
    '## Rules in force',
    '',
    `- A service: ${signed(p.default_service)}. A fill or full set: ${signed(p.fill_or_full_set)}. Services in one visit add up` +
      (p.combined_fill_full_cap !== null
        ? `, but a visit with a fill or full set in it is capped at ${fmtPoints(p.combined_fill_full_cap)}.`
        : '.'),
    `- An appointment visit: its services ${signed(p.appointment_discount)}. A technician whose last visit was an appointment sorts after others at the same points (0 before 00).`,
    `- A deny: ${signed(r.rules.penalties.deny)}, unless a manager excuses it. Out longer than ${r.rules.penalties.out_over_minutes} min: ${signed(r.rules.penalties.out_over_penalty)}.`,
    `- Late start: ${r.rules.penalties.late_tiers
      .map(
        (t) =>
          `${t.after_minutes}+ min ${t.start_points === null ? 'not decided yet' : signed(t.start_points)}`,
      )
      .join(', ')}.`,
    `- Ties go to the earlier check-in. An appointment within ${r.rules.eligibility.upcoming_appointment_buffer_min} min holds its technician out of the line.`,
    `- A requested technician ${r.rules.requests.requested_tech_bypasses_queue ? 'skips the line: the visit waits for her' : 'is a note only'}.`,
    '',
    '## The board, in queue order',
    '',
    '| Turn | Tech | Status | Points | Checked in | How the points add up |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const b of r.board) {
    const lines = b.lines.length
      ? b.lines.map((l) => `${signed(l.delta)} ${l.what}`).join('; ')
      : 'nothing yet';
    out.push(
      `| ${b.turn} | ${b.name} | ${STATUS[b.status] ?? b.status} | ${fmtPoints(b.points, b.hadAppointmentLast)} | ${ordinal(b.checkInRank)} | ${lines} |`,
    );
  }
  out.push('', 'Why this order:', '');
  for (let i = 1; i < r.board.length; i++) {
    const a = r.board[i - 1]!;
    const b = r.board[i]!;
    let why: string;
    if (a.points !== b.points)
      why = `fewer points (${fmtPoints(a.points)} vs ${fmtPoints(b.points)})`;
    else if (a.hadAppointmentLast !== b.hadAppointmentLast)
      why = `same points, but ${b.name}'s last visit was an appointment`;
    else
      why = `same points, ${a.name} checked in earlier (${ordinal(a.checkInRank)} vs ${ordinal(b.checkInRank)})`;
    out.push(`- ${a.name} before ${b.name}: ${why}.`);
  }
  out.push(
    '',
    '## The next calls',
    '',
    'Press **Call next** on each waiting row, top to bottom; each called tech accepts on her phone',
    '(or the owner accepts for her from Manage).',
    '',
  );
  r.calls.forEach((c, i) => {
    const head = `${i + 1}. **${c.client}**, ${c.services.join(' + ')}`;
    if (c.needsConfirm) {
      out.push(`${head}: a kiosk check-in. It cannot be called until the desk presses Confirm.`);
      return;
    }
    const skipped = c.skipped.length
      ? ` Skipped: ${c.skipped.map((s) => `${s.name} (${(WHY[s.why] ?? (() => s.why))(s.detail)})`).join(', ')}.`
      : '';
    if (c.picked) out.push(`${head} → **${c.picked}**.${skipped}`);
    else if (c.waitingFor)
      out.push(
        `${head} → nobody yet: the client asked for ${c.waitingFor}, so the visit waits for her.${skipped}`,
      );
    else out.push(`${head} → nobody yet: every tech is busy or held out.${skipped}`);
  });
  out.push(
    '',
    '## Appointments today',
    '',
    '| Tech | From | When | State |',
    '| --- | --- | --- | --- |',
  );
  for (const a of r.appointments) {
    const when = a.startMin >= 0 ? `in ${a.startMin} min` : `${-a.startMin} min ago`;
    const state =
      a.state === 'arrived'
        ? 'client arrived (visit done)'
        : a.state === 'no_show'
          ? 'no-show: past the buffer, no longer holds her'
          : a.startMin <= r.rules.eligibility.upcoming_appointment_buffer_min
            ? 'coming up: holds her out of the line'
            : 'later today';
    out.push(
      `| ${a.name} | ${a.source === 'calendar' ? 'Fresha calendar (demo)' : 'desk'} | ${when} | ${state} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

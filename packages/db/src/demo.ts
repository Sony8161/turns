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
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { actedForToday, deskAnswerCall } from './act-for';
import { addAppointment, appointmentArrived, markNoShow } from './appointments';
import { techBoard } from './board';
import { upsertClient } from './clients';
import { DAY_END_ACTIONS } from './day-end';
import {
  callNext,
  clientLeft,
  createWalkIn,
  deskOptions,
  finishVisit,
  leftWithoutService,
  openCallFor,
  queueFor,
  respondToCall,
  waitingVisits,
  type Candidate,
  type Skipped,
} from './engine';
import { reviewFix } from './fixes';
import { askForHelp, openHelpRequests } from './help';
import {
  createKioskDevice,
  kioskCheckIn,
  kioskGroupCheckIn,
  kioskMenu,
  pairKiosk,
  techniciansFor,
  type KioskDevice,
} from './kiosk';
import { requestHolds } from './requests';
import { loadLevels, menuLevels, reaches, setTechnicianLevel, type SkillLevel } from './levels';
import { saveProfile, type ProfileInput } from './profile';
import { activeRules, type RuleConfig } from './rules';
import {
  appointments,
  auditLog,
  calendarFeeds,
  clients,
  helpRequests,
  locations,
  services,
  shifts,
  technicianStatus,
  technicians,
  turnCalls,
  turnLedger,
  visitServices,
  visits,
} from './schema';
import type { Db } from './server';
import { checkIn, sweepFloor, transition, writeAudit } from './status';

export const DEMO_TECH_NAMES = ['Vân', 'Mai', 'Hoa', 'Linh', 'Thảo', 'Tâm'] as const;
/** The service choices the cheat sheet shows the kiosk's technician list for. */
export const DEMO_KIOSK_EXAMPLES = [
  ['Basic pedicure'],
  ['Gel manicure'],
  ['Acrylic fill', 'Spa pedicure'],
];
export type DemoTechName = (typeof DEMO_TECH_NAMES)[number];

/** Who each demo technician is. `level` ticks every service at or below it
 *  (v0.14.0); `not` unticks single services. Tags and restrictions show as chips. */
export const DEMO_PROFILES: Record<
  DemoTechName,
  { level: SkillLevel; not: string[]; tags: string[]; restrictions: ProfileInput['restrictions'] }
> = {
  Vân: { level: 'regular', not: [], tags: ['pedicure', 'design'], restrictions: [] },
  Mai: {
    level: 'acrylic',
    not: ['Nail art / design'],
    tags: ['acrylic', 'pedicure'],
    restrictions: [
      { type: 'no_same_time', value: null, note: null },
      { type: 'custom', value: null, note: 'prefers mornings' },
    ],
  },
  Hoa: {
    level: 'acrylic',
    not: [],
    tags: ['gel', 'acrylic', 'design'],
    restrictions: [{ type: 'min_client_age', value: 12, note: null }],
  },
  Linh: {
    level: 'gel',
    not: [],
    tags: ['design', 'gel'],
    restrictions: [{ type: 'no_kids', value: null, note: null }],
  },
  Thảo: {
    level: 'dip',
    not: ['Nail art / design'],
    tags: ['fast', 'dip'],
    restrictions: [{ type: 'no_male_clients', value: null, note: null }],
  },
  // Does a gel pedicure but not a gel manicure.
  Tâm: {
    level: 'gel',
    not: ['Gel manicure', 'Nail art / design'],
    tags: ['pedicure'],
    restrictions: [],
  },
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
        profile: { skillCategoryIds: null, tags: p.tags, restrictions: p.restrictions },
      }),
      `profile ${n}`,
    );
    // The level ticks the services; `not` unticks single ones.
    const filled = must(
      await setTechnicianLevel(db, { actor: owner, technicianId: tech[n].id, level: p.level }),
      `level ${n}`,
    );
    if (p.not.length) {
      const off = new Set(p.not.map(svc));
      must(
        await setTechnicianLevel(db, {
          actor: owner,
          technicianId: tech[n].id,
          level: p.level,
          serviceIds: filled.serviceIds.filter((id) => !off.has(id)),
        }),
        `services ${n}`,
      );
    }
  }

  // v0.17.0 (DAY-001): yesterday's leftovers. Tâm was still in the chair with
  // a gel pedicure, a walk-in was still waiting and her "Need help" was never
  // answered when the salon closed. Written straight into yesterday (like the
  // fix's earlier visit below); then the first board load of the morning, the
  // floor sweep, closes them: the pedicure is finished with its point on
  // yesterday's shift, the walk-in closes with no points, the help request
  // closes and Tâm is checked out, so she checks in today like everyone else.
  const midnight = minus(now, sinceMidnight);
  const yesterday = localDay(minus(midnight, 60), tz);
  const [oldShift] = await db
    .insert(shifts)
    .values({
      organizationId: ctx.organizationId,
      locationId: ctx.locationId,
      technicianId: tech['Tâm'].id,
      date: yesterday,
      checkedInAt: minus(midnight, 14 * 60),
      readyAt: minus(midnight, 14 * 60 - 1),
    })
    .returning({ id: shifts.id });
  await db
    .insert(technicianStatus)
    .values({
      technicianId: tech['Tâm'].id,
      organizationId: ctx.organizationId,
      locationId: ctx.locationId,
      status: 'in_service',
      since: minus(midnight, 4 * 60 + 30),
      shiftId: oldShift!.id,
    })
    .onConflictDoUpdate({
      target: technicianStatus.technicianId,
      set: { status: 'in_service', since: minus(midnight, 4 * 60 + 30), shiftId: oldShift!.id },
    });
  for (const [status, name, at] of [
    ['in_service', 'Gel pedicure', minus(midnight, 4 * 60 + 35)],
    ['waiting', 'Basic pedicure', minus(midnight, 4 * 60 + 10)],
  ] as const) {
    const [row] = await db
      .insert(visits)
      .values({
        organizationId: ctx.organizationId,
        locationId: ctx.locationId,
        source: 'walk_in',
        status,
        ...(status === 'in_service'
          ? { assignedTechnicianId: tech['Tâm'].id, startedAt: plus(at, 5) }
          : {}),
        createdBy: ctx.receptionistUserId,
        arrivedAt: at,
      })
      .returning({ id: visits.id });
    await db.insert(visitServices).values({
      organizationId: ctx.organizationId,
      visitId: row!.id,
      serviceId: svc(name),
      pointsValueSnapshot: '1.0',
    });
  }
  await db.insert(helpRequests).values({
    organizationId: ctx.organizationId,
    locationId: ctx.locationId,
    technicianId: tech['Tâm'].id,
    createdAt: minus(midnight, 4 * 60 + 20),
  });
  await sweepFloor(db, ctx.locationId, now);

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
  const deny = async (
    callId: string,
    n: DemoTechName,
    reason: 'other' | 'break_needed' | 'personal',
  ) =>
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

  // Mai and Hoa: an acrylic fill with a spa pedicure. Mai is first (checked
  // in earlier) and denies it without a reason the rules excuse (+1). Hoa does
  // both: ½ + 1 = 1½. Services in one visit add up, no cap (v0.15.0).
  await ready('Mai', plus(checkInAt(1), 1));
  await ready('Hoa', plus(checkInAt(2), 1));
  const combo = await walkIn(['Acrylic fill', 'Spa pedicure']);
  await deny(await call(combo.visitId, 'Mai'), 'Mai', 'other');
  await accept(await call(combo.visitId, 'Hoa'), 'Hoa');
  await finish('Hoa');

  // Thảo: a dip powder. She is lowest (0) and says she needs a break: the
  // rules excuse that on their own (v0.15.0), so no points and no manager.
  // She is not called for this client again; Mai (1) is next for it: +1.
  await ready('Thảo', plus(checkInAt(4), 1));
  const dip = await walkIn(['Dip powder']);
  await deny(await call(dip.visitId, 'Thảo'), 'Thảo', 'break_needed');
  await accept(await call(dip.visitId, 'Mai'), 'Mai');
  await finish('Mai');
  // v0.17.0 (FAIR-001, WALK-001): two more clients come to Thảo (still the
  // lowest) and she says no for free both times, so her card gets the
  // "Free no today: 3" badge. Both clients then walk out before
  // anyone else is called: Left without service, no points for anyone.
  for (const [name, reason] of [
    ['Basic pedicure', 'personal'],
    ['Spa pedicure', 'break_needed'],
  ] as const) {
    const gone = await walkIn([name]);
    await deny(await call(gone.visitId, 'Thảo'), 'Thảo', reason);
    must(
      await leftWithoutService(db, {
        visitId: gone.visitId,
        actor: { userId: ctx.receptionistUserId },
        locationId: ctx.locationId,
      }),
      'walk-out',
    );
  }

  // Linh: her calendar client arrived for a gel fill: ½ − ½ = 0. Her last
  // visit was an appointment, so she shows 00 and goes after Thảo's true 0.
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
      serviceIds: [svc('Gel fill')],
      actor: desk,
    }),
    'Linh appointment arrived',
  );
  await accept(await call(arrived.visitId, 'Linh'), 'Linh');
  await finish('Linh');

  // Hoa again: a client asked for her (a request skips the line). In service now.
  const request = await walkIn(['Spa pedicure'], {
    requestedTechnicianId: tech['Hoa'].id,
    client: { name: 'Kim Le', phone: '813-555-0210' },
  });
  // v0.17.0 (DESK-001): Hoa's phone is in her bag, so Hạnh at the desk
  // presses "Accept for Hoa". Her phone later shows "Accepted for you by Hạnh".
  must(
    await deskAnswerCall(db, {
      actor: { ...desk, role: 'receptionist' as const },
      callId: await call(request.visitId, 'Hoa'),
      response: 'accepted',
    }),
    'Hạnh accepts for Hoa',
  );

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

  // v0.17.0 (WALK-001): Kim Le had also booked Thảo by phone 90 minutes ago
  // and never came for it: Hạnh marked it a no-show (Kim Le's client page
  // counts it). Tâm's calendar client from 40 minutes ago is left for the desk
  // to mark (Appointments, More, No-show).
  const [kim] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.locationId, ctx.locationId), eq(clients.phone, '+18135550210')));
  const booked = must(
    await addAppointment(db, {
      actor: desk,
      technicianId: tech['Thảo'].id,
      clientName: 'Kim Le',
      clientId: kim?.id ?? null,
      startAt: minus(now, 90),
      endAt: minus(now, 45),
    }),
    'Kim Le booked',
  );
  must(
    await markNoShow(db, { actor: desk, appointmentId: booked.appointmentId }),
    'Kim Le no-show',
  );

  // Waiting, oldest first: the cheat sheet calls them top to bottom.
  // Asked for Hoa, who is with a client: the visit waits for her, never falls
  // back. She arrived 12 minutes ago (the one row whose arrival is set by
  // hand), so the desk's flag is already up: keep waiting, book, or by turn.
  const asked = await walkIn(['Gel manicure'], {
    requestedTechnicianId: tech['Hoa'].id,
    client: { name: 'Thu Pham', phone: '813-555-0203' },
    attributes: { gender: 'female', isKid: false, age: null },
  });
  await db
    .update(visits)
    .set({ arrivedAt: sql`${visits.arrivedAt} - interval '12 minutes'` })
    .where(eq(visits.id, asked.visitId));
  // Nail art: the desk picks the technician.
  await walkIn(['Nail art / design'], {
    client: { name: 'Hanh Bui', phone: '813-555-0205' },
    attributes: { gender: 'female', isKid: false, age: null },
    note: 'Chrome flowers, two accent nails',
  });
  // Two services, one after the other: the first technician who gets one of
  // them by turn is called. Linh (gel) does the pedicure, not the dip: the dip
  // waits until she is done, then goes by turn with an on-screen slip.
  await walkIn(['Dip powder', 'Basic pedicure'], {
    client: { name: 'Ngoc Vo', phone: '813-555-0204' },
    attributes: { gender: 'female', isKid: false, age: null },
    note: 'Ombre on the dip',
  });
  await walkIn(['Basic pedicure'], {
    client: { name: 'An Do' },
    attributes: { gender: 'female', isKid: true, age: 8 },
  });
  // A regular manicure: the only free technician left, Mai, is acrylic level,
  // so she is skipped (it goes to regular and gel by turn) and the desk may ask her.
  await walkIn(['Basic manicure'], {
    client: { name: 'Minh Tran', phone: '813-555-0202', gender: 'male' },
    attributes: { gender: 'male', isKid: false, age: null },
  });
  await walkIn(['Gel manicure'], {
    client: { name: 'Lan Nguyen', phone: '813-555-0201' },
    attributes: { gender: 'female', isKid: false, age: null },
  });
  const device = must(
    await createKioskDevice(db, { actor: owner, name: 'Demo kiosk', pin: ctx.kioskPin }),
    'demo kiosk',
  );
  const paired = must(await pairKiosk(db, { code: device.pairingCode }), 'pair demo kiosk');
  // The kiosk lists only who is in today and does the chosen service; Bích picked Vân.
  must(
    await kioskCheckIn(db, {
      device: paired.device,
      name: 'Bích',
      serviceIds: [svc('Basic manicure')],
      attributes: { gender: 'female', isKid: false, age: null },
      requestedTechnicianId: tech['Vân'].id,
      note: 'French tip, almond shape',
    }),
    'kiosk check-in',
  );

  // v0.16.0. A fix: Trang Ho had a gel manicure with Linh five days ago (an
  // earlier day, so it is written straight into the history) and is back with
  // a chipped nail. Hạnh, a receptionist, enters the fix: it waits for a
  // manager or owner to approve it, then the desk picks Linh first.
  const fixDay = minus(now, 5 * 24 * 60);
  const trang = await db.transaction((tx) =>
    upsertClient(tx, {
      organizationId: ctx.organizationId,
      locationId: ctx.locationId,
      firstName: 'Trang',
      lastName: 'Ho',
      phone: '813-555-0206',
      gender: 'female',
    }),
  );
  if (!trang.ok || !trang.clientId) throw new Error('demo: fix client');
  const [earlier] = await db
    .insert(visits)
    .values({
      organizationId: ctx.organizationId,
      locationId: ctx.locationId,
      source: 'walk_in',
      status: 'completed',
      clientId: trang.clientId,
      clientGender: 'female',
      assignedTechnicianId: tech['Linh'].id,
      createdBy: ctx.receptionistUserId,
      arrivedAt: fixDay,
      startedAt: fixDay,
      completedAt: plus(fixDay, 45),
      pointsPosted: '1.0',
    })
    .returning({ id: visits.id });
  await db.insert(visitServices).values({
    organizationId: ctx.organizationId,
    visitId: earlier!.id,
    serviceId: svc('Gel manicure'),
    pointsValueSnapshot: '1.0',
  });
  must(
    await createWalkIn(db, {
      organizationId: ctx.organizationId,
      locationId: ctx.locationId,
      serviceIds: [svc('Nail fix / repair')],
      actor: { userId: ctx.receptionistUserId },
      fix: { enteredBy: 'receptionist', ofVisitId: earlier!.id },
    }),
    'fix entered by the receptionist',
  );

  // A group of three checks in on the kiosk ("We're a group"): one visit
  // each, linked, waiting for the desk to confirm all at once or one by one.
  must(
    await kioskGroupCheckIn(db, {
      device: paired.device,
      phone: '813-555-0207',
      people: [
        { name: 'Quynh', lastName: 'Tran', serviceIds: [svc('Gel manicure')] },
        { name: 'Hien', serviceIds: [svc('Basic pedicure')], note: 'Short and square' },
        { name: 'Ly', serviceIds: [svc('Polish change')] },
      ],
    }),
    'kiosk group',
  );

  // Called, not started: Linh is next in line (Thảo is held for her
  // appointment) and is called for Sara Kim, who then walks out. The desk
  // (or Linh on her phone) presses "Client left": no points, Linh keeps her place.
  const gone = await walkIn(['Gel manicure'], {
    client: { name: 'Sara Kim' },
    attributes: { gender: 'female', isKid: false, age: null },
  });
  await call(gone.visitId, 'Linh');
  // v0.17.0 (FAIR-001): Linh taps "Client left" on her phone; under the rules
  // the desk confirms first, so the row shows "Linh says the client left".
  must(
    await clientLeft(db, {
      visitId: gone.visitId,
      actor: actorOf('Linh'),
      locationId: ctx.locationId,
      technicianId: tech['Linh'].id,
    }),
    'Linh says the client left',
  );

  // Mai taps "Need help" on her phone: the desk board shows it until someone
  // presses "On my way".
  must(
    await askForHelp(db, {
      technicianId: tech['Mai'].id,
      actor: actorOf('Mai'),
      reason: 'Need more acetone at station 4',
    }),
    'Mai asks for help',
  );
}

/** One calendar row per demo technician who has calendar appointments:
 *  connected, synced five minutes ago, with a placeholder link. */
async function demoFeeds(
  db: Db,
  ctx: DemoContext,
  tech: Record<DemoTechName, { id: string; userId: string }>,
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
  // v0.17.1 (review #6): Vân added her own Fresha calendar; it waits for the
  // owner or a manager on Appointments and holds nothing until then.
  await db.insert(calendarFeeds).values({
    organizationId: ctx.organizationId,
    locationId: ctx.locationId,
    technicianId: tech['Vân'].id,
    url: demoFeedUrl('Vân'),
    urlHint: 'demo calendar',
    needsApproval: true,
    createdBy: tech['Vân'].userId,
  });
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
  /** v0.15.0: denies the rules excused on their own (no ledger row): the reasons. */
  excusedDenies: string[];
  turn: number;
  name: string;
  level: SkillLevel | null;
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
  /** v0.14.0: the desk picks the technician: who does it, and who is free now. */
  deskPick?: { name: string; status: string; canCall: boolean; original?: boolean }[];
  /** Higher-level technicians the desk may ask (held out by the level rule alone). */
  mayAsk?: string[];
  /** Two or more services: the called technician chooses all or split. */
  mixed?: boolean;
  /** v0.15.0: she does only these of the visit's services... */
  takes?: string[];
  /** ...and these wait until she is done, then go by turn with the slip. */
  restWaits?: string[];
  /** v0.15.0: the asked-for technician is busy: what the desk row shows. */
  hold?: { status: string; attention: boolean };
  /** A kiosk check-in that asked for a technician (pending the desk's confirm). */
  askedFor?: string | null;
  /** v0.16.0: one of a group that came in together. */
  partySize?: number | null;
  /** v0.16.0: a fix: who did the original work, how long ago, and whether
   *  it waited for approval (approved in the simulation, then the desk picks). */
  fix?: { original: string | null; daysAgo: number | null; pending: boolean };
};
/** v0.16.0: a called visit whose client left before the service started.
 *  v0.17.0: claimed = the tech tapped it and the desk confirms first. */
export type DemoLeft = {
  client: string;
  services: string[];
  technician: string;
  claimed: boolean;
};
/** v0.15.0: who the kiosk offers for a choice of services (names only). */
export type DemoKioskChoice = { services: string[]; technicians: string[] };
export type DemoLevel = { name: string; level: SkillLevel | null; not: string[] };
export type DemoService = { name: string; turnLevels: SkillLevel[] | null; deskPicks: boolean };
export type DemoAppointment = {
  name: string;
  source: 'calendar' | 'desk';
  startMin: number;
  /** v0.17.0: no_show_marked = the desk pressed No-show. */
  state: 'arrived' | 'upcoming' | 'no_show' | 'no_show_marked';
};
export type DemoReport = {
  rules: RuleConfig;
  board: DemoTechLine[];
  calls: DemoCall[];
  appointments: DemoAppointment[];
  levels: DemoLevel[];
  menu: DemoService[];
  kiosk: DemoKioskChoice[];
  /** v0.16.0 */
  left: DemoLeft[];
  /** A service's own points (rules by_service), by name. */
  servicePoints: { name: string; points: number }[];
  help: { name: string; reason: string | null }[];
  /** v0.17.0: what the desk did for a tech today, as her phone lists it. */
  doneFor: { name: string; what: string; by: string | null }[];
  /** v0.17.0: techs with the free-deny badge, and their free no's today. */
  freeDenyBadges: { name: string; n: number }[];
  /** v0.17.0: clients who left without service today. */
  walkOuts: number;
  /** v0.17.0: what the morning sweep closed for yesterday. */
  closedYesterday: Record<string, number>;
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
  const [loc] = await db
    .select({ timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, locationId));
  const tz = loc?.timezone ?? 'America/New_York';
  const today = localDay(now, tz);
  // Today's shifts only (v0.17.0: the demo also has yesterday's leftovers).
  const shiftRows = await db
    .select({ technicianId: shifts.technicianId, checkedInAt: shifts.checkedInAt, id: shifts.id })
    .from(shifts)
    .where(and(eq(shifts.locationId, locationId), eq(shifts.date, today)));
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
  const excused = await db
    .select({ technicianId: turnCalls.technicianId, reason: turnCalls.denyReason })
    .from(turnCalls)
    .where(and(eq(turnCalls.locationId, locationId), eq(turnCalls.autoExcused, true)))
    .orderBy(asc(turnCalls.respondedAt));
  const board: DemoTechLine[] = queue.map((c, i) => {
    const shift = shiftRows.find((s) => s.technicianId === c.technicianId);
    return {
      excusedDenies: excused
        .filter((e) => e.technicianId === c.technicianId)
        .map((e) => e.reason ?? 'other'),
      turn: i + 1,
      name: c.displayName,
      level: c.level ?? null,
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
  const left: DemoLeft[] = [];
  const help = (await openHelpRequests(db, locationId)).map((h) => ({
    name: h.technician,
    reason: h.reason,
  }));
  try {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      // v0.16.0: first, the called visit whose client walked out: "Client left".
      for (const v of (await waitingVisits(txDb, locationId)).filter(
        (x) => x.status === 'called',
      )) {
        const r = must(
          await clientLeft(txDb, { visitId: v.id, actor: { userId: null }, locationId }),
          'simulated client left',
        );
        left.push({
          client: v.kioskName ?? v.clientName ?? 'Walk-in',
          services: v.services,
          technician: nameOfTech.get(r.technicianId) ?? '?',
          claimed: v.leftClaimPending === true,
        });
      }
      const waiting = (await waitingVisits(txDb, locationId)).filter((v) => v.status === 'waiting');
      const holds = await requestHolds(txDb, locationId, now);
      for (const v of waiting) {
        const client = v.kioskName ?? v.clientName ?? 'Walk-in';
        if (v.needsConfirm) {
          calls.push({
            client,
            services: v.services,
            picked: null,
            skipped: [],
            needsConfirm: true,
            askedFor: v.requestedTechnician ?? null,
            ...(v.partySize && v.partySize > 1 ? { partySize: v.partySize } : {}),
          });
          continue;
        }
        // v0.16.0: a fix a receptionist entered: a manager approves it here.
        const fix = v.isFix
          ? {
              original: v.fixOf?.technician ?? null,
              daysAgo: v.fixOf
                ? Math.round((now.getTime() - v.fixOf.at.getTime()) / (24 * 60 * 60_000))
                : null,
              pending: v.needsApproval,
            }
          : undefined;
        if (v.needsApproval) {
          const [loc] = await txDb
            .select({ organizationId: locations.organizationId })
            .from(locations)
            .where(eq(locations.id, locationId));
          must(
            await reviewFix(txDb, {
              actor: { userId: null, organizationId: loc!.organizationId, locationId },
              visitId: v.id,
              decision: 'approve',
            }),
            'simulated fix approval',
          );
        }
        const r = await callNext(txDb, { visitId: v.id, actor: { userId: null }, locationId });
        const skipped = (list: Skipped[]) =>
          list.map((s) => ({
            name: s.displayName,
            why: s.why,
            ...(s.detail ? { detail: s.detail } : {}),
          }));
        if (!r.ok && r.reason === 'desk_picks') {
          const o = (await deskOptions(txDb, locationId)).get(v.id);
          calls.push({
            client,
            services: v.services,
            picked: null,
            skipped: [],
            deskPick: (o?.technicians ?? []).map((t) => ({
              name: t.displayName,
              status: t.status,
              canCall: t.canCall,
              ...(t.original ? { original: true } : {}),
            })),
            ...(fix ? { fix } : {}),
          });
          continue;
        }
        if (r.ok) {
          // What she does of it, from her own call card.
          const card = await openCallFor(txDb, r.technicianId);
          const takes = (card?.serviceItems ?? []).filter((s) => s.canDo).map((s) => s.name);
          const partial = takes.length < v.services.length;
          const answered = must(
            await respondToCall(txDb, {
              callId: r.callId,
              technicianId: r.technicianId,
              response: 'accepted',
              actor: { userId: null },
            }),
            'simulated accept',
          );
          let restWaits: string[] | undefined;
          if (answered.splitVisitId) {
            const again = await callNext(txDb, {
              visitId: answered.splitVisitId,
              actor: { userId: null },
              locationId,
            });
            if (again.ok || again.reason !== 'waits_for_first_part') {
              throw new Error('demo: the rest of a split visit should wait for the first part');
            }
            restWaits = (card?.serviceItems ?? []).filter((s) => !s.canDo).map((s) => s.name);
          }
          calls.push({
            client,
            services: v.services,
            picked: nameOfTech.get(r.technicianId) ?? '?',
            skipped: skipped(r.skipped),
            ...(v.services.length > 1 && !partial ? { mixed: true } : {}),
            ...(partial ? { takes } : {}),
            ...(restWaits ? { restWaits } : {}),
          });
        } else {
          calls.push({
            client,
            services: v.services,
            picked: null,
            skipped: skipped(r.skipped ?? []),
            waitingFor: v.requestedTechnician ?? null,
            ...(holds.get(v.id)
              ? {
                  hold: {
                    status: holds.get(v.id)!.status,
                    attention: holds.get(v.id)!.attention,
                  },
                }
              : {}),
            mayAsk: ((await deskOptions(txDb, locationId)).get(v.id)?.technicians ?? [])
              .filter((t) => t.canCall)
              .map((t) => t.displayName),
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
      noShowAt: appointments.noShowAt,
    })
    .from(appointments)
    .where(and(eq(appointments.locationId, locationId), isNull(appointments.cancelledAt)))
    .orderBy(asc(appointments.startAt));
  // v0.17.0: the desk acting for a tech, the free-deny badge, walk-outs and
  // what the morning sweep closed for yesterday.
  const doneFor: DemoReport['doneFor'] = [];
  for (const c of queue) {
    for (const d of await actedForToday(db, c.technicianId, now)) {
      doneFor.push({ name: c.displayName, what: d.what, by: d.by });
    }
  }
  const freeDenyBadges = (await techBoard(db, locationId, now))
    .filter((c) => c.freeDenyFlag)
    .map((c) => ({ name: c.displayName, n: c.freeDenies }));
  const [walked] = await db
    .select({ n: sql<string>`count(*)` })
    .from(visits)
    .where(
      and(
        eq(visits.locationId, locationId),
        eq(visits.status, 'left'),
        eq(visits.closeReason, 'walked_out'),
      ),
    );
  const yesterday = new Date(`${today}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const closedRows = await db
    .select({ action: auditLog.action, n: sql<string>`count(*)` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.locationId, locationId),
        inArray(auditLog.action, [...DAY_END_ACTIONS]),
        sql`${auditLog.after}->>'forDay' = ${yesterday.toISOString().slice(0, 10)}`,
      ),
    )
    .groupBy(auditLog.action);
  const closedYesterday = Object.fromEntries(
    DAY_END_ACTIONS.map((a) => [a, Number(closedRows.find((r) => r.action === a)?.n ?? 0)]),
  );
  const bufferMs = rules.eligibility.upcoming_appointment_buffer_min * 60_000;
  const menu = await menuLevels(db, locationId);
  const ticks = await loadLevels(db, locationId);
  // v0.15.0: who the kiosk offers (on shift today, does every chosen service).
  const kioskTechs = (await kioskMenu(db, { locationId } as KioskDevice)).technicians;
  const kiosk: DemoKioskChoice[] = DEMO_KIOSK_EXAMPLES.map((names) => ({
    services: names,
    technicians: techniciansFor(
      kioskTechs,
      names.map((n) => menu.find((m) => m.name === n)?.id ?? ''),
    ).map((t) => t.name),
  }));
  return {
    rules,
    board,
    calls,
    left,
    help,
    doneFor,
    freeDenyBadges,
    walkOuts: Number(walked?.n ?? 0),
    closedYesterday,
    servicePoints: menu
      .filter((m) => rules.points.by_service?.[m.id] !== undefined)
      .map((m) => ({ name: m.name, points: rules.points.by_service![m.id]! })),
    kiosk,
    menu: menu.map((m) => ({ name: m.name, turnLevels: m.turnLevels, deskPicks: m.deskPicks })),
    levels: queue.map((c) => {
      const t = ticks.get(c.technicianId);
      return {
        name: c.displayName,
        level: t?.level ?? null,
        // What her level would tick but the owner unticked.
        not: t
          ? menu
              .filter((m) => reaches(t.level, m.minLevel) && !t.serviceIds.has(m.id))
              .map((m) => m.name)
          : [],
      };
    }),
    appointments: appts.map((a) => ({
      name: nameOfTech.get(a.technicianId) ?? '?',
      source: a.source === 'ics' ? 'calendar' : 'desk',
      startMin: Math.round((a.startAt.getTime() - now.getTime()) / 60_000),
      state: a.arrivedAt
        ? 'arrived'
        : a.noShowAt
          ? 'no_show_marked'
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
  called: 'called, waiting for her answer',
  available: 'available',
  in_service: 'with a client',
  break: 'on break',
  out: 'out',
  checked_in: 'checked in, not ready',
  // v0.17.1: Pick a tech says "Held: 2:30 PM appt".
  held: 'held for her appointment',
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
  not_by_turn: (d) => `${d ?? 'this service'} is not her level's by turn`,
  said_no: () => 'said no to this client (excused), not called for it again',
};

const REASON: Record<string, string> = {
  not_my_service: 'not my service',
  with_another_client: 'with another client',
  break_needed: 'need a break',
  personal: 'personal',
  client_issue: 'client issue',
  other: 'other',
};

const LEVEL: Record<SkillLevel, string> = {
  regular: 'regular polish',
  gel: 'gel',
  dip: 'dip',
  acrylic: 'acrylic',
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
    `- An appointment visit: its services ${signed(p.appointment_discount)}. ` +
      (r.rules.queue.sort.includes('double_zero_last')
        ? 'At zero points only, a technician whose last visit was an appointment shows 00 and goes after a true 0; a 00 is still ahead of everyone above zero, and above zero the appointment changes nothing.'
        : r.rules.queue.sort.includes('had_appointment_last')
          ? 'A technician whose last visit was an appointment sorts after others at the same points (0 before 00).'
          : 'An appointment does not change the order.'),
    `- A deny: ${signed(r.rules.penalties.deny)}, unless a manager excuses it.` +
      (r.rules.penalties.deny_excused_reasons.length
        ? ` These reasons excuse themselves (no points, no manager): ${r.rules.penalties.deny_excused_reasons.map((x) => `"${REASON[x] ?? x}"`).join(', ')}. She is not called for that client again.`
        : '') +
      ` Out longer than ${r.rules.penalties.out_over_minutes} min: ${signed(r.rules.penalties.out_over_penalty)}.`,
    `- Late start: ${r.rules.penalties.late_tiers
      .map(
        (t) =>
          `${t.after_minutes}+ min ${t.start_points === null ? 'not decided yet' : signed(t.start_points)}`,
      )
      .join(', ')}.`,
    `- Ties go to the earlier check-in. An appointment within ${r.rules.eligibility.upcoming_appointment_buffer_min} min holds its technician out of the line.`,
    `- A requested technician ${r.rules.requests.requested_tech_bypasses_queue ? `skips the line: the visit waits for her and never falls back on its own. While she is busy the desk row shows her status and next appointment; after ${r.rules.attention.request_wait_min} min of waiting it is flagged, and the desk picks **Keep waiting**, **Book for later** or **Send by turn**` : 'is a note only'}.`,
    '- Levels are a ladder: regular polish, gel, dip, acrylic. A service goes by turn only to the levels listed for it below. A higher-level tech who is next keeps her place and is skipped with no penalty; the desk may ask her (**Ask a higher-level tech**), and saying no costs nothing.',
    "- A visit with two or more services goes by turn to the first tech who gets at least one of them. If she does all of them she chooses **Do all** or **Split**; if she does only some she takes those. The rest waits until she is finished, then goes by turn with the client's original wait, and the next tech's call card shows a slip: who did what, what is left, and the request note.",
    '- The kiosk offers only techs who are in today and do every chosen service, with **Anyone** first.',
    `- A requested visit counts ${
      r.rules.requests.requested_counts_points === null ||
      r.rules.requests.requested_counts_points === 1
        ? 'as a full normal turn'
        : `at ${r.rules.requests.requested_counts_points}× its points`
    }; a manager can still adjust points by hand.`,
    ...(r.servicePoints.length
      ? [
          `- A service's own points come first: ${r.servicePoints
            .map((s) => `${s.name} ${fmtPoints(s.points)}`)
            .join(', ')}.`,
        ]
      : []),
    `- A nail fix or repair is free and entered at the desk only (never the kiosk). The desk sees the client's visits from the last ${r.rules.fixes.window_days} days` +
      (r.rules.fixes.receptionist_needs_approval
        ? '; a fix a receptionist enters waits for a manager or owner to approve it'
        : '') +
      '. The desk picks the tech, the one who did the work first; saying no costs nothing.',
    `- A group checks in together (up to ${r.rules.groups.max_people}): each person is their own client and visit, called by turn on their own.`,
    '- A called visit whose client walks out before the service starts: **Client left**. No points, the tech keeps her place.' +
      (r.rules.fairness.client_left_by_tech === 'ask_desk'
        ? ' When the tech taps it on her phone, the desk confirms first: **Yes, the client left** or **The client is here**.'
        : ''),
    '- A waiting client who walks out before anyone is called: **Left without service** (under **More** on the row). A booked client who never comes: **No-show** (under **More** on Appointments, once the start time has passed). Neither counts against any tech.',
    '- The desk can act for a tech whose phone is not at hand: **Accept for** or **Finish for** her on her current visit (the desk row or her card), **Deny for** her under **More**, with the same points as her phone. Her phone lists what was done for her.',
    `- Saying no for free (${r.rules.penalties.deny_excused_reasons.map((x) => `"${REASON[x] ?? x}"`).join(', ') || 'no reason is free'}): ` +
      (r.rules.fairness.free_deny_flag > 0
        ? `after ${r.rules.fairness.free_deny_flag} in a day her card shows a small badge`
        : 'no badge') +
      (r.rules.fairness.free_deny_daily_limit === null
        ? '; there is no daily limit.'
        : `; after ${r.rules.fairness.free_deny_daily_limit} a day the next one costs the deny penalty.`),
    '- At day end, whatever is left open closes: waiting and called clients with no points or penalty, a client still in the chair is finished with its points on that day, open calls and help requests close, and everyone is checked out. The end-of-day summary lists it.',
    '',
    '## Levels',
    '',
    '| Tech | Level | Does not do (unticked by the owner) |',
    '| --- | --- | --- |',
    ...r.levels.map(
      (l) =>
        `| ${l.name} | ${l.level ? LEVEL[l.level] : 'not set'} | ${l.not.join(', ') || 'nothing unticked'} |`,
    ),
    '',
    '| Service | Goes by turn to |',
    '| --- | --- |',
    ...r.menu.map(
      (m) =>
        `| ${m.name} | ${m.deskPicks ? 'nobody: the desk picks the tech' : m.turnLevels ? m.turnLevels.map((l) => LEVEL[l]).join(', ') : 'every level'} |`,
    ),
    '',
    '## The board, in queue order',
    '',
    '| Turn | Tech | Level | Status | Points | Checked in | How the points add up |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const b of r.board) {
    const parts = [
      ...b.lines.map((l) => `${signed(l.delta)} ${l.what}`),
      ...b.excusedDenies.map(
        (x) => `said no once ("${REASON[x] ?? x}"): excused by the rules, no points`,
      ),
      ...(r.freeDenyBadges.some((f) => f.name === b.name)
        ? [`card badge "Free no today: ${r.freeDenyBadges.find((f) => f.name === b.name)!.n}"`]
        : []),
    ];
    const lines = parts.length ? parts.join('; ') : 'nothing yet';
    out.push(
      `| ${b.turn} | ${b.name} | ${b.level ? LEVEL[b.level] : 'not set'} | ${STATUS[b.status] ?? b.status} | ${fmtPoints(b.points, b.hadAppointmentLast)} | ${ordinal(b.checkInRank)} | ${lines} |`,
    );
  }
  out.push('', 'Why this order:', '');
  for (let i = 1; i < r.board.length; i++) {
    const a = r.board[i - 1]!;
    const b = r.board[i]!;
    let why: string;
    if (a.points !== b.points)
      why = `fewer points (${fmtPoints(a.points)} vs ${fmtPoints(b.points)})`;
    else if (
      a.hadAppointmentLast !== b.hadAppointmentLast &&
      (r.rules.queue.sort.includes('had_appointment_last') ||
        (r.rules.queue.sort.includes('double_zero_last') && a.points === 0))
    )
      why = `both at zero, but ${b.name}'s last visit was an appointment (0 before 00)`;
    else
      why = `same points, ${a.name} checked in earlier (${ordinal(a.checkInRank)} vs ${ordinal(b.checkInRank)})`;
    out.push(`- ${a.name} before ${b.name}: ${why}.`);
  }
  out.push(
    '',
    '## The next calls',
    '',
    'Press **Call next** on each waiting row, top to bottom; each called tech accepts on her phone',
    '(or the desk presses **Accept for** her on the row).',
    '',
  );
  for (const l of r.left) {
    out.push(
      l.claimed
        ? `First: **${l.client}** (${l.services.join(' + ')}) was called to ${l.technician}, who tapped **Client left** on her phone. The row says "${l.technician} says the client left": press **Yes, the client left** (no points, ${l.technician} keeps her place) or **The client is here** (her call stays open).`
        : `First: **${l.client}** (${l.services.join(' + ')}) shows ${l.technician} called, but the client walked out. Press **Client left** on the row (or ${l.technician} presses it on her phone): no points, ${l.technician} keeps her place.`,
      '',
    );
  }
  r.calls.forEach((c, i) => {
    const head = `${i + 1}. **${c.client}**, ${c.services.join(' + ')}`;
    if (c.needsConfirm) {
      out.push(
        `${head}: a kiosk check-in${c.partySize ? `, one of a group of ${c.partySize} (the desk row says "Group of ${c.partySize}"; **Confirm all ${c.partySize}** or one by one)` : ''}. It cannot be called until the desk presses Confirm.` +
          (c.askedFor
            ? ` The client picked ${c.askedFor} on the kiosk: **Confirm** keeps the request, **Confirm, no request** sends it by turn.`
            : ''),
      );
      return;
    }
    const skipped = c.skipped.length
      ? ` Skipped: ${c.skipped.map((s) => `${s.name} (${(WHY[s.why] ?? (() => s.why))(s.detail)})`).join(', ')}.`
      : '';
    if (c.deskPick) {
      const who = c.deskPick
        .map(
          (t) =>
            `${t.name} (${t.canCall ? 'free' : (STATUS[t.status] ?? t.status)}${t.original ? ', did the original work' : ''})`,
        )
        .join(', ');
      const fix = c.fix
        ? ` A fix of ${c.fix.original ?? 'nobody found'}'s work${c.fix.daysAgo !== null ? ` ${c.fix.daysAgo} days ago` : ''}, free.` +
          (c.fix.pending
            ? ' Hạnh (receptionist) entered it, so it waits until a manager or owner presses **Approve fix** (sign in as Phu or Vy); the sheet assumes approved.'
            : '')
        : '';
      out.push(
        `${head} → never called by turn.${fix} Press **Pick a tech**: ${who || 'nobody does it'}. The picked tech may say no with no penalty.`,
      );
      return;
    }
    const mixed = c.mixed
      ? ` On her phone she chooses **Do all** or **Split** (the sheet assumes Do all).`
      : '';
    const ask = c.mayAsk?.length
      ? ` The desk may press **Ask a higher-level tech**: ${c.mayAsk.join(', ')}.`
      : '';
    const partial = c.takes
      ? ` She does ${c.takes.join(' + ')} only, so she takes that.` +
        (c.restWaits?.length
          ? ` ${c.restWaits.join(' + ')} stays on the desk as "waits until ${c.picked} finishes", then goes by turn with the slip.`
          : '')
      : '';
    if (c.picked) out.push(`${head} → **${c.picked}**.${skipped}${mixed}${partial}`);
    else if (c.waitingFor)
      out.push(
        `${head} → nobody yet: the client asked for ${c.waitingFor}, so the visit waits for her and never falls back.` +
          (c.hold
            ? ` The row shows ${c.waitingFor}: ${(WHY[c.hold.status] ?? (() => c.hold!.status))()}.` +
              (c.hold.attention
                ? ' It is flagged already (this client arrived 12 minutes ago): **Keep waiting**, **Book for later** or **Send by turn**.'
                : '')
            : ''),
      );
    else out.push(`${head} → nobody by turn yet.${skipped}${ask}`);
  });
  out.push(
    '',
    '## The kiosk: who a client can pick',
    '',
    'Only techs who are in today and do every chosen service, names only, with **Anyone** first.',
    '',
    '| Services chosen | Techs offered |',
    '| --- | --- |',
    ...r.kiosk.map(
      (k) =>
        `| ${k.services.join(' + ')} | Anyone, ${k.technicians.join(', ') || '(nobody else)'} |`,
    ),
  );
  if (r.help.length) {
    out.push('', '## Need help', '');
    for (const h of r.help) {
      out.push(
        `- ${h.name} tapped **Need help**${h.reason ? ` ("${h.reason}")` : ''}. The desk board shows "${h.name} needs help" with the time waiting until someone presses **On my way**.`,
      );
    }
  }
  if (r.doneFor.length) {
    out.push('', '## Done for a tech by the desk', '');
    for (const d of r.doneFor) {
      out.push(
        `- ${d.by ?? 'The desk'} pressed **${d.what === 'accepted' ? 'Accept' : d.what === 'finished' ? 'Finish' : 'Deny'} for ${d.name}**. ${d.name}'s phone shows "${d.what[0]!.toUpperCase()}${d.what.slice(1)} for you by ${d.by ?? 'the desk'}" with the time.` +
          (d.what === 'accepted' ? ` The desk row shows **Finish for ${d.name}**.` : ''),
      );
    }
  }
  out.push(
    '',
    '## Walk-outs, no-shows and yesterday',
    '',
    `- Today ${r.walkOuts} waiting ${r.walkOuts === 1 ? 'client' : 'clients'} left without service (Reports counts them; no points for anyone).`,
    `- Yesterday's leftovers, closed by the first board load this morning: ${r.closedYesterday['visit_closed_day_end'] ?? 0} waiting (no points), ${r.closedYesterday['visit_auto_finished'] ?? 0} still in the chair (finished, its point on yesterday's shift), ${r.closedYesterday['call_closed_day_end'] ?? 0} open calls, ${r.closedYesterday['help_closed_day_end'] ?? 0} help request, ${r.closedYesterday['auto_check_out'] ?? 0} check-out. The owner's board and Reports for yesterday list them.`,
  );
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
        : a.state === 'no_show_marked'
          ? 'the desk marked it a **No-show** (the client page counts it)'
          : a.state === 'no_show'
            ? 'past the buffer, no longer holds her; the desk may press **No-show** (under More)'
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

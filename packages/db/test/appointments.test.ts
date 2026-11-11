// Done-when (REQ-0c2b89ef, Part 7): tap-in applies the discount and the board
// shows 00; manual entry, change and cancel are audited without the client's
// name; a second-location user sees only second-location rows (test).
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addAppointment,
  appointmentArrived,
  appointmentsBetween,
  cancelAppointment,
  editAppointment,
  upcomingFor,
  type DeskActor,
} from '../src/appointments';
import { callNext, createWalkIn, finishVisit, queueFor, respondToCall } from '../src/engine';
import { addLocation } from '../src/locations';
import { HEAVENLY, HEAVENLY_RULE_CONFIG_V1, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import { checkIn, locationStatus, transition } from '../src/status';
import { compareQueue } from '../src/engine';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
let LOC2: string;
let desk: DeskActor;
let desk2: DeskActor;
let deskUser2: string;
type Tech = { id: string; userId: string };
let an: Tech;
let binh: Tech;
let chau: Tech; // at the second location
let manicure: string;
let fullSet: string;

async function person(name: string, role: string, locationId: string): Promise<string> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${name}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${locationId}, ${role})`;
  return userId;
}

async function tech(name: string, locationId: string = LOC): Promise<Tech> {
  const userId = await person(name, 'technician', locationId);
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${userId}, ${ORG}, ${locationId}, ${name}) returning id`;
  return { id: t!.id, userId };
}

async function onFloor(t: Tech) {
  await checkIn(db, { technicianId: t.id, actor: { userId: t.userId }, position: null });
  await transition(db, { technicianId: t.id, to: 'available', actor: { userId: t.userId } });
}

async function asUser<T>(userId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`;
    await tx.unsafe('set local role authenticated');
    return fn(tx);
  })) as T;
}

const inMin = (m: number) => new Date(Date.now() + m * 60_000);

beforeAll(async () => {
  await resetAndMigrate();
  await seedHeavenly(TEST_URL);
  db = createDb(TEST_URL);
  const second = await addLocation(db, { organizationId: ORG, name: 'Heavenly Nails second' });
  if (!second.ok) throw new Error(second.reason);
  LOC2 = second.locationId;
  desk = {
    userId: await person('Hanh', 'receptionist', LOC),
    organizationId: ORG,
    locationId: LOC,
  };
  deskUser2 = await person('Kim', 'receptionist', LOC2);
  desk2 = { userId: deskUser2, organizationId: ORG, locationId: LOC2 };
  an = await tech('An');
  binh = await tech('Binh');
  chau = await tech('Chau', LOC2);
  const byName = async (name: string) => {
    const [r] = await sql<
      { id: string }[]
    >`select id from services where location_id = ${LOC} and name = ${name}`;
    return r!.id;
  };
  manicure = await byName('Basic manicure');
  fullSet = await byName('Acrylic full set');
});

afterAll(async () => {
  await db?.$client.end();
  await sql.end();
});

describe('manual appointments', () => {
  it('adds, changes and cancels, each audited without the client name', async () => {
    const add = await addAppointment(db, {
      actor: desk,
      technicianId: an.id,
      clientName: 'Lan Nguyen',
      startAt: inMin(240),
      endAt: inMin(300),
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    expect(
      await editAppointment(db, {
        actor: desk,
        appointmentId: add.appointmentId,
        technicianId: binh.id,
        clientName: 'Lan Nguyen',
        startAt: inMin(250),
        endAt: inMin(310),
      }),
    ).toEqual({ ok: true });
    expect(
      await cancelAppointment(db, {
        actor: desk,
        appointmentId: add.appointmentId,
        reason: 'called to cancel',
      }),
    ).toEqual({ ok: true });
    const audit = await sql<
      { action: string; reason: string | null }[]
    >`select action, reason from audit_log where entity_id = ${add.appointmentId} order by at`;
    expect(audit.map((a) => a.action)).toEqual([
      'appointment_added',
      'appointment_changed',
      'appointment_cancelled',
    ]);
    expect(audit[2]!.reason).toBe('called to cancel');
    const rows =
      await sql`select before, after from audit_log where entity_id = ${add.appointmentId}`;
    expect(JSON.stringify(rows)).not.toContain('Lan Nguyen');
    // Cancelled twice is refused; nothing is deleted.
    expect(await cancelAppointment(db, { actor: desk, appointmentId: add.appointmentId })).toEqual({
      ok: false,
      reason: 'already_cancelled',
    });
  });

  it('refuses bad times, an unknown technician and another location', async () => {
    const base = { actor: desk, technicianId: an.id, startAt: inMin(60), endAt: inMin(120) };
    expect(await addAppointment(db, { ...base, endAt: inMin(30) })).toEqual({
      ok: false,
      reason: 'end_before_start',
    });
    expect(await addAppointment(db, { ...base, endAt: inMin(60 + 13 * 60) })).toEqual({
      ok: false,
      reason: 'too_long',
    });
    expect(
      await addAppointment(db, {
        ...base,
        startAt: inMin(-3 * 1440),
        endAt: inMin(-3 * 1440 + 60),
      }),
    ).toEqual({
      ok: false,
      reason: 'too_far_back',
    });
    expect(await addAppointment(db, { ...base, technicianId: chau.id })).toEqual({
      ok: false,
      reason: 'unknown_technician',
    });
    const a = await addAppointment(db, base);
    if (!a.ok) throw new Error(a.reason);
    expect(await cancelAppointment(db, { actor: desk2, appointmentId: a.appointmentId })).toEqual({
      ok: false,
      reason: 'wrong_location',
    });
    await cancelAppointment(db, { actor: desk, appointmentId: a.appointmentId });
  });

  it('a calendar row is changed in the calendar, not at the desk', async () => {
    const [row] = await sql<
      { id: string }[]
    >`insert into appointments (organization_id, location_id, technician_id, start_at, end_at, source, external_id) values (${ORG}, ${LOC}, ${an.id}, ${inMin(400)}, ${inMin(460)}, 'ics', 'x:ics-1') returning id`;
    expect(await cancelAppointment(db, { actor: desk, appointmentId: row!.id })).toEqual({
      ok: false,
      reason: 'from_calendar',
    });
    await sql`update appointments set cancelled_at = now() where id = ${row!.id}`;
  });
});

describe('client arrived (T15)', () => {
  it('an appointment full set goes to its technician and posts 00', async () => {
    await onFloor(an);
    await onFloor(binh);
    // Binh is ahead of An in the line (An has a point), but the appointment is An's.
    await sql`insert into turn_ledger (organization_id, location_id, technician_id, shift_id, delta, reason_type) select ${ORG}, ${LOC}, ${an.id}, shift_id, 1.0, 'manual' from technician_status where technician_id = ${an.id}`;
    const appt = await addAppointment(db, {
      actor: desk,
      technicianId: an.id,
      startAt: inMin(5),
      endAt: inMin(80),
    });
    if (!appt.ok) throw new Error(appt.reason);
    // Before the client is here, An is held out by the appointment buffer.
    const before = await db.transaction((tx) => queueFor(tx, LOC));
    expect(before.find((c) => c.technicianId === an.id)?.why).toBe('appointment_soon');

    const arrived = await appointmentArrived(db, {
      actor: desk,
      appointmentId: appt.appointmentId,
      serviceIds: [fullSet],
    });
    expect(arrived.ok).toBe(true);
    if (!arrived.ok) return;
    const [visit] = await sql<
      { source: string; requested_technician_id: string }[]
    >`select source, requested_technician_id from visits where id = ${arrived.visitId}`;
    expect(visit).toEqual({ source: 'appointment', requested_technician_id: an.id });
    // Once arrived, the appointment no longer blocks An.
    const after = await db.transaction((tx) => queueFor(tx, LOC));
    expect(after.find((c) => c.technicianId === an.id)?.eligible).toBe(true);

    const call = await callNext(db, { visitId: arrived.visitId, actor: desk, locationId: LOC });
    expect(call.ok && call.technicianId).toBe(an.id);
    if (!call.ok) return;
    await respondToCall(db, {
      callId: call.callId,
      technicianId: an.id,
      response: 'accepted',
      actor: desk,
    });
    const done = await finishVisit(db, { technicianId: an.id, actor: desk });
    // Full set 0.5, appointment discount −0.5.
    expect(done).toEqual({ ok: true, points: 0 });
    expect(
      await appointmentArrived(db, {
        actor: desk,
        appointmentId: appt.appointmentId,
        serviceIds: [fullSet],
      }),
    ).toEqual({
      ok: false,
      reason: 'already_arrived',
    });
  });

  it('00 sorts after a true 0 and the board knows it', async () => {
    // Reset An's manual point so both are at 0 on the ledger.
    await sql`insert into turn_ledger (organization_id, location_id, technician_id, shift_id, delta, reason_type) select ${ORG}, ${LOC}, ${an.id}, shift_id, -1.0, 'manual' from technician_status where technician_id = ${an.id}`;
    const board = await locationStatus(db, LOC);
    const rowAn = board.find((r) => r.technicianId === an.id)!;
    const rowBinh = board.find((r) => r.technicianId === binh.id)!;
    expect(rowAn).toMatchObject({ points: 0, hadAppointmentLast: true });
    expect(rowBinh).toMatchObject({ points: 0, hadAppointmentLast: false });
    const queue = await db.transaction((tx) => queueFor(tx, LOC));
    const order = queue.filter((c) => c.eligible).map((c) => c.technicianId);
    expect(order.indexOf(binh.id)).toBeLessThan(order.indexOf(an.id));
  });

  it("compareQueue follows the rules' sort keys in their order", () => {
    const early = new Date('2026-11-12T13:00:00Z');
    const late = new Date('2026-11-12T14:00:00Z');
    const a = { points: 0, hadAppointmentLast: true, checkedInAt: early };
    const b = { points: 0, hadAppointmentLast: false, checkedInAt: late };
    expect(compareQueue(HEAVENLY_RULE_CONFIG_V1, a, b)).toBeGreaterThan(0);
    const checkInFirst = {
      ...HEAVENLY_RULE_CONFIG_V1,
      queue: {
        ...HEAVENLY_RULE_CONFIG_V1.queue,
        sort: [
          'points_asc',
          'check_in_asc',
          'had_appointment_last',
        ] as typeof HEAVENLY_RULE_CONFIG_V1.queue.sort,
      },
    };
    expect(compareQueue(checkInFirst, a, b)).toBeLessThan(0);
  });

  it('when the booked technician cannot take it, the visit waits for them', async () => {
    const appt = await addAppointment(db, {
      actor: desk,
      technicianId: binh.id,
      startAt: inMin(2),
      endAt: inMin(40),
    });
    if (!appt.ok) throw new Error(appt.reason);
    await transition(db, { technicianId: binh.id, to: 'break', actor: { userId: binh.userId } });
    const arrived = await appointmentArrived(db, {
      actor: desk,
      appointmentId: appt.appointmentId,
      serviceIds: [manicure],
    });
    if (!arrived.ok) throw new Error(arrived.reason);
    const call = await callNext(db, { visitId: arrived.visitId, actor: desk, locationId: LOC });
    // An is free, but the appointment is Binh's.
    expect(call).toMatchObject({ ok: false, reason: 'nobody_eligible' });
    const [v] = await sql<
      { status: string }[]
    >`select status from visits where id = ${arrived.visitId}`;
    expect(v!.status).toBe('waiting');
    await transition(db, {
      technicianId: binh.id,
      to: 'available',
      actor: { userId: binh.userId },
    });
    const again = await callNext(db, { visitId: arrived.visitId, actor: desk, locationId: LOC });
    expect(again.ok && again.technicianId).toBe(binh.id);
    if (!again.ok) return;
    await respondToCall(db, {
      callId: again.callId,
      technicianId: binh.id,
      response: 'accepted',
      actor: desk,
    });
    expect(await finishVisit(db, { technicianId: binh.id, actor: desk })).toEqual({
      ok: true,
      points: 0.5,
    });
  });

  it('a walk-in with a request is still a request, not an appointment', async () => {
    const v = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      requestedTechnicianId: an.id,
      actor: { userId: desk.userId },
    });
    if (!v.ok) throw new Error(v.reason);
    const [row] = await sql<
      { source: string }[]
    >`select source from visits where id = ${v.visitId}`;
    expect(row!.source).toBe('request');
    await sql`update visits set status = 'cancelled', cancelled_at = now() where id = ${v.visitId}`;
  });

  it('the arrived appointment refuses another location', async () => {
    const appt = await addAppointment(db, {
      actor: desk,
      technicianId: an.id,
      startAt: inMin(300),
      endAt: inMin(330),
    });
    if (!appt.ok) throw new Error(appt.reason);
    expect(
      await appointmentArrived(db, {
        actor: desk2,
        appointmentId: appt.appointmentId,
        serviceIds: [manicure],
      }),
    ).toEqual({
      ok: false,
      reason: 'wrong_location',
    });
  });
});

describe('the second location', () => {
  it("starts with its own menu, rules and the salon's owners", async () => {
    const [n] = await sql<
      { n: number }[]
    >`select count(*)::int as n from services where location_id = ${LOC2}`;
    expect(n!.n).toBeGreaterThan(0);
    const [r] = await sql<
      { n: number }[]
    >`select count(*)::int as n from rule_configs where location_id = ${LOC2}`;
    expect(r!.n).toBe(1);
    // Running it again is a no-op.
    expect(await addLocation(db, { organizationId: ORG, name: 'Heavenly Nails second' })).toEqual({
      ok: true,
      locationId: LOC2,
      created: false,
    });
  });

  it('a second-location receptionist sees only second-location appointments and visits', async () => {
    const appt2 = await addAppointment(db, {
      actor: desk2,
      technicianId: chau.id,
      startAt: inMin(90),
      endAt: inMin(120),
    });
    if (!appt2.ok) throw new Error(appt2.reason);
    const [svc2] = await sql<
      { id: string }[]
    >`select id from services where location_id = ${LOC2} limit 1`;
    const v2 = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC2,
      serviceIds: [svc2!.id],
      actor: { userId: deskUser2 },
    });
    if (!v2.ok) throw new Error(v2.reason);
    const seen = await asUser(deskUser2, async (tx) => ({
      appointments: await tx<{ location_id: string }[]>`select location_id from appointments`,
      visits: await tx<{ location_id: string }[]>`select location_id from visits`,
    }));
    expect(seen.appointments.length).toBe(1);
    expect(seen.visits.length).toBe(1);
    expect([...seen.appointments, ...seen.visits].every((r) => r.location_id === LOC2)).toBe(true);
    // And the first location's receptionist does not see the second's rows.
    const first = await asUser(desk.userId!, async (tx) => ({
      appointments: await tx<{ location_id: string }[]>`select location_id from appointments`,
      visits: await tx<{ location_id: string }[]>`select location_id from visits`,
    }));
    expect([...first.appointments, ...first.visits].some((r) => r.location_id === LOC2)).toBe(
      false,
    );
    expect(first.appointments.length).toBeGreaterThan(0);
  });

  it("a technician's phone sees their own coming appointments as times only", async () => {
    const mine = await upcomingFor(db, chau.id);
    expect(mine).toHaveLength(1);
    expect(Object.keys(mine[0]!).sort()).toEqual(['endAt', 'startAt']);
  });

  it('the desk list is per location', async () => {
    const list = await appointmentsBetween(db, LOC2, inMin(-60), inMin(24 * 60));
    expect(list.map((a) => a.technicianName)).toEqual(['Chau']);
  });
});

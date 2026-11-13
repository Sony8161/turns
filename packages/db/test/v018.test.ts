// v0.18.0 "Simplify the desk": the parts with a server side. The "To check
// out" list (F1), the receptionist's whole client phone (Duong, 2026-11-13),
// the two-letter surname search, and the read the board's Next banner uses.
// Written before the code they test.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { needsYouCount, plainQueue } from '../src/board';
import { askForHelp } from '../src/help';
import { checkOutVisit, setCheckoutList, toCheckOut } from '../src/checkout';
import {
  findClients,
  parseClientQuery,
  setReceptionistSeesPhone,
  viewClient,
} from '../src/clients';
import { callNext, createWalkIn, finishVisit, respondToCall } from '../src/engine';
import { setTechnicianLevel, type SkillLevel } from '../src/levels';
import { allowedAt } from '../src/permissions';
import { dailyTurnReport, localDate } from '../src/reports';
import { HEAVENLY, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import type { StaffActor } from '../src/staff';
import { checkIn, sweepFloor, transition } from '../src/status';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
const TZ = 'America/New_York';
const nobody = { userId: null };
let owner: StaffActor;
let reception: StaffActor;
type Tech = { id: string; userId: string; name: string; actor: StaffActor };
const svc: Record<string, string> = {};

async function newUser(name: string, role: string): Promise<string> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${role}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${LOC}, ${role}::role)`;
  return userId;
}

async function staff(name: string, role: 'owner' | 'manager' | 'receptionist') {
  return { userId: await newUser(name, role), role, organizationId: ORG, locationId: LOC };
}

async function newTech(name: string, level: SkillLevel = 'acrylic'): Promise<Tech> {
  const userId = await newUser(name, 'technician');
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${userId}, ${ORG}, ${LOC}, ${name}) returning id`;
  const filled = await setTechnicianLevel(db, { actor: owner, technicianId: t!.id, level });
  if (!filled.ok) throw new Error(filled.reason);
  return {
    id: t!.id,
    userId,
    name,
    actor: { userId, role: 'technician', organizationId: ORG, locationId: LOC },
  };
}

async function onFloor(t: Tech, minutesAgo = 30) {
  const c = await checkIn(db, {
    technicianId: t.id,
    actor: { userId: t.userId },
    position: null,
    now: new Date(Date.now() - minutesAgo * 60_000),
  });
  if (!c.ok) throw new Error(`check-in ${t.name}: ${c.reason}`);
  await transition(db, { technicianId: t.id, to: 'available', actor: { userId: t.userId } });
}

async function clearFloor() {
  await sql`update turn_calls set responded_at = now(), response = 'overridden' where responded_at is null`;
  await sql`update visits set status = 'cancelled', cancelled_at = now() where status in ('waiting', 'called', 'in_service')`;
  await sql`update visits set checked_out_at = now() where status = 'completed' and checked_out_at is null`;
  await sql`update shifts set checked_out_at = now() where checked_out_at is null`;
  await sql`update technician_status set status = 'off', shift_id = null where status <> 'off'`;
  await sql`delete from appointments`;
}

async function walkIn(names: string[], extra: Partial<Parameters<typeof createWalkIn>[1]> = {}) {
  const v = await createWalkIn(db, {
    organizationId: ORG,
    locationId: LOC,
    serviceIds: names.map((n) => svc[n]!),
    actor: nobody,
    ...extra,
  });
  if (!v.ok) throw new Error(v.reason);
  return v;
}

/** Call, accept and finish: the visit is done. */
async function serve(visitId: string): Promise<string> {
  const c = await callNext(db, { visitId, actor: nobody, locationId: LOC });
  if (!c.ok) throw new Error(`call: ${c.reason} ${c.detail ?? ''}`);
  const a = await respondToCall(db, {
    callId: c.callId,
    technicianId: c.technicianId,
    response: 'accepted',
    actor: nobody,
  });
  if (!a.ok) throw new Error(`accept: ${a.reason}`);
  const f = await finishVisit(db, { technicianId: c.technicianId, actor: nobody, visitId });
  if (!f.ok) throw new Error(`finish: ${f.reason}`);
  return c.technicianId;
}

async function auditRows(action: string) {
  return sql<
    { entity_id: string | null; after: unknown; before: unknown }[]
  >`select entity_id, after, before from audit_log where action = ${action} order by at, id`;
}

beforeAll(async () => {
  await resetAndMigrate();
  await seedHeavenly(TEST_URL);
  db = createDb(TEST_URL);
  for (const s of await sql<
    { id: string; name: string }[]
  >`select id, name from services where location_id = ${LOC}`) {
    svc[s.name] = s.id;
  }
  owner = await staff('Phu', 'owner');
  reception = await staff('Hạnh', 'receptionist');
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

// ---------------------------------------------------------------------------
describe('F1: To check out', () => {
  let a: Tech;
  let b: Tech;
  beforeAll(async () => {
    await clearFloor();
    a = await newTech('Out A', 'gel');
    b = await newTech('Out B', 'gel');
    await onFloor(a, 60);
    await onFloor(b, 50);
  });

  it('a visit appears after it is finished, with what was done and by whom', async () => {
    const v = await walkIn(['Gel manicure'], {
      client: { firstName: 'Thu', lastName: 'Pham' },
    });
    let list = await toCheckOut(db, reception);
    expect(list.ok && list.rows.map((r) => r.visitId)).toEqual([]);
    const techId = await serve(v.visitId);
    list = await toCheckOut(db, reception);
    expect(list).toMatchObject({ ok: true, on: true });
    const row = list.ok ? list.rows.find((r) => r.visitId === v.visitId) : undefined;
    expect(row).toMatchObject({
      clientFirstName: 'Thu',
      clientLastName: 'Pham',
      parts: [{ technician: techId === a.id ? 'Out A' : 'Out B', services: ['Gel manicure'] }],
    });
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  it('it leaves the list on "Checked out"; the audit row has no name', async () => {
    const list = await toCheckOut(db, reception);
    const row = list.ok ? list.rows[0]! : null;
    expect(row).toBeTruthy();
    expect(await checkOutVisit(db, { actor: reception, visitId: row!.visitId })).toEqual({
      ok: true,
      visits: 1,
    });
    const after = await toCheckOut(db, reception);
    expect(after.ok && after.rows.length).toBe(0);
    const [v] =
      await sql`select checked_out_at, checked_out_by from visits where id = ${row!.visitId}`;
    expect(v!['checked_out_at']).toBeInstanceOf(Date);
    expect(v!['checked_out_by']).toBe(reception.userId);
    const audit = await auditRows('visit_checked_out');
    expect(audit.at(-1)!.entity_id).toBe(row!.visitId);
    expect(JSON.stringify(audit.at(-1))).not.toMatch(/Thu|Pham/);
    // Twice is refused cleanly.
    expect(await checkOutVisit(db, { actor: reception, visitId: row!.visitId })).toEqual({
      ok: false,
      reason: 'already_checked_out',
    });
  });

  it('a visit still waiting or in service cannot be checked out', async () => {
    const v = await walkIn(['Gel manicure']);
    expect(await checkOutVisit(db, { actor: reception, visitId: v.visitId })).toEqual({
      ok: false,
      reason: 'not_finished',
    });
    await serve(v.visitId);
    expect((await checkOutVisit(db, { actor: owner, visitId: v.visitId })).ok).toBe(true);
  });

  it('two services at the same time are one row, shown once both are finished', async () => {
    const v = await walkIn(['Gel manicure', 'Gel pedicure'], { sameTime: true });
    expect(v.visitIds.length).toBe(2);
    await serve(v.visitIds[0]!);
    let list = await toCheckOut(db, reception);
    expect(list.ok && list.rows.length).toBe(0);
    await serve(v.visitIds[1]!);
    list = await toCheckOut(db, reception);
    expect(list.ok && list.rows.length).toBe(1);
    expect(list.ok && list.rows[0]!.parts.length).toBe(2);
    expect(
      await checkOutVisit(db, { actor: reception, visitId: list.ok ? list.rows[0]!.visitId : '' }),
    ).toEqual({ ok: true, visits: 2 });
  });

  it('a technician cannot see it or check anyone out', async () => {
    const v = await walkIn(['Gel manicure']);
    await serve(v.visitId);
    expect(await toCheckOut(db, a.actor)).toEqual({ ok: false, reason: 'not_allowed' });
    expect(await checkOutVisit(db, { actor: a.actor, visitId: v.visitId })).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
  });

  it('another location cannot touch it', async () => {
    const list = await toCheckOut(db, reception);
    const visitId = list.ok ? list.rows[0]!.visitId : '';
    const elsewhere = { ...reception, locationId: randomUUID() };
    expect(await checkOutVisit(db, { actor: elsewhere, visitId })).toEqual({
      ok: false,
      reason: 'wrong_location',
    });
    expect(await toCheckOut(db, elsewhere)).toEqual({ ok: false, reason: 'not_allowed' });
    const otherOrg = { ...reception, organizationId: randomUUID() };
    expect(await checkOutVisit(db, { actor: otherOrg, visitId })).toEqual({
      ok: false,
      reason: 'wrong_location',
    });
  });

  it('what is still there at day end is cleared and counted in the summary', async () => {
    const list = await toCheckOut(db, reception);
    const visitId = list.ok ? list.rows[0]!.visitId : '';
    expect(visitId).not.toBe('');
    // Finished two days ago and never checked out.
    await sql`update visits set arrived_at = arrived_at - interval '2 days', started_at = started_at - interval '2 days', completed_at = completed_at - interval '2 days' where id = ${visitId}`;
    const [day] = await sql<
      { d: string }[]
    >`select to_char((completed_at at time zone ${TZ})::date, 'YYYY-MM-DD') as d from visits where id = ${visitId}`;
    const r = await sweepFloor(db, LOC);
    expect(r.closed.checkouts).toBe(1);
    const [v] = await sql`select checked_out_at, checked_out_by from visits where id = ${visitId}`;
    expect(v!['checked_out_at']).toBeInstanceOf(Date);
    expect(v!['checked_out_by']).toBeNull();
    expect((await auditRows('checkout_closed_day_end')).at(-1)).toMatchObject({
      entity_id: visitId,
      after: { forDay: day!.d },
    });
    const report = await dailyTurnReport(db, LOC, day!.d);
    expect(report?.totals.closedAtDayEnd.checkouts).toBe(1);
    // Gone from today's list, and a second sweep finds nothing.
    const now = await toCheckOut(db, reception);
    expect(now.ok && now.rows.some((x) => x.visitId === visitId)).toBe(false);
    expect((await sweepFloor(db, LOC)).closed.checkouts).toBe(0);
  });

  it('the owner can turn the list off (audited); then nothing is listed or checked out', async () => {
    const v = await walkIn(['Gel manicure']);
    await serve(v.visitId);
    expect(await setCheckoutList(db, { actor: reception, on: false })).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect(await setCheckoutList(db, { actor: owner, on: false })).toEqual({ ok: true });
    expect(await toCheckOut(db, reception)).toEqual({ ok: true, on: false, rows: [] });
    expect(await checkOutVisit(db, { actor: reception, visitId: v.visitId })).toEqual({
      ok: false,
      reason: 'list_off',
    });
    expect((await auditRows('checkout_list_setting')).at(-1)).toMatchObject({
      before: { checkoutList: true },
      after: { checkoutList: false },
    });
    await setCheckoutList(db, { actor: owner, on: true });
    await clearFloor();
  });

  it('the list query has its own index', async () => {
    const [row] = await sql<
      { indexdef: string }[]
    >`select indexdef from pg_indexes where indexname = 'visits_to_check_out'`;
    expect(row!.indexdef).toMatch(/location_id, completed_at/);
    expect(row!.indexdef).toMatch(/WHERE .*completed.*checked_out_at IS NULL/i);
  });
});

// ---------------------------------------------------------------------------
describe('receptionists see the whole client phone (Duong, 2026-11-13)', () => {
  let phoned: string;
  beforeAll(async () => {
    const [c] = await sql<{ id: string }[]>`insert into clients
      (organization_id, location_id, name, first_name, last_name, search_name, phone)
      values (${ORG}, ${LOC}, 'Kim Tran', 'Kim', 'Tran', 'kim tran', '+18135550177') returning id`;
    phoned = c!.id;
  });

  it('by default: on her client page and in search, with no Show and no audit row', async () => {
    const desk = await staff('Full', 'receptionist');
    expect(await allowedAt(db, desk, 'see_client_phone')).toBe(true);
    const before = (await auditRows('client_phone_shown')).length;
    expect(await viewClient(db, { viewer: desk, clientId: phoned })).toMatchObject({
      ok: true,
      client: { phone: '+18135550177', phoneMasked: false },
    });
    const hits = await findClients(db, { viewer: desk, query: 'kim tran' });
    expect(hits.ok && hits.hits[0]?.phone).toBe('+18135550177');
    expect((await auditRows('client_phone_shown')).length).toBe(before);
  });

  it('with the owner switch off she sees the mask again', async () => {
    const desk = await staff('Masked', 'receptionist');
    expect(await setReceptionistSeesPhone(db, { actor: desk, on: false })).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect(await setReceptionistSeesPhone(db, { actor: owner, on: false })).toEqual({ ok: true });
    expect(await viewClient(db, { viewer: desk, clientId: phoned })).toMatchObject({
      ok: true,
      client: { phone: '(•••) •••-0177', phoneMasked: true },
    });
    const hits = await findClients(db, { viewer: desk, query: 'kim tran' });
    expect(hits.ok && hits.hits[0]?.phone).toBe('(•••) •••-0177');
    const audit = (await auditRows('client_phone_setting')).at(-1);
    expect(audit).toMatchObject({
      before: { receptionistSeesClientPhone: true },
      after: { receptionistSeesClientPhone: false },
    });
    expect(JSON.stringify(audit)).not.toMatch(/0177/);
    await setReceptionistSeesPhone(db, { actor: owner, on: true });
  });

  it('a technician still sees nothing', async () => {
    const t = await newTech('No Peek');
    expect(await viewClient(db, { viewer: t.actor, clientId: phoned })).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect(await findClients(db, { viewer: t.actor, query: 'kim tran' })).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect(await allowedAt(db, t.actor, 'see_client_phone')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('two-letter Vietnamese surnames', () => {
  beforeAll(async () => {
    for (const [first, last] of [
      ['Lan', 'Võ'],
      ['Mai', 'Lê'],
      ['Vonda', 'Smith'],
      ['Leah', 'Brown'],
      ['Hà', 'Nguyen'],
    ] as const) {
      const key = `${first} ${last}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      await sql`insert into clients (organization_id, location_id, name, first_name, last_name, search_name)
        values (${ORG}, ${LOC}, ${`${first} ${last}`}, ${first}, ${last}, ${key})`;
    }
  });

  it('two letters are a whole first or last name, accents ignored; never a prefix', async () => {
    expect(parseClientQuery('Võ')).toEqual({ name: 'vo', exact: true });
    expect(parseClientQuery('le')).toEqual({ name: 'le', exact: true });
    expect(parseClientQuery('v')).toBeNull();
    expect(parseClientQuery('v o')).toBeNull();
    expect(parseClientQuery('vo1')).toBeNull();
    const desk = await staff('Search', 'receptionist');
    const names = async (q: string) => {
      const r = await findClients(db, { viewer: desk, query: q });
      return r.ok ? r.hits.map((h) => `${h.firstName} ${h.lastName}`).sort() : r.reason;
    };
    expect(await names('Võ')).toEqual(['Lan Võ']);
    expect(await names('vo')).toEqual(['Lan Võ']);
    expect(await names('Lê')).toEqual(['Mai Lê']);
    expect(await names('ha')).toEqual(['Hà Nguyen']);
    // Three letters still find the start of a name.
    expect(await names('von')).toEqual(['Vonda Smith']);
    expect(await names('v')).toBe('too_short');
  });

  it('a two-letter search counts against the same budget', async () => {
    const desk = await staff('Budget', 'receptionist');
    await findClients(db, { viewer: desk, query: 'vo' });
    const [rl] =
      await sql`select count from rate_limits where key = ${`client-search:${desk.userId}`}`;
    expect(Number(rl!['count'])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('the Next banner reads the line for a plain call', () => {
  it('names the tech a plain call goes to, and why the others cannot be called', async () => {
    await clearFloor();
    const first = await newTech('Q First', 'gel');
    const second = await newTech('Q Second', 'gel');
    const held = await newTech('Q Held', 'gel');
    await onFloor(first, 90);
    await onFloor(second, 80);
    await onFloor(held, 95);
    const start = new Date(Math.ceil((Date.now() + 10 * 60_000) / 60_000) * 60_000);
    await sql`insert into appointments (organization_id, location_id, technician_id, start_at, end_at, source)
      values (${ORG}, ${LOC}, ${held.id}, ${start}, ${new Date(start.getTime() + 3_600_000)}, 'manual')`;
    const q = await plainQueue(db, LOC);
    expect(q.next?.technicianId).toBe(first.id);
    const mine = q.rows.find((r) => r.technicianId === held.id);
    expect(mine).toMatchObject({ eligible: false, why: 'appointment_soon' });
    expect(mine?.appointmentAt?.getTime()).toBe(start.getTime());
    expect(q.rows.find((r) => r.technicianId === second.id)).toMatchObject({ eligible: true });
    // The same pick callNext makes.
    const v = await walkIn(['Gel manicure']);
    const c = await callNext(db, { visitId: v.visitId, actor: nobody, locationId: LOC });
    expect(c.ok && c.technicianId).toBe(first.id);
    const after = await plainQueue(db, LOC);
    expect(after.next?.technicianId).toBe(second.id);
    expect(after.rows.find((r) => r.technicianId === first.id)).toMatchObject({
      eligible: false,
      why: 'already_called',
    });
    await clearFloor();
  });

  it('the Board tab counts what waits for the desk, on every page', async () => {
    await clearFloor();
    await sql`update help_requests set acknowledged_at = now() where acknowledged_at is null`;
    expect(await needsYouCount(db, LOC, true)).toBe(0);
    const t = await newTech('Q Help', 'gel');
    await onFloor(t, 20);
    const h = await askForHelp(db, { technicianId: t.id, actor: { userId: t.userId } });
    expect(h.ok).toBe(true);
    const v = await walkIn(['Gel manicure']);
    // A call nobody has answered for longer than the rules' minutes.
    const c = await callNext(db, { visitId: v.visitId, actor: nobody, locationId: LOC });
    expect(c.ok).toBe(true);
    await sql`update turn_calls set called_at = now() - interval '2 hours' where responded_at is null`;
    expect(await needsYouCount(db, LOC, false)).toBe(2);
    expect(await needsYouCount(db, LOC, true)).toBe(2);
    await sql`update help_requests set acknowledged_at = now() where acknowledged_at is null`;
    await clearFloor();
  });

  it('nobody: says so', async () => {
    await clearFloor();
    expect((await plainQueue(db, LOC)).next).toBeNull();
  });
});

void localDate;

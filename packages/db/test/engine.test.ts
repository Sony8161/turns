// Done-when (REQ-7b06e168): two walk-ins at the same second never double-assign;
// deny posts the penalty and the next technician is called; finish posts the
// visit's points; a manager can reassign with a reason.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callNext,
  createWalkIn,
  finishVisit,
  openCallFor,
  reassignVisit,
  respondToCall,
  visitPoints,
} from '../src/engine';
import { HEAVENLY, HEAVENLY_RULE_CONFIG_V1, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import { checkIn, shiftTotal, transition } from '../src/status';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
const desk = { userId: null };
let manicure: string;
let fullSet: string;
type Tech = { id: string; userId: string; name: string };
let a: Tech;
let b: Tech;

async function newTech(name: string): Promise<Tech> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${name}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${LOC}, 'technician')`;
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${userId}, ${ORG}, ${LOC}, ${name}) returning id`;
  return { id: t!.id, userId, name };
}

async function onFloor(t: Tech) {
  await checkIn(db, { technicianId: t.id, actor: { userId: t.userId }, position: null });
  await transition(db, { technicianId: t.id, to: 'available', actor: { userId: t.userId } });
}

async function shiftOf(t: Tech): Promise<string> {
  const [s] = await sql<
    { shift_id: string }[]
  >`select shift_id from technician_status where technician_id = ${t.id}`;
  return s!.shift_id;
}

beforeAll(async () => {
  await resetAndMigrate();
  await seedHeavenly(TEST_URL);
  db = createDb(TEST_URL);
  // The seed's menu: a standard service and a full set.
  const [m] = await sql<
    { id: string }[]
  >`select id from services where location_id = ${LOC} and name = 'Basic manicure'`;
  const [f] = await sql<
    { id: string }[]
  >`select id from services where location_id = ${LOC} and name = 'Acrylic full set'`;
  manicure = m!.id;
  fullSet = f!.id;
  a = await newTech('Thảo');
  b = await newTech('Linh');
  await onFloor(a); // checked in first: wins ties
  await onFloor(b);
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

describe('visitPoints (pure, from rule_config)', () => {
  const rules = HEAVENLY_RULE_CONFIG_V1;
  it('standard 1, fill or full set ½, combined capped at 1, appointment −½', () => {
    expect(visitPoints(rules, [{ isFillOrFullSet: false }], 'walk_in')).toBe(1);
    expect(visitPoints(rules, [{ isFillOrFullSet: true }], 'walk_in')).toBe(0.5);
    expect(
      visitPoints(rules, [{ isFillOrFullSet: false }, { isFillOrFullSet: false }], 'walk_in'),
    ).toBe(2);
    expect(
      visitPoints(rules, [{ isFillOrFullSet: true }, { isFillOrFullSet: false }], 'walk_in'),
    ).toBe(1);
    expect(visitPoints(rules, [{ isFillOrFullSet: true }], 'appointment')).toBe(0);
  });
  it('refuses a rule_config with a missing number', () => {
    expect(() => visitPoints({}, [{ isFillOrFullSet: false }], 'walk_in')).toThrow(
      /default_service/,
    );
  });
});

describe('the call flow', () => {
  it('calls the lowest-points, earliest-checked-in technician and snapshots the queue', async () => {
    const v = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      actor: desk,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const c = await callNext(db, { visitId: v.visitId, actor: desk });
    expect(c).toMatchObject({ ok: true, technicianId: a.id });
    const call = await openCallFor(db, a.id);
    expect(call?.services).toEqual(['Basic manicure']);
    const [row] = await sql<
      { queue_snapshot: { displayName: string; eligible: boolean }[] }[]
    >`select queue_snapshot from turn_calls where visit_id = ${v.visitId}`;
    expect(row?.queue_snapshot.map((q) => q.displayName)).toEqual(['Thảo', 'Linh']);
    expect(await openCallFor(db, b.id)).toBeNull();
  });

  it('a deny posts the penalty, the visit waits again, and the next technician is called', async () => {
    const call = await openCallFor(db, a.id);
    const r = await respondToCall(db, {
      callId: call!.callId,
      technicianId: a.id,
      response: 'denied',
      denyReason: 'client_issue',
      actor: { userId: a.userId },
    });
    expect(r.ok).toBe(true);
    expect(await shiftTotal(db, await shiftOf(a))).toBe(1); // deny penalty from rules
    const again = await callNext(db, { visitId: call!.visitId, actor: desk });
    expect(again).toMatchObject({ ok: true, technicianId: b.id });
  });

  it('accept starts the service; finish posts the visit points and frees the technician', async () => {
    const call = await openCallFor(db, b.id);
    expect(call).not.toBeNull();
    const ok = await respondToCall(db, {
      callId: call!.callId,
      technicianId: b.id,
      response: 'accepted',
      actor: { userId: b.userId },
    });
    expect(ok.ok).toBe(true);
    const [st] = await sql<
      { status: string }[]
    >`select status from technician_status where technician_id = ${b.id}`;
    expect(st?.status).toBe('in_service');
    const done = await finishVisit(db, { technicianId: b.id, actor: { userId: b.userId } });
    expect(done).toEqual({ ok: true, points: 1 });
    expect(await shiftTotal(db, await shiftOf(b))).toBe(1);
    const [after] = await sql<
      { status: string }[]
    >`select status from technician_status where technician_id = ${b.id}`;
    expect(after?.status).toBe('available');
    const [v] = await sql<
      { status: string; points_posted: string }[]
    >`select status, points_posted from visits where id = ${call!.visitId}`;
    expect(v).toEqual({ status: 'completed', points_posted: '1.0' });
  });

  it('someone else cannot answer a technician’s call', async () => {
    const v = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [fullSet],
      actor: desk,
    });
    if (!v.ok) throw new Error(v.reason);
    const c = await callNext(db, { visitId: v.visitId, actor: desk });
    if (!c.ok) throw new Error(c.reason);
    const other = c.technicianId === a.id ? b.id : a.id;
    const wrong = await respondToCall(db, {
      callId: c.callId,
      technicianId: other,
      response: 'accepted',
      actor: desk,
    });
    expect(wrong).toEqual({ ok: false, reason: 'not_your_call' });
    await respondToCall(db, {
      callId: c.callId,
      technicianId: c.technicianId,
      response: 'accepted',
      actor: desk,
    });
    await finishVisit(db, { technicianId: c.technicianId, actor: desk });
  });

  it('two walk-ins at the same second never double-assign one technician', async () => {
    // Only a is available: b goes on break.
    await transition(db, { technicianId: b.id, to: 'break', actor: { userId: b.userId } });
    const v1 = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      actor: desk,
    });
    const v2 = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      actor: desk,
    });
    if (!v1.ok || !v2.ok) throw new Error('walk-in failed');
    const [r1, r2] = await Promise.all([
      callNext(db, { visitId: v1.visitId, actor: desk }),
      callNext(db, { visitId: v2.visitId, actor: desk }),
    ]);
    const wins = [r1, r2].filter((r) => r.ok).length;
    expect(wins).toBe(1);
    const [open] = await sql<
      { n: number }[]
    >`select count(*)::int as n from turn_calls where technician_id = ${a.id} and responded_at is null`;
    expect(open?.n).toBe(1);
    await transition(db, { technicianId: b.id, to: 'available', actor: { userId: b.userId } });
  });

  it('a manager can reassign an open call to another technician with a reason', async () => {
    const call = await openCallFor(db, a.id);
    expect(call).not.toBeNull();
    const noReason = await reassignVisit(db, {
      visitId: call!.visitId,
      toTechnicianId: b.id,
      actor: desk,
      reason: ' ',
    });
    expect(noReason).toEqual({ ok: false, reason: 'reason_required' });
    const before = await shiftTotal(db, await shiftOf(a));
    const moved = await reassignVisit(db, {
      visitId: call!.visitId,
      toTechnicianId: b.id,
      actor: desk,
      reason: 'called wrong',
    });
    expect(moved.ok).toBe(true);
    expect(await openCallFor(db, a.id)).toBeNull();
    expect((await openCallFor(db, b.id))?.visitId).toBe(call!.visitId);
    expect(await shiftTotal(db, await shiftOf(a))).toBe(before); // no penalty by default
    const [c] = await sql<
      { response: string }[]
    >`select response from turn_calls where id = ${call!.callId}`;
    expect(c?.response).toBe('overridden');
  });
});

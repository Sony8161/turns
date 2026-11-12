// v0.14.0 (Duong, 2026-11-12): skill levels as a ladder, services that go to
// certain levels by turn, the desk asking a higher level, split visits, and
// services the desk picks the technician for.
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callNext,
  createWalkIn,
  deskCall,
  deskOptions,
  finishVisit,
  openCallFor,
  reassignVisit,
  respondToCall,
  waitingVisits,
} from '../src/engine';
import {
  byTurn,
  menuLevels,
  reaches,
  setServiceLevels,
  setTechnicianLevel,
  technicianLevel,
} from '../src/levels';
import { HEAVENLY, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import type { StaffActor } from '../src/staff';
import { checkIn, shiftTotal, transition } from '../src/status';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
const desk = { userId: null };
let owner: StaffActor;
let manager: StaffActor;
let receptionist: StaffActor;
let managerB: StaffActor;
type Tech = { id: string; userId: string; name: string };
let reg: Tech; // regular polish
let gel: Tech; // gel, but no gel manicure
let acr: Tech; // acrylic
const svc: Record<string, string> = {};

async function newUser(name: string, role: string, locationId: string = LOC): Promise<string> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${role}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${locationId}, ${role}::role)`;
  return userId;
}

async function newTech(name: string): Promise<Tech> {
  const userId = await newUser(name, 'technician');
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${userId}, ${ORG}, ${LOC}, ${name}) returning id`;
  return { id: t!.id, userId, name };
}

const staff = async (role: StaffActor['role'], locationId: string = LOC): Promise<StaffActor> => ({
  userId: await newUser(role, role, locationId),
  role,
  organizationId: ORG,
  locationId,
});

/** Check in at a fixed minute so the line order is the order of the calls here. */
async function onFloor(t: Tech, minutesAgo: number) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await checkIn(db, { technicianId: t.id, actor: { userId: t.userId }, position: null, now: at });
  await transition(db, { technicianId: t.id, to: 'available', actor: { userId: t.userId } });
}

async function pointsOf(t: Tech): Promise<number> {
  const [s] = await sql<
    { shift_id: string }[]
  >`select shift_id from technician_status where technician_id = ${t.id}`;
  return shiftTotal(db, s!.shift_id);
}

async function walkIn(names: string[], extra: Partial<Parameters<typeof createWalkIn>[1]> = {}) {
  const v = await createWalkIn(db, {
    organizationId: ORG,
    locationId: LOC,
    serviceIds: names.map((n) => svc[n]!),
    actor: desk,
    ...extra,
  });
  if (!v.ok) throw new Error(v.reason);
  return v.visitId;
}

const call = (visitId: string) => callNext(db, { visitId, actor: desk, locationId: LOC });

async function accept(callId: string, t: Tech, keepServiceIds?: string[]) {
  return respondToCall(db, {
    callId,
    technicianId: t.id,
    response: 'accepted',
    actor: { userId: t.userId },
    ...(keepServiceIds ? { keepServiceIds } : {}),
  });
}

const finish = (t: Tech) => finishVisit(db, { technicianId: t.id, actor: { userId: t.userId } });

async function cancel(visitId: string) {
  await sql`update turn_calls set responded_at = now(), response = 'overridden' where visit_id = ${visitId} and responded_at is null`;
  await sql`update visits set status = 'cancelled', cancelled_at = now() where id = ${visitId}`;
}

async function asUser<T>(userId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`;
    await tx.unsafe('set local role authenticated');
    return fn(tx);
  })) as T;
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
  const [b] = await sql<
    { id: string }[]
  >`insert into locations (organization_id, name) values (${ORG}, 'Heavenly Brandon') returning id`;
  owner = await staff('owner');
  manager = await staff('manager');
  receptionist = await staff('receptionist');
  managerB = await staff('manager', b!.id);
  reg = await newTech('Reg');
  gel = await newTech('Gel');
  acr = await newTech('Acr');
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

describe('the ladder', () => {
  it('reaches and byTurn are plain comparisons', () => {
    expect(reaches('acrylic', 'regular')).toBe(true);
    expect(reaches('gel', 'dip')).toBe(false);
    expect(byTurn('acrylic', ['regular', 'gel'])).toBe(false);
    expect(byTurn('gel', ['regular', 'gel'])).toBe(true);
    expect(byTurn('regular', null)).toBe(true);
  });

  it('the starting menu carries the defaults Duong gave', async () => {
    const menu = new Map((await menuLevels(db, LOC)).map((m) => [m.name, m]));
    expect(menu.get('Basic manicure')!.turnLevels).toEqual(['regular', 'gel']);
    expect(menu.get('Gel manicure')!.turnLevels).toEqual(['gel', 'dip', 'acrylic']);
    expect(menu.get('Gel pedicure')!.turnLevels).toEqual(['gel', 'dip', 'acrylic']);
    expect(menu.get('Basic pedicure')!.turnLevels).toBeNull();
    expect(menu.get('Dip powder')!.turnLevels).toEqual(['dip', 'acrylic']);
    expect(menu.get('Acrylic fill')!.turnLevels).toEqual(['acrylic']);
    expect(menu.get('Nail art / design')!.deskPicks).toBe(true);
    expect(menu.get('Basic manicure')!.deskPicks).toBe(false);
  });
});

describe('setting a level', () => {
  it('only an owner or a manager, at their own location', async () => {
    expect(
      await setTechnicianLevel(db, { actor: receptionist, technicianId: reg.id, level: 'regular' }),
    ).toEqual({ ok: false, reason: 'not_allowed' });
    expect(
      await setTechnicianLevel(db, {
        actor: { ...owner, role: 'technician', userId: reg.userId },
        technicianId: reg.id,
        level: 'acrylic',
      }),
    ).toEqual({ ok: false, reason: 'not_allowed' });
    expect(
      await setTechnicianLevel(db, { actor: managerB, technicianId: reg.id, level: 'regular' }),
    ).toEqual({ ok: false, reason: 'wrong_location' });
    const [t] = await sql<
      { skill_level: string | null }[]
    >`select skill_level from technicians where id = ${reg.id}`;
    expect(t!.skill_level).toBeNull();
  });

  it('the level ticks every service at or below it', async () => {
    const r = await setTechnicianLevel(db, {
      actor: manager,
      technicianId: reg.id,
      level: 'regular',
    });
    expect(r.ok).toBe(true);
    const mine = await technicianLevel(db, reg.id);
    expect(mine.level).toBe('regular');
    const names = Object.entries(svc)
      .filter(([, id]) => mine.serviceIds.includes(id))
      .map(([n]) => n)
      .sort();
    expect(names).toEqual([
      'Basic manicure',
      'Basic pedicure',
      'Nail art / design',
      // v0.16.0 starting menu.
      'Nail fix / repair',
      'Polish change',
      'Spa pedicure',
    ]);

    const a = await setTechnicianLevel(db, {
      actor: owner,
      technicianId: acr.id,
      level: 'acrylic',
    });
    expect(a.ok && a.serviceIds.length).toBe(Object.keys(svc).length);
  });

  it('single services can be unticked: a gel pedicure but not a gel manicure', async () => {
    const all = await setTechnicianLevel(db, { actor: owner, technicianId: gel.id, level: 'gel' });
    if (!all.ok) throw new Error(all.reason);
    const without = all.serviceIds.filter((id) => id !== svc['Gel manicure']);
    expect(
      await setTechnicianLevel(db, {
        actor: owner,
        technicianId: gel.id,
        level: 'gel',
        serviceIds: without,
      }),
    ).toMatchObject({ ok: true });
    const mine = await technicianLevel(db, gel.id);
    expect(mine.serviceIds).toContain(svc['Gel pedicure']);
    expect(mine.serviceIds).not.toContain(svc['Gel manicure']);
    const [row] = await sql<
      { before: { level: string | null }; after: { level: string; serviceIds: string[] } }[]
    >`select before, after from audit_log where action = 'technician_level_changed' and entity_id = ${gel.id} order by at desc limit 1`;
    expect(row!.after.level).toBe('gel');
    expect(row!.after.serviceIds).not.toContain(svc['Gel manicure']);
  });

  it('refuses an unknown service and an empty list', async () => {
    expect(
      await setTechnicianLevel(db, {
        actor: owner,
        technicianId: gel.id,
        level: 'gel',
        serviceIds: [randomUUID()],
      }),
    ).toEqual({ ok: false, reason: 'unknown_service' });
    expect(
      await setTechnicianLevel(db, {
        actor: owner,
        technicianId: gel.id,
        level: 'gel',
        serviceIds: [],
      }),
    ).toEqual({ ok: false, reason: 'no_services' });
  });

  it('a technician reads her own ticks, not another technician’s, and writes nothing', async () => {
    const own = await asUser(reg.userId, (tx) => tx`select technician_id from technician_services`);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((r) => r['technician_id'] === reg.id)).toBe(true);
    await expect(
      asUser(
        reg.userId,
        (tx) =>
          tx`insert into technician_services (organization_id, location_id, technician_id, service_id) values (${ORG}, ${LOC}, ${reg.id}, ${svc['Acrylic fill']!})`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(
        reg.userId,
        (tx) => tx`update technicians set skill_level = 'acrylic' where id = ${reg.id}`,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('who gets a service by turn', () => {
  it('only an owner or a manager changes it; every level ticked is stored as everyone', async () => {
    const base = {
      serviceId: svc['Spa pedicure']!,
      minLevel: 'regular' as const,
      deskPicks: false,
    };
    expect(
      await setServiceLevels(db, { ...base, actor: receptionist, turnLevels: ['gel'] }),
    ).toEqual({ ok: false, reason: 'not_allowed' });
    expect(await setServiceLevels(db, { ...base, actor: managerB, turnLevels: ['gel'] })).toEqual({
      ok: false,
      reason: 'wrong_location',
    });
    expect(await setServiceLevels(db, { ...base, actor: manager, turnLevels: [] })).toEqual({
      ok: false,
      reason: 'no_levels',
    });
    expect(
      await setServiceLevels(db, {
        ...base,
        actor: manager,
        turnLevels: ['acrylic', 'regular', 'gel', 'dip'],
      }),
    ).toEqual({ ok: true });
    const menu = new Map((await menuLevels(db, LOC)).map((m) => [m.name, m]));
    expect(menu.get('Spa pedicure')!.turnLevels).toBeNull();
    const [row] = await sql<
      { action: string }[]
    >`select action from audit_log where entity_id = ${svc['Spa pedicure']!} order by at desc limit 1`;
    expect(row!.action).toBe('service_levels_changed');
  });
});

describe('calling by turn with levels', () => {
  beforeAll(async () => {
    // The line: Acr first, then Gel, then Reg (all at 0 points).
    await onFloor(acr, 30);
    await onFloor(gel, 20);
    await onFloor(reg, 10);
  });

  it('a regular manicure skips the acrylic technician, with no penalty, and calls the next', async () => {
    const v = await walkIn(['Basic manicure']);
    const r = await call(v);
    if (!r.ok) throw new Error(r.reason);
    expect(r.technicianId).toBe(gel.id);
    expect(r.skipped).toEqual([
      expect.objectContaining({
        technicianId: acr.id,
        why: 'not_by_turn',
        detail: 'Basic manicure',
      }),
    ]);
    expect(await pointsOf(acr)).toBe(0);
    // The snapshot on the call keeps the reason and the level.
    const [c] = await sql<
      { queue_snapshot: { technicianId: string; why: string; level?: string }[] }[]
    >`select queue_snapshot from turn_calls where id = ${r.callId}`;
    expect(c!.queue_snapshot[0]).toMatchObject({
      technicianId: acr.id,
      why: 'not_by_turn',
      level: 'acrylic',
    });
    await cancel(v);
  });

  it('the skipped technician keeps her place: the next acrylic service is hers', async () => {
    const v = await walkIn(['Acrylic fill']);
    const r = await call(v);
    expect(r.ok && r.technicianId).toBe(acr.id);
    await cancel(v);
  });

  it('a gel manicure goes past the gel technician who does not do it', async () => {
    // Acr is first and gets gel work by turn; hold her out to see the next pick.
    await transition(db, { technicianId: acr.id, to: 'break', actor: { userId: acr.userId } });
    const v = await walkIn(['Gel manicure']);
    const r = await call(v);
    expect(r).toMatchObject({ ok: false, reason: 'nobody_eligible' });
    if (r.ok) throw new Error('unexpected');
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ technicianId: gel.id, why: 'no_skill', detail: 'Gel manicure' }),
        expect.objectContaining({ technicianId: reg.id, why: 'no_skill', detail: 'Gel manicure' }),
      ]),
    );
    await cancel(v);
    const p = await walkIn(['Gel pedicure']);
    const rp = await call(p);
    expect(rp.ok && rp.technicianId).toBe(gel.id);
    await cancel(p);
    await transition(db, { technicianId: acr.id, to: 'available', actor: { userId: acr.userId } });
  });

  it('a pedicure is open to every level: the first in line takes it', async () => {
    const v = await walkIn(['Basic pedicure']);
    const r = await call(v);
    expect(r.ok && r.technicianId).toBe(acr.id);
    await cancel(v);
  });

  it('a client who asked for the acrylic technician gets her, even for a regular manicure', async () => {
    const v = await walkIn(['Basic manicure'], { requestedTechnicianId: acr.id });
    const r = await call(v);
    expect(r.ok && r.technicianId).toBe(acr.id);
    await cancel(v);
  });

  it('a manager can still force a reassign past the level rule', async () => {
    const v = await walkIn(['Basic manicure']);
    const refused = await reassignVisit(db, {
      visitId: v,
      toTechnicianId: acr.id,
      actor: manager,
      reason: 'busy day',
    });
    expect(refused).toMatchObject({
      ok: false,
      reason: 'target_not_eligible',
      detail: 'not_by_turn',
    });
    const forced = await reassignVisit(db, {
      visitId: v,
      toTechnicianId: acr.id,
      actor: manager,
      reason: 'busy day',
      force: true,
    });
    expect(forced.ok).toBe(true);
    await cancel(v);
  });
});

describe('asking a higher-level technician', () => {
  let visit: string;

  beforeAll(async () => {
    // Nobody at the regular or gel level is free.
    await transition(db, { technicianId: gel.id, to: 'break', actor: { userId: gel.userId } });
    await transition(db, { technicianId: reg.id, to: 'break', actor: { userId: reg.userId } });
    visit = await walkIn(['Basic manicure']);
  });

  afterAll(async () => {
    await transition(db, { technicianId: gel.id, to: 'available', actor: { userId: gel.userId } });
    await transition(db, { technicianId: reg.id, to: 'available', actor: { userId: reg.userId } });
  });

  it('the line calls nobody, and never offers on its own', async () => {
    const r = await call(visit);
    expect(r).toMatchObject({ ok: false, reason: 'nobody_eligible' });
    const open = await sql`select id from turn_calls where visit_id = ${visit}`;
    expect(open).toHaveLength(0);
  });

  it('the desk sees who it may ask: only technicians held out by the level rule alone', async () => {
    const options = await deskOptions(db, LOC);
    expect(options.get(visit)).toEqual({
      deskPicks: false,
      technicians: [
        expect.objectContaining({ technicianId: acr.id, level: 'acrylic', turn: 1, canCall: true }),
      ],
    });
  });

  it('while someone can take it by turn, the desk is not offered the higher level', async () => {
    await transition(db, { technicianId: reg.id, to: 'available', actor: { userId: reg.userId } });
    expect((await deskOptions(db, LOC)).get(visit)).toBeUndefined();
    await transition(db, { technicianId: reg.id, to: 'break', actor: { userId: reg.userId } });
  });

  it('an offer cannot go to someone who is not held out by the level rule', async () => {
    expect(
      await deskCall(db, {
        kind: 'offer',
        visitId: visit,
        technicianId: gel.id,
        actor: desk,
        locationId: LOC,
      }),
    ).toMatchObject({ ok: false, reason: 'target_not_eligible', detail: 'break' });
    expect(
      await deskCall(db, {
        kind: 'offer',
        visitId: visit,
        technicianId: acr.id,
        actor: desk,
        locationId: managerB.locationId,
      }),
    ).toEqual({ ok: false, reason: 'wrong_location' });
  });

  it('saying no costs nothing and is audited', async () => {
    const o = await deskCall(db, {
      kind: 'offer',
      visitId: visit,
      technicianId: acr.id,
      actor: desk,
      locationId: LOC,
    });
    if (!o.ok) throw new Error(o.reason);
    expect((await openCallFor(db, acr.id))?.kind).toBe('offer');
    const before = await pointsOf(acr);
    expect(
      await respondToCall(db, {
        callId: o.callId,
        technicianId: acr.id,
        response: 'denied',
        actor: { userId: acr.userId },
      }),
    ).toEqual({ ok: true });
    expect(await pointsOf(acr)).toBe(before);
    const ledger = await sql`select id from turn_ledger where visit_id = ${visit}`;
    expect(ledger).toHaveLength(0);
    const actions = (
      await sql<
        { action: string }[]
      >`select action from audit_log where entity_id = ${o.callId} order by at`
    ).map((a) => a.action);
    expect(actions).toEqual(['offer_sent', 'offer_declined']);
    const [v] = await sql<{ status: string }[]>`select status from visits where id = ${visit}`;
    expect(v!.status).toBe('waiting');
  });

  it('saying yes posts the normal points', async () => {
    const o = await deskCall(db, {
      kind: 'offer',
      visitId: visit,
      technicianId: acr.id,
      actor: desk,
      locationId: LOC,
    });
    if (!o.ok) throw new Error(o.reason);
    const before = await pointsOf(acr);
    expect(await accept(o.callId, acr)).toEqual({ ok: true });
    expect(await finish(acr)).toEqual({ ok: true, points: 1 });
    expect(await pointsOf(acr)).toBe(before + 1);
    const [a] = await sql<
      { action: string }[]
    >`select action from audit_log where entity_id = ${o.callId} order by at desc limit 1`;
    expect(a!.action).toBe('offer_accepted');
  });
});

describe('a visit with more than one service', () => {
  it('do all: one technician, the points of the whole visit, the choice audited', async () => {
    // Line now: Gel 0, Reg 0, Acr 1. A gel pedicure + spa pedicure is Gel's.
    const v = await walkIn(['Gel pedicure', 'Basic pedicure']);
    const r = await call(v);
    if (!r.ok) throw new Error(r.reason);
    expect(r.technicianId).toBe(gel.id);
    const open = await openCallFor(db, gel.id);
    expect(open!.serviceItems.map((s) => s.name).sort()).toEqual([
      'Basic pedicure',
      'Gel pedicure',
    ]);
    expect(await accept(r.callId, gel)).toEqual({ ok: true });
    const [a] = await sql<
      { after: { choice?: string } }[]
    >`select after from audit_log where entity_id = ${r.callId} and action = 'call_accepted'`;
    expect(a!.after.choice).toBe('all');
    expect(await finish(gel)).toEqual({ ok: true, points: 2 });
  });

  it('split: she keeps one, the rest wait as a linked visit with the same arrival time', async () => {
    // Line now: Reg 0, Acr 1, Gel 2.
    const v = await walkIn(['Basic manicure', 'Basic pedicure'], { note: 'red polish' });
    const r = await call(v);
    if (!r.ok) throw new Error(r.reason);
    expect(r.technicianId).toBe(reg.id);
    expect(await accept(r.callId, reg, [])).toEqual({ ok: false, reason: 'bad_split' });
    expect(await accept(r.callId, reg, [svc['Acrylic fill']!])).toEqual({
      ok: false,
      reason: 'bad_split',
    });
    const done = await accept(r.callId, reg, [svc['Basic manicure']!]);
    if (!done.ok || !done.splitVisitId) throw new Error('no split');

    const rows = await sql<
      {
        id: string;
        status: string;
        arrived_at: Date;
        split_from_visit_id: string | null;
        note: string | null;
      }[]
    >`select id, status, arrived_at, split_from_visit_id, note from visits where id in (${v}, ${done.splitVisitId})`;
    const first = rows.find((x) => x.id === v)!;
    const rest = rows.find((x) => x.id === done.splitVisitId)!;
    expect(first.status).toBe('in_service');
    expect(rest.status).toBe('waiting');
    expect(rest.split_from_visit_id).toBe(v);
    expect(rest.arrived_at.getTime()).toBe(first.arrived_at.getTime());
    expect(rest.note).toBe('red polish');
    const onDesk = (await waitingVisits(db, LOC)).find((w) => w.id === rest.id)!;
    expect(onDesk.services).toEqual(['Basic pedicure']);
    expect(onDesk.splitFromVisitId).toBe(v);

    const [audit] = await sql<
      { after: { keptServiceIds: string[]; sentBackServiceIds: string[]; newVisitId: string } }[]
    >`select after from audit_log where entity_id = ${v} and action = 'visit_split'`;
    expect(audit!.after).toEqual({
      keptServiceIds: [svc['Basic manicure']],
      sentBackServiceIds: [svc['Basic pedicure']],
      newVisitId: rest.id,
    });
    const [choice] = await sql<
      { after: { choice?: string } }[]
    >`select after from audit_log where entity_id = ${r.callId} and action = 'call_accepted'`;
    expect(choice!.after.choice).toBe('split');

    // Each technician is paid for what she did.
    expect(await finish(reg)).toEqual({ ok: true, points: 1 });
    const next = await call(rest.id);
    if (!next.ok) throw new Error(next.reason);
    expect(next.technicianId).toBe(acr.id); // Reg 1 (later check-in), Acr 1, Gel 2
    expect(await accept(next.callId, acr)).toEqual({ ok: true });
    expect(await finish(acr)).toEqual({ ok: true, points: 1 });
  });
});

describe('services the desk picks the technician for', () => {
  let visit: string;

  it('are never called by turn', async () => {
    visit = await walkIn(['Nail art / design']);
    expect(await call(visit)).toEqual({ ok: false, reason: 'desk_picks' });
    const onDesk = (await waitingVisits(db, LOC)).find((w) => w.id === visit)!;
    expect(onDesk.deskPicks).toBe(true);
  });

  it('the desk sees who does it, with status and turn', async () => {
    // Gel does not do nail art.
    const mine = await technicianLevel(db, gel.id);
    await setTechnicianLevel(db, {
      actor: owner,
      technicianId: gel.id,
      level: 'gel',
      serviceIds: mine.serviceIds.filter((id) => id !== svc['Nail art / design']),
    });
    await transition(db, { technicianId: reg.id, to: 'break', actor: { userId: reg.userId } });
    const o = (await deskOptions(db, LOC)).get(visit)!;
    expect(o.deskPicks).toBe(true);
    expect(o.technicians.map((t) => [t.displayName, t.status, t.canCall])).toEqual([
      ['Reg', 'break', false],
      ['Acr', 'available', true],
    ]);
    await transition(db, { technicianId: reg.id, to: 'available', actor: { userId: reg.userId } });
  });

  it('an offer is the wrong tool for it, and a pick is refused for an ordinary visit', async () => {
    expect(
      await deskCall(db, {
        kind: 'offer',
        visitId: visit,
        technicianId: acr.id,
        actor: desk,
        locationId: LOC,
      }),
    ).toEqual({ ok: false, reason: 'desk_picks' });
    const plain = await walkIn(['Basic pedicure']);
    expect(
      await deskCall(db, {
        kind: 'desk_pick',
        visitId: plain,
        technicianId: acr.id,
        actor: desk,
        locationId: LOC,
      }),
    ).toEqual({ ok: false, reason: 'not_desk_pick' });
    await cancel(plain);
  });

  it('the picked technician may say no without a penalty; yes posts normal points', async () => {
    expect(
      await deskCall(db, {
        kind: 'desk_pick',
        visitId: visit,
        technicianId: gel.id,
        actor: desk,
        locationId: LOC,
      }),
    ).toMatchObject({ ok: false, reason: 'target_not_eligible', detail: 'no_skill' });
    const p = await deskCall(db, {
      kind: 'desk_pick',
      visitId: visit,
      technicianId: acr.id,
      actor: desk,
      locationId: LOC,
    });
    if (!p.ok) throw new Error(p.reason);
    const before = await pointsOf(acr);
    await respondToCall(db, {
      callId: p.callId,
      technicianId: acr.id,
      response: 'denied',
      actor: { userId: acr.userId },
    });
    expect(await pointsOf(acr)).toBe(before);
    const again = await deskCall(db, {
      kind: 'desk_pick',
      visitId: visit,
      technicianId: acr.id,
      actor: desk,
      locationId: LOC,
    });
    if (!again.ok) throw new Error(again.reason);
    expect(await accept(again.callId, acr)).toEqual({ ok: true });
    expect(await finish(acr)).toEqual({ ok: true, points: 1 });
    expect(await pointsOf(acr)).toBe(before + 1);
    const actions = (
      await sql<
        { action: string }[]
      >`select action from audit_log where entity_id in (${p.callId}, ${again.callId}) order by at`
    ).map((a) => a.action);
    expect(actions).toEqual([
      'desk_pick_sent',
      'desk_pick_declined',
      'desk_pick_sent',
      'call_accepted',
    ]);
  });
});

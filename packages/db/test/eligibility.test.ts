// Done-when (REQ-5336cf7a, Part 6): each eligibility filter has its own test;
// the receptionist sees why each technician was skipped; every override
// writes an audit row with a reason; out-over posts the penalty and a manager
// can excuse it; a manager at location A cannot override at location B.
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizePhone } from '../src/clients';
import {
  adjustPoints,
  callNext,
  createWalkIn,
  excusePenalty,
  finishVisit,
  floorAttention,
  openCallFor,
  reassignVisit,
  respondToCall,
  restrictionBlocking,
  todayPenalties,
  waitingVisits,
} from '../src/engine';
import { saveProfile, type ProfileInput } from '../src/profile';
import { saveRuleConfig } from '../src/rules';
import { HEAVENLY, HEAVENLY_RULE_CONFIG_V1, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import type { StaffActor } from '../src/staff';
import { checkIn, lateStartPoints, shiftTotal, sweepFloor, transition } from '../src/status';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
const desk = { userId: null };
let manager: StaffActor;
let managerB: StaffActor;
let otherLoc: string;
let manicure: string;
let pedicure: string;
let fullSet: string;
let fullSetCat: string;
type Tech = { id: string; userId: string; name: string };
let an: Tech; // no male clients
let binh: Tech; // no kids, min age 12
let chi: Tech; // no same-time; no full sets

async function newTech(name: string, locationId = LOC): Promise<Tech> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${name}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${locationId}, 'technician')`;
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${userId}, ${ORG}, ${locationId}, ${name}) returning id`;
  return { id: t!.id, userId, name };
}

async function newManager(locationId: string): Promise<StaffActor> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`m-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, 'Vy')`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${locationId}, 'manager')`;
  return { userId, role: 'manager', organizationId: ORG, locationId };
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

async function statusOf(t: Tech): Promise<string> {
  const [s] = await sql<
    { status: string }[]
  >`select status from technician_status where technician_id = ${t.id}`;
  return s!.status;
}

type WalkIn = Omit<Parameters<typeof createWalkIn>[1], 'organizationId' | 'locationId' | 'actor'>;

/** A walk-in, then the call for it. */
async function walkInAndCall(input: WalkIn) {
  const v = await createWalkIn(db, { ...input, organizationId: ORG, locationId: LOC, actor: desk });
  if (!v.ok) throw new Error(v.reason);
  const call = await callNext(db, { visitId: v.visitId, actor: desk, locationId: LOC });
  return { visitId: v.visitId, visitIds: v.visitIds, call };
}

/** Accept and finish whoever holds the call, so the floor is clear again. */
async function settle(visitId: string) {
  const [open] = await sql<
    { id: string; technician_id: string }[]
  >`select id, technician_id from turn_calls where visit_id = ${visitId} and responded_at is null`;
  if (!open) return;
  await respondToCall(db, {
    callId: open.id,
    technicianId: open.technician_id,
    response: 'accepted',
    actor: desk,
  });
  await finishVisit(db, { technicianId: open.technician_id, actor: desk });
}

const onBreak = (t: Tech) =>
  transition(db, { technicianId: t.id, to: 'break', actor: { userId: t.userId } });
const backFromBreak = (t: Tech) =>
  transition(db, { technicianId: t.id, to: 'available', actor: { userId: t.userId } });

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
  const byName = async (name: string) => {
    const [r] = await sql<
      { id: string; category_id: string }[]
    >`select id, category_id from services where location_id = ${LOC} and name = ${name}`;
    return r!;
  };
  manicure = (await byName('Basic manicure')).id;
  pedicure = (await byName('Basic pedicure')).id;
  const f = await byName('Acrylic full set');
  fullSet = f.id;
  fullSetCat = f.category_id;
  const [b] = await sql<
    { id: string }[]
  >`insert into locations (organization_id, name) values (${ORG}, 'Heavenly Brandon') returning id`;
  otherLoc = b!.id;
  manager = await newManager(LOC);
  managerB = await newManager(otherLoc);

  an = await newTech('An');
  binh = await newTech('Bình');
  chi = await newTech('Chi');
  const set = (technicianId: string, profile: ProfileInput) =>
    saveProfile(db, { actor: manager, technicianId, profile });
  expect(
    await set(an.id, {
      skillCategoryIds: null,
      tags: ['fast'],
      restrictions: [{ type: 'no_male_clients', value: null, note: null }],
    }),
  ).toEqual({ ok: true });
  expect(
    await set(binh.id, {
      skillCategoryIds: null,
      tags: [],
      restrictions: [
        { type: 'no_kids', value: null, note: null },
        { type: 'min_client_age', value: 12, note: null },
      ],
    }),
  ).toEqual({ ok: true });
  const allButFullSet = (
    await sql<{ id: string }[]>`select id from service_categories where location_id = ${LOC}`
  )
    .map((c) => c.id)
    .filter((id) => id !== fullSetCat);
  expect(
    await set(chi.id, {
      skillCategoryIds: allButFullSet,
      tags: [],
      restrictions: [
        { type: 'no_same_time', value: null, note: null },
        { type: 'custom', value: null, note: 'prefers mornings' },
      ],
    }),
  ).toEqual({ ok: true });
  await onFloor(an); // first in line
  await onFloor(binh);
  await onFloor(chi);
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

describe('pure pieces', () => {
  it('restrictionBlocking: the first matching restriction, or none', () => {
    const p = {
      restrictions: [
        { type: 'no_male_clients' as const, value: null, note: null },
        { type: 'min_client_age' as const, value: 12, note: null },
      ],
    };
    const base = { categoryIds: [], gender: null, isKid: null, age: null, sameTime: false };
    expect(restrictionBlocking(p, base)).toBeNull();
    expect(restrictionBlocking(p, { ...base, gender: 'male' })).toBe('no_male_clients');
    expect(restrictionBlocking(p, { ...base, gender: 'female', age: 9 })).toBe('min_client_age');
    expect(restrictionBlocking(p, { ...base, age: 12 })).toBeNull();
    // A kid of unknown age counts as under the limit.
    expect(restrictionBlocking(p, { ...base, isKid: true })).toBe('min_client_age');
    expect(restrictionBlocking(p, { ...base, isKid: true, age: 30 })).toBeNull();
  });

  it('lateStartPoints: the highest tier reached; unset tier = null', () => {
    const rules = HEAVENLY_RULE_CONFIG_V1;
    expect(lateStartPoints(rules, 0)).toBeNull();
    expect(lateStartPoints(rules, 14)).toBeNull();
    expect(lateStartPoints(rules, 15)).toBe(0.5);
    expect(lateStartPoints(rules, 45)).toBe(1);
    expect(lateStartPoints(rules, 61)).toBeNull(); // 60+ is still to confirm with Phu
  });

  it('normalizePhone: US numbers to E.164, anything else null', () => {
    expect(normalizePhone('(813) 555-0100')).toBe('+18135550100');
    expect(normalizePhone('1 813 555 0100')).toBe('+18135550100');
    expect(normalizePhone('+18135550100')).toBe('+18135550100');
    expect(normalizePhone('555-0100')).toBeNull();
    expect(normalizePhone('0135550100')).toBeNull();
    expect(normalizePhone(12)).toBeNull();
  });
});

describe('eligibility filters, one by one', () => {
  it('no_male_clients: An is skipped for a man, and the desk sees why', async () => {
    const { visitId, call } = await walkInAndCall({
      serviceIds: [manicure],
      attributes: { gender: 'male' },
    });
    expect(call).toMatchObject({ ok: true, technicianId: binh.id });
    if (call.ok) {
      expect(call.skipped).toEqual([
        { technicianId: an.id, displayName: 'An', why: 'no_male_clients' },
      ]);
    }
    const [row] = await sql<
      { queue_snapshot: { displayName: string; why: string; eligible: boolean }[] }[]
    >`select queue_snapshot from turn_calls where visit_id = ${visitId}`;
    expect(row?.queue_snapshot.find((q) => q.displayName === 'An')).toMatchObject({
      eligible: false,
      why: 'no_male_clients',
    });
    await settle(visitId);
    // Points: An 0, Bình 1, Chi 0.
  });

  it('no_kids: Bình is skipped for a kid', async () => {
    // Put An and Chi on break so Bình is the only one free: nobody can be called.
    await onBreak(an);
    await onBreak(chi);
    const { visitId, call } = await walkInAndCall({
      serviceIds: [manicure],
      attributes: { gender: 'female', isKid: true, age: 15 },
    });
    expect(call).toMatchObject({ ok: false, reason: 'nobody_eligible' });
    if (!call.ok) {
      expect(call.skipped!.map((s) => [s.displayName, s.why])).toEqual(
        expect.arrayContaining([
          ['Bình', 'no_kids'],
          ['An', 'break'],
          ['Chi', 'break'],
        ]),
      );
    }
    await backFromBreak(an);
    await backFromBreak(chi);
    const again = await callNext(db, { visitId, actor: desk, locationId: LOC });
    expect(again).toMatchObject({ ok: true, technicianId: an.id });
    await settle(visitId);
    // Points: An 1, Bình 1, Chi 0.
  });

  it('min_client_age: a 9-year-old skips Bình even without the kid flag', async () => {
    // Chi (0) is first; put Chi on break so Bình (1, checked in before An? no: An first)
    // An 1 (earlier check-in), Bình 1, Chi 0 on break -> An, then Bình.
    await onBreak(chi);
    await onBreak(an);
    const { visitId, call } = await walkInAndCall({
      serviceIds: [manicure],
      attributes: { gender: 'female', isKid: false, age: 9 },
    });
    expect(call).toMatchObject({ ok: false, reason: 'nobody_eligible' });
    if (!call.ok) {
      expect(call.skipped!.find((s) => s.technicianId === binh.id)?.why).toBe('min_client_age');
    }
    await backFromBreak(an);
    await backFromBreak(chi);
    const again = await callNext(db, { visitId, actor: desk, locationId: LOC });
    expect(again).toMatchObject({ ok: true, technicianId: chi.id });
    if (again.ok) {
      // Chi was first in line anyway; nobody ahead was skipped.
      expect(again.skipped).toEqual([]);
    }
    await settle(visitId);
    // Points: An 1, Bình 1, Chi 1.
  });

  it('no_skill: Chi never gets a full set, and the missing category is named', async () => {
    await onBreak(an);
    await onBreak(binh);
    const { visitId, call } = await walkInAndCall({ serviceIds: [fullSet] });
    expect(call).toMatchObject({ ok: false, reason: 'nobody_eligible' });
    if (!call.ok) {
      expect(call.skipped!.find((s) => s.technicianId === chi.id)).toMatchObject({
        displayName: 'Chi',
        why: 'no_skill',
        detail: 'full_set',
        note: 'prefers mornings', // the custom restriction rides along for the desk
      });
    }
    await backFromBreak(an);
    await backFromBreak(binh);
    const again = await callNext(db, { visitId, actor: desk, locationId: LOC });
    expect(again).toMatchObject({ ok: true, technicianId: an.id });
    await settle(visitId);
    // Points: An 1.5, Bình 1, Chi 1.
  });

  it('skill_match "off" lets Chi take a full set', async () => {
    const owner = { userId: null };
    const saved = await saveRuleConfig(db, {
      organizationId: ORG,
      locationId: LOC,
      actor: owner,
      config: {
        ...HEAVENLY_RULE_CONFIG_V1,
        eligibility: { ...HEAVENLY_RULE_CONFIG_V1.eligibility, skill_match: 'off' },
      },
    });
    expect(saved.ok).toBe(true);
    await onBreak(an);
    await onBreak(binh);
    const { visitId, call } = await walkInAndCall({ serviceIds: [fullSet] });
    expect(call).toMatchObject({ ok: true, technicianId: chi.id });
    await settle(visitId);
    await backFromBreak(an);
    await backFromBreak(binh);
    const back = await saveRuleConfig(db, {
      organizationId: ORG,
      locationId: LOC,
      actor: owner,
      config: HEAVENLY_RULE_CONFIG_V1,
    });
    expect(back.ok).toBe(true);
    // Points: An 1.5, Bình 1, Chi 1.5.
  });

  it('no_same_time: "both at once" opens two linked visits and skips Chi for both', async () => {
    const v = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure, pedicure],
      sameTime: true,
      actor: desk,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.visitIds).toHaveLength(2);
    const [g] = await sql<
      { n: number }[]
    >`select count(distinct group_id)::int as n from visits where id in ${sql(v.visitIds)} and group_id is not null`;
    expect(g?.n).toBe(1);
    // Make Chi lowest so the skip is visible.
    await adjustPoints(db, { technicianId: chi.id, delta: -1.5, actor: manager, reason: 'test' });
    const first = await callNext(db, { visitId: v.visitIds[0]!, actor: desk, locationId: LOC });
    const second = await callNext(db, { visitId: v.visitIds[1]!, actor: desk, locationId: LOC });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(new Set([first.technicianId, second.technicianId])).toEqual(new Set([an.id, binh.id]));
      expect(first.skipped.find((s) => s.technicianId === chi.id)).toMatchObject({
        displayName: 'Chi',
        why: 'no_same_time',
      });
    }
    const listed = await waitingVisits(db, LOC);
    expect(listed.filter((w) => v.visitIds.includes(w.id)).every((w) => w.groupId)).toBe(true);
    await settle(v.visitIds[0]!);
    await settle(v.visitIds[1]!);
    await adjustPoints(db, { technicianId: chi.id, delta: 1.5, actor: manager, reason: 'test' });
    // Points: An 2.5, Bình 2, Chi 1.5.
  });

  it('appointment_soon: a technician with an appointment inside the buffer is skipped', async () => {
    // Chi is lowest. Give Chi an appointment in 20 minutes (buffer 30).
    const start = new Date(Date.now() + 20 * 60_000);
    const end = new Date(start.getTime() + 45 * 60_000);
    await sql`insert into appointments (organization_id, location_id, technician_id, client_name, start_at, end_at) values (${ORG}, ${LOC}, ${chi.id}, 'Appt', ${start}, ${end})`;
    const { visitId, call } = await walkInAndCall({ serviceIds: [manicure] });
    expect(call).toMatchObject({ ok: true, technicianId: binh.id });
    if (call.ok) {
      expect(call.skipped[0]).toMatchObject({ technicianId: chi.id, why: 'appointment_soon' });
      expect(Number(call.skipped[0]?.detail)).toBeLessThanOrEqual(20);
    }
    await settle(visitId);
    await sql`update appointments set cancelled_at = now() where technician_id = ${chi.id}`;
    // Points: An 2.5, Bình 3, Chi 1.5.
  });

  it('busy: a technician with a visit in progress is never called again', async () => {
    // Force the inconsistent state the guard exists for: available in status,
    // but a visit still in service on them.
    const v = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      actor: desk,
    });
    if (!v.ok) throw new Error(v.reason);
    await sql`update visits set status = 'in_service', assigned_technician_id = ${chi.id}, started_at = now() where id = ${v.visitId}`;
    const { visitId, call } = await walkInAndCall({ serviceIds: [manicure] });
    expect(call).toMatchObject({ ok: true, technicianId: an.id });
    if (call.ok) {
      expect(call.skipped.find((s) => s.technicianId === chi.id)?.why).toBe('busy');
    }
    await settle(visitId);
    await sql`update visits set status = 'cancelled', cancelled_at = now() where id = ${v.visitId}`;
    // Points: An 3.5, Bình 3, Chi 1.5.
  });

  it('a requested technician skips the queue only when the rules say so', async () => {
    // An has the most points; a request for An goes to An.
    const { visitId, call } = await walkInAndCall({
      serviceIds: [manicure],
      requestedTechnicianId: an.id,
    });
    expect(call).toMatchObject({ ok: true, technicianId: an.id });
    await settle(visitId);
    const owner = { userId: null };
    await saveRuleConfig(db, {
      organizationId: ORG,
      locationId: LOC,
      actor: owner,
      config: {
        ...HEAVENLY_RULE_CONFIG_V1,
        requests: { ...HEAVENLY_RULE_CONFIG_V1.requests, requested_tech_bypasses_queue: false },
      },
    });
    const second = await walkInAndCall({ serviceIds: [manicure], requestedTechnicianId: an.id });
    expect(second.call).toMatchObject({ ok: true, technicianId: chi.id });
    await settle(second.visitId);
    await saveRuleConfig(db, {
      organizationId: ORG,
      locationId: LOC,
      actor: owner,
      config: HEAVENLY_RULE_CONFIG_V1,
    });
    const unknown = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      requestedTechnicianId: randomUUID(),
      actor: desk,
    });
    expect(unknown).toEqual({ ok: false, reason: 'unknown_technician' });
  });

  it('a walk-in with a phone makes one client row and finds it again', async () => {
    const first = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      client: { name: 'Lan', phone: '(813) 555-0199' },
      attributes: { gender: 'female' },
      actor: desk,
    });
    const second = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      client: { phone: '813-555-0199' },
      actor: desk,
    });
    expect(first.ok && second.ok).toBe(true);
    const rows = await sql<
      { id: string; name: string; phone: string; gender: string }[]
    >`select id, name, phone, gender from clients where location_id = ${LOC} and phone = '+18135550199'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Lan', phone: '+18135550199', gender: 'female' });
    const bad = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      client: { phone: '12' },
      actor: desk,
    });
    expect(bad).toEqual({ ok: false, reason: 'bad_phone' });
    const [audit] = await sql<
      { after: Record<string, unknown> }[]
    >`select after from audit_log where action = 'visit_created' order by at desc limit 1`;
    // The audit row never carries the name or phone.
    expect(JSON.stringify(audit?.after)).not.toContain('Lan');
    expect(JSON.stringify(audit?.after)).not.toContain('0199');
    if (first.ok) await sql`update visits set status = 'cancelled' where id = ${first.visitId}`;
    if (second.ok) await sql`update visits set status = 'cancelled' where id = ${second.visitId}`;
  });

  it('a technician cannot read clients; the salon staff can', async () => {
    const asTech = await asUser(an.userId, (tx) => tx`select id from clients`);
    expect(asTech).toHaveLength(0);
    const asManager = await asUser(manager.userId, (tx) => tx`select id from clients`);
    expect(asManager.length).toBeGreaterThan(0);
  });
});

describe('manager overrides', () => {
  it('a manager at location A cannot reassign or adjust at location B', async () => {
    const v = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      actor: desk,
    });
    if (!v.ok) throw new Error(v.reason);
    const moved = await reassignVisit(db, {
      visitId: v.visitId,
      toTechnicianId: an.id,
      actor: managerB,
      reason: 'wrong desk',
    });
    expect(moved).toEqual({ ok: false, reason: 'wrong_location' });
    const adjusted = await adjustPoints(db, {
      technicianId: an.id,
      delta: 1,
      actor: managerB,
      reason: 'test',
    });
    expect(adjusted).toEqual({ ok: false, reason: 'wrong_location' });
    await sql`update visits set status = 'cancelled' where id = ${v.visitId}`;
  });

  it('reassign with force overrides a restriction, never a status, and says so in the audit', async () => {
    const v = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      attributes: { gender: 'male' },
      actor: desk,
    });
    if (!v.ok) throw new Error(v.reason);
    const refused = await reassignVisit(db, {
      visitId: v.visitId,
      toTechnicianId: an.id,
      actor: manager,
      reason: 'client asked for An',
    });
    expect(refused).toMatchObject({
      ok: false,
      reason: 'target_not_eligible',
      detail: 'no_male_clients',
    });
    const forced = await reassignVisit(db, {
      visitId: v.visitId,
      toTechnicianId: an.id,
      actor: manager,
      reason: 'client asked for An',
      force: true,
    });
    expect(forced.ok).toBe(true);
    const [audit] = await sql<
      { after: { forced: string }; reason: string }[]
    >`select after, reason from audit_log where entity_id = ${v.visitId} and action = 'visit_reassigned'`;
    expect(audit).toMatchObject({
      after: { forced: 'no_male_clients' },
      reason: 'client asked for An',
    });
    await settle(v.visitId);
    // Status is never overridden: Bình on break stays on break.
    await onBreak(binh);
    const w = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      actor: desk,
    });
    if (!w.ok) throw new Error(w.reason);
    const still = await reassignVisit(db, {
      visitId: w.visitId,
      toTechnicianId: binh.id,
      actor: manager,
      reason: 'try',
      force: true,
    });
    expect(still).toMatchObject({ ok: false, reason: 'target_not_eligible', detail: 'break' });
    await backFromBreak(binh);
    await sql`update visits set status = 'cancelled' where id = ${w.visitId}`;
  });

  it('a deny is excused once: the penalty is reversed, the call marked, the audit written', async () => {
    const { visitId, call } = await walkInAndCall({ serviceIds: [manicure] });
    if (!call.ok) throw new Error(call.reason);
    const tech = [an, binh, chi].find((t) => t.id === call.technicianId)!;
    const before = await shiftTotal(db, await shiftOf(tech));
    await respondToCall(db, {
      callId: call.callId,
      technicianId: tech.id,
      response: 'denied',
      // Not a reason the rules excuse on their own (v0.15.0: break, personal).
      denyReason: 'client_issue',
      actor: { userId: tech.userId },
    });
    expect(await shiftTotal(db, await shiftOf(tech))).toBe(before + 1);
    const penalties = await todayPenalties(db, LOC);
    const deny = penalties.find((p) => p.visitId === visitId && p.reasonType === 'deny');
    expect(deny).toMatchObject({ technicianId: tech.id, delta: 1, excused: false });
    const noReason = await excusePenalty(db, {
      ledgerId: deny!.ledgerId,
      actor: manager,
      reason: '',
    });
    expect(noReason).toEqual({ ok: false, reason: 'reason_required' });
    const elsewhere = await excusePenalty(db, {
      ledgerId: deny!.ledgerId,
      actor: managerB,
      reason: 'x',
    });
    expect(elsewhere).toEqual({ ok: false, reason: 'wrong_location' });
    const ok = await excusePenalty(db, {
      ledgerId: deny!.ledgerId,
      actor: manager,
      reason: 'was helping a client at the dryer',
    });
    expect(ok).toEqual({ ok: true });
    expect(await shiftTotal(db, await shiftOf(tech))).toBe(before);
    const twice = await excusePenalty(db, {
      ledgerId: deny!.ledgerId,
      actor: manager,
      reason: 'x',
    });
    expect(twice).toEqual({ ok: false, reason: 'already_excused' });
    const [c] = await sql<
      { excused_by: string; excused_at: Date }[]
    >`select excused_by, excused_at from turn_calls where id = ${call.callId}`;
    expect(c?.excused_by).toBe(manager.userId);
    expect(c?.excused_at).not.toBeNull();
    const [audit] = await sql<
      { reason: string; actor_user_id: string }[]
    >`select reason, actor_user_id from audit_log where action = 'deny_excused' order by at desc limit 1`;
    expect(audit).toEqual({
      reason: 'was helping a client at the dryer',
      actor_user_id: manager.userId,
    });
    expect(
      (await todayPenalties(db, LOC)).find((p) => p.ledgerId === deny!.ledgerId)?.excused,
    ).toBe(true);
    await callNext(db, { visitId, actor: desk, locationId: LOC });
    await settle(visitId);
  });

  it('adjust points: half steps with a reason, audited; nothing else', async () => {
    const before = await shiftTotal(db, await shiftOf(an));
    expect(
      await adjustPoints(db, { technicianId: an.id, delta: 0.3, actor: manager, reason: 'r' }),
    ).toEqual({ ok: false, reason: 'bad_delta' });
    expect(
      await adjustPoints(db, { technicianId: an.id, delta: 0, actor: manager, reason: 'r' }),
    ).toEqual({ ok: false, reason: 'bad_delta' });
    expect(
      await adjustPoints(db, { technicianId: an.id, delta: -0.5, actor: manager, reason: '  ' }),
    ).toEqual({ ok: false, reason: 'reason_required' });
    expect(
      await adjustPoints(db, {
        technicianId: an.id,
        delta: -0.5,
        actor: manager,
        reason: 'stayed late yesterday',
      }),
    ).toEqual({ ok: true });
    expect(await shiftTotal(db, await shiftOf(an))).toBe(before - 0.5);
    const [audit] = await sql<
      { reason: string; after: { delta: number } }[]
    >`select reason, after from audit_log where action = 'points_adjusted' order by at desc limit 1`;
    expect(audit).toEqual({
      reason: 'stayed late yesterday',
      // Part 8: the design doc's audit table asks for the total before and after.
      after: { technicianId: an.id, delta: -0.5, points: before - 0.5 },
    });
  });
});

describe('timers', () => {
  it('out over the limit posts the penalty once, the board flags it, and a manager can excuse it', async () => {
    const before = await shiftTotal(db, await shiftOf(chi));
    await transition(db, { technicianId: chi.id, to: 'out', actor: { userId: chi.userId } });
    // Not yet: 59 minutes.
    const soon = new Date(Date.now() + 59 * 60_000);
    expect((await sweepFloor(db, LOC, soon)).outOverPosted).toEqual([]);
    const later = new Date(Date.now() + 61 * 60_000);
    const attention = await floorAttention(db, LOC, later);
    expect(attention.timers.find((t) => t.technicianId === chi.id)).toMatchObject({
      status: 'out',
      over: true,
    });
    expect((await sweepFloor(db, LOC, later)).outOverPosted).toEqual([chi.id]);
    expect((await sweepFloor(db, LOC, later)).outOverPosted).toEqual([]); // once
    expect(await shiftTotal(db, await shiftOf(chi))).toBe(before + 1);
    // Coming back does not post it again.
    await transition(db, {
      technicianId: chi.id,
      to: 'available',
      actor: { userId: chi.userId },
      now: new Date(Date.now() + 62 * 60_000),
    });
    expect(await shiftTotal(db, await shiftOf(chi))).toBe(before + 1);
    const row = (await todayPenalties(db, LOC)).find(
      (p) => p.technicianId === chi.id && p.reasonType === 'out_over',
    );
    expect(row).toBeDefined();
    expect(
      await excusePenalty(db, { ledgerId: row!.ledgerId, actor: manager, reason: 'car trouble' }),
    ).toEqual({ ok: true });
    expect(await shiftTotal(db, await shiftOf(chi))).toBe(before);
  });

  it('coming back from a long out posts the penalty even when nobody swept', async () => {
    const before = await shiftTotal(db, await shiftOf(binh));
    await transition(db, { technicianId: binh.id, to: 'out', actor: { userId: binh.userId } });
    await transition(db, {
      technicianId: binh.id,
      to: 'available',
      actor: { userId: binh.userId },
      now: new Date(Date.now() + 75 * 60_000),
    });
    expect(await shiftTotal(db, await shiftOf(binh))).toBe(before + 1);
  });

  it('a late check-in posts the tier’s start points, once', async () => {
    const late = await newTech('Dung');
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
    // Scheduled 09:00 local; check in at 09:40 local: 40 min late, tier 30, 1 point.
    const localDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: HEAVENLY.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(tomorrow);
    await sql`insert into shifts (organization_id, location_id, technician_id, date, scheduled_start, checked_in_at) values (${ORG}, ${LOC}, ${late.id}, ${localDay}, '09:00', ${tomorrow})`;
    const [clock] = await sql<
      { at: Date }[]
    >`select ((${localDay}::date + time '09:40') at time zone ${HEAVENLY.timezone}) as at`;
    const at = clock!.at;
    const r = await checkIn(db, {
      technicianId: late.id,
      actor: { userId: late.userId },
      position: null,
      now: at,
    });
    expect(r.ok).toBe(true);
    expect(await shiftTotal(db, await shiftOf(late))).toBe(1);
    // Check out and back in the same day: no second late row.
    await transition(db, { technicianId: late.id, to: 'off', actor: { userId: late.userId } });
    await checkIn(db, {
      technicianId: late.id,
      actor: { userId: late.userId },
      position: null,
      now: at,
    });
    expect(await shiftTotal(db, await shiftOf(late))).toBe(1);
    await transition(db, { technicianId: late.id, to: 'off', actor: { userId: late.userId } });
  });

  it('a shift left open from yesterday is closed by the sweep, unless a call is open', async () => {
    const old = await newTech('Em');
    await onFloor(old);
    await sql`update shifts set date = date - 1 where technician_id = ${old.id}`;
    const swept = await sweepFloor(db, LOC);
    expect(swept.autoCheckedOut).toEqual([old.id]);
    expect(await statusOf(old)).toBe('off');
    const [audit] = await sql<
      { action: string }[]
    >`select action from audit_log where entity_id = ${old.id} order by at desc limit 1`;
    expect(audit?.action).toBe('auto_check_out');
    // With an open call the sweep leaves them alone.
    await onFloor(old);
    const v = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      requestedTechnicianId: old.id,
      actor: desk,
    });
    if (!v.ok) throw new Error(v.reason);
    const c = await callNext(db, { visitId: v.visitId, actor: desk, locationId: LOC });
    expect(c).toMatchObject({ ok: true, technicianId: old.id });
    await sql`update shifts set date = date - 1 where technician_id = ${old.id}`;
    expect((await sweepFloor(db, LOC)).autoCheckedOut).toEqual([]);
    expect(await statusOf(old)).toBe('available');
    expect(await openCallFor(db, old.id)).not.toBeNull();
    await settle(v.visitId);
  });
});

// Added after the Part 6 code review: the filters not yet covered, and the
// defects the reviewers found (a refused reassign that wrote anyway, a
// penalty vanishing from the list after check-out, a late row on a return,
// the queue snapshot readable by technicians, own-points overrides).
describe('review follow-ups', () => {
  let d: Tech;
  let e: Tech;
  const owner = { userId: null };

  it('already_called, and every status, each say so', async () => {
    // Rest everyone else so the two new technicians are the floor.
    await sql`update technician_status set status = 'break', since = now() where location_id = ${LOC} and status = 'available'`;
    d = await newTech('Dao');
    e = await newTech('Ewa');
    await onFloor(d);
    await onFloor(e);
    const first = await walkInAndCall({ serviceIds: [manicure] });
    expect(first.call).toMatchObject({ ok: true, technicianId: d.id });
    const second = await walkInAndCall({ serviceIds: [manicure] });
    expect(second.call).toMatchObject({ ok: true, technicianId: e.id });
    if (second.call.ok) {
      expect(second.call.skipped).toContainEqual({
        technicianId: d.id,
        displayName: 'Dao',
        why: 'already_called',
      });
    }
    await settle(first.visitId);
    await settle(second.visitId);
    // out and in_service
    await transition(db, { technicianId: d.id, to: 'out', actor: { userId: d.userId } });
    const third = await walkInAndCall({ serviceIds: [manicure] });
    if (!third.call.ok) throw new Error(third.call.reason);
    expect(third.call.technicianId).toBe(e.id);
    await respondToCall(db, {
      callId: third.call.callId,
      technicianId: e.id,
      response: 'accepted',
      actor: desk,
    });
    const fourth = await walkInAndCall({ serviceIds: [manicure] });
    expect(fourth.call).toMatchObject({ ok: false, reason: 'nobody_eligible' });
    if (!fourth.call.ok) {
      const why = new Map(fourth.call.skipped!.map((s) => [s.technicianId, s.why]));
      expect(why.get(d.id)).toBe('out');
      expect(why.get(e.id)).toBe('in_service');
      expect(why.get(an.id)).toBe('break');
    }
    await finishVisit(db, { technicianId: e.id, actor: desk });
    await transition(db, { technicianId: d.id, to: 'available', actor: { userId: d.userId } });
    // checked_in (not ready yet)
    const f = await newTech('Fay');
    await checkIn(db, { technicianId: f.id, actor: { userId: f.userId }, position: null });
    const fifth = await walkInAndCall({ serviceIds: [manicure] });
    if (fifth.call.ok) {
      expect(fifth.call.skipped.find((s) => s.technicianId === f.id)?.why).toBe('checked_in');
    }
    await callNext(db, { visitId: fourth.visitId, actor: desk, locationId: LOC });
    await settle(fourth.visitId);
    await settle(fifth.visitId);
    await transition(db, { technicianId: f.id, to: 'off', actor: { userId: f.userId } });
  });

  it('skill_match "preferred" puts a skilled technician ahead at any points; honor_restrictions off ignores them', async () => {
    // Ewa cannot do full sets; Dao can. Give Dao more points so Ewa would be first.
    const cats = await sql<
      { id: string }[]
    >`select id from service_categories where location_id = ${LOC} and id <> ${fullSetCat}`;
    expect(
      await saveProfile(db, {
        actor: manager,
        technicianId: e.id,
        profile: { skillCategoryIds: cats.map((c) => c.id), tags: [], restrictions: [] },
      }),
    ).toEqual({ ok: true });
    await adjustPoints(db, { technicianId: d.id, delta: 2, actor: manager, reason: 'test' });
    const save = (config: unknown) =>
      saveRuleConfig(db, { organizationId: ORG, locationId: LOC, actor: owner, config });
    await save({
      ...HEAVENLY_RULE_CONFIG_V1,
      eligibility: { ...HEAVENLY_RULE_CONFIG_V1.eligibility, skill_match: 'preferred' },
    });
    const preferred = await walkInAndCall({ serviceIds: [fullSet] });
    expect(preferred.call).toMatchObject({ ok: true, technicianId: d.id });
    // Ewa was behind Dao in the order, not skipped (the rested technicians ahead are).
    if (preferred.call.ok) {
      expect(preferred.call.skipped.find((x) => x.technicianId === e.id)).toBeUndefined();
    }
    await settle(preferred.visitId);
    // honor_restrictions off: Ewa takes a man even with no_male_clients.
    expect(
      await saveProfile(db, {
        actor: manager,
        technicianId: e.id,
        profile: {
          skillCategoryIds: null,
          tags: [],
          restrictions: [{ type: 'no_male_clients', value: null, note: null }],
        },
      }),
    ).toEqual({ ok: true });
    await save({
      ...HEAVENLY_RULE_CONFIG_V1,
      eligibility: { ...HEAVENLY_RULE_CONFIG_V1.eligibility, honor_restrictions: false },
    });
    await onBreak(d);
    const man = await walkInAndCall({ serviceIds: [manicure], attributes: { gender: 'male' } });
    expect(man.call).toMatchObject({ ok: true, technicianId: e.id });
    await settle(man.visitId);
    await save(HEAVENLY_RULE_CONFIG_V1);
    const manAgain = await walkInAndCall({
      serviceIds: [manicure],
      attributes: { gender: 'male' },
    });
    expect(manAgain.call).toMatchObject({ ok: false, reason: 'nobody_eligible' });
    await backFromBreak(d);
    await callNext(db, { visitId: manAgain.visitId, actor: desk, locationId: LOC });
    await settle(manAgain.visitId);
  });

  it('a refused reassign leaves the open call and the first technician untouched; "count it as a deny" is excusable', async () => {
    const { visitId, call } = await walkInAndCall({ serviceIds: [manicure] });
    if (!call.ok) throw new Error(call.reason);
    const holder = call.technicianId === d.id ? d : e;
    const other = holder === d ? e : d;
    await onBreak(other);
    const before = await shiftTotal(db, await shiftOf(holder));
    const refused = await reassignVisit(db, {
      visitId,
      toTechnicianId: other.id,
      actor: manager,
      reason: 'try',
      penalizeFirst: true,
    });
    expect(refused).toMatchObject({ ok: false, reason: 'target_not_eligible', detail: 'break' });
    expect((await openCallFor(db, holder.id))?.visitId).toBe(visitId);
    expect(await shiftTotal(db, await shiftOf(holder))).toBe(before);
    const [v] = await sql<{ status: string }[]>`select status from visits where id = ${visitId}`;
    expect(v?.status).toBe('called');
    await backFromBreak(other);
    const moved = await reassignVisit(db, {
      visitId,
      toTechnicianId: other.id,
      actor: manager,
      reason: 'called wrong',
      penalizeFirst: true,
    });
    expect(moved.ok).toBe(true);
    expect(await shiftTotal(db, await shiftOf(holder))).toBe(before + 1);
    const row = (await todayPenalties(db, LOC)).find(
      (p) => p.visitId === visitId && p.technicianId === holder.id && p.reasonType === 'deny',
    );
    expect(row).toBeDefined();
    expect(row?.note).toBe('reassigned'); // the manager's words are in the audit log only
    expect(
      await excusePenalty(db, { ledgerId: row!.ledgerId, actor: manager, reason: 'my mistake' }),
    ).toEqual({ ok: true });
    expect(await shiftTotal(db, await shiftOf(holder))).toBe(before);
    await settle(visitId);
  });

  it('a penalty stays on today’s list after the technician checks out; nobody excuses or adjusts their own', async () => {
    const { visitId, call } = await walkInAndCall({ serviceIds: [manicure] });
    if (!call.ok) throw new Error(call.reason);
    const tech = call.technicianId === d.id ? d : e;
    await respondToCall(db, {
      callId: call.callId,
      technicianId: tech.id,
      response: 'denied',
      denyReason: 'other',
      actor: { userId: tech.userId },
    });
    await transition(db, { technicianId: tech.id, to: 'off', actor: { userId: tech.userId } });
    const row = (await todayPenalties(db, LOC)).find(
      (p) => p.visitId === visitId && p.reasonType === 'deny',
    );
    expect(row).toMatchObject({ technicianId: tech.id, excused: false });
    const self = { userId: tech.userId, organizationId: ORG, locationId: LOC };
    expect(await excusePenalty(db, { ledgerId: row!.ledgerId, actor: self, reason: 'me' })).toEqual(
      {
        ok: false,
        reason: 'own_points',
      },
    );
    expect(
      await excusePenalty(db, {
        ledgerId: row!.ledgerId,
        actor: manager,
        reason: 'went home sick',
      }),
    ).toEqual({ ok: true });
    await onFloor(tech);
    expect(
      await adjustPoints(db, { technicianId: tech.id, delta: 1, actor: self, reason: 'me' }),
    ).toEqual({ ok: false, reason: 'own_points' });
    await callNext(db, { visitId, actor: desk, locationId: LOC });
    await settle(visitId);
  });

  it('a same-time pair with a requested technician still calls two technicians', async () => {
    const v = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure, pedicure],
      sameTime: true,
      requestedTechnicianId: d.id,
      actor: desk,
    });
    if (!v.ok) throw new Error(v.reason);
    const first = await callNext(db, { visitId: v.visitIds[0]!, actor: desk, locationId: LOC });
    const second = await callNext(db, { visitId: v.visitIds[1]!, actor: desk, locationId: LOC });
    expect(first).toMatchObject({ ok: true, technicianId: d.id });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.technicianId).not.toBe(d.id);
    await settle(v.visitIds[0]!);
    await settle(v.visitIds[1]!);
  });

  it('an on-time technician who comes back in the afternoon gets no late row', async () => {
    const g = await newTech('Giang');
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
    const localDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: HEAVENLY.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(tomorrow);
    const at = async (hhmm: string) => {
      const [row] = await sql<
        { at: Date }[]
      >`select ((${localDay}::date + ${hhmm}::time) at time zone ${HEAVENLY.timezone}) as at`;
      return row!.at;
    };
    await sql`insert into shifts (organization_id, location_id, technician_id, date, scheduled_start, checked_in_at) values (${ORG}, ${LOC}, ${g.id}, ${localDay}, '09:00', ${await at('08:00')})`;
    // On time at 08:55: the row already exists for the day (the schedule made
    // it), so this is not the first check-in and late is 0 anyway.
    await checkIn(db, {
      technicianId: g.id,
      actor: { userId: g.userId },
      position: null,
      now: await at('08:55'),
    });
    expect(await shiftTotal(db, await shiftOf(g))).toBe(0);
    await transition(db, { technicianId: g.id, to: 'off', actor: { userId: g.userId } });
    await checkIn(db, {
      technicianId: g.id,
      actor: { userId: g.userId },
      position: null,
      now: await at('15:00'),
    });
    expect(await shiftTotal(db, await shiftOf(g))).toBe(0);
    await transition(db, { technicianId: g.id, to: 'off', actor: { userId: g.userId } });
  });

  it('a technician reads their own call without the queue snapshot', async () => {
    const { visitId, call } = await walkInAndCall({
      serviceIds: [manicure],
      attributes: { gender: 'male' },
    });
    if (!call.ok) throw new Error(call.reason);
    const tech = call.technicianId === d.id ? d : e;
    const own = await asUser(
      tech.userId,
      (tx) => tx`select id, visit_id from turn_calls where id = ${call.callId}`,
    );
    expect(own).toHaveLength(1);
    await expect(
      asUser(
        tech.userId,
        (tx) => tx`select queue_snapshot from turn_calls where id = ${call.callId}`,
      ),
    ).rejects.toThrow(/permission denied/);
    await settle(visitId);
  });

  it('a manager at another location cannot read this location’s clients', async () => {
    const asB = await asUser(managerB.userId, (tx) => tx`select id from clients`);
    expect(asB).toHaveLength(0);
  });
});

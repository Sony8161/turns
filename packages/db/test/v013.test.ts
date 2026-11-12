// v0.13.0 (Duong, 2026-11-12): a technician's settings screen (status, points,
// skills and restrictions) for owners, managers and receptionists, with the
// owner's switch for receptionists; rule templates and the preview; client
// first and last names and search. Technicians can do none of it, through the
// app or straight against the database.
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clientDetail,
  nameParts,
  parseClientQuery,
  searchClients,
  searchKey,
  shortName,
  updateClient,
} from '../src/clients';
import { callNext, createWalkIn, finishVisit, respondToCall } from '../src/engine';
import { saveProfile } from '../src/profile';
import { activeRules, previewBoard, templateConfig, validateRuleConfig } from '../src/rules';
import { HEAVENLY, HEAVENLY_RULE_CONFIG_V1, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import type { StaffActor } from '../src/staff';
import { checkIn, transition } from '../src/status';
import {
  mayEditTechnicians,
  receptionistMayEdit,
  setReceptionistEdits,
  staffAdjustPoints,
  staffSetStatus,
} from '../src/tech-settings';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
let owner: StaffActor;
let manager: StaffActor;
let desk: StaffActor;
let techActor: StaffActor;
let lan: { id: string; userId: string };
let binh: { id: string; userId: string };
let manicure: string;

async function person(name: string, role: string): Promise<string> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${role}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${LOC}, ${role})`;
  return userId;
}

async function tech(name: string) {
  const userId = await person(name, 'technician');
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${userId}, ${ORG}, ${LOC}, ${name}) returning id`;
  return { id: t!.id, userId };
}

const actorOf = (userId: string, role: StaffActor['role']): StaffActor => ({
  userId,
  role,
  organizationId: ORG,
  locationId: LOC,
});

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
  owner = actorOf(await person('Phu', 'owner'), 'owner');
  manager = actorOf(await person('Vy', 'manager'), 'manager');
  desk = actorOf(await person('Hạnh', 'receptionist'), 'receptionist');
  lan = await tech('Lan');
  binh = await tech('Bình');
  techActor = actorOf(lan.userId, 'technician');
  const [s] = await sql<{ id: string }[]>`select id from services where name = 'Basic manicure'`;
  manicure = s!.id;
  for (const t of [lan, binh]) {
    await checkIn(db, { technicianId: t.id, actor: { userId: t.userId }, position: null });
    await transition(db, { technicianId: t.id, to: 'available', actor: { userId: t.userId } });
  }
}, 60_000);

afterAll(async () => {
  await db?.$client.end();
  await sql.end();
});

describe('technician settings: who may', () => {
  it('owners and managers always; receptionists by default; technicians never', async () => {
    expect(await receptionistMayEdit(db, LOC)).toBe(true);
    expect(await mayEditTechnicians(db, owner)).toBe(true);
    expect(await mayEditTechnicians(db, manager)).toBe(true);
    expect(await mayEditTechnicians(db, desk)).toBe(true);
    expect(await mayEditTechnicians(db, techActor)).toBe(false);
  });

  it('the receptionist changes status and points; both are audited with who', async () => {
    const r = await staffSetStatus(db, { actor: desk, technicianId: binh.id, to: 'break' });
    expect(r.ok).toBe(true);
    const back = await staffSetStatus(db, { actor: desk, technicianId: binh.id, to: 'available' });
    expect(back.ok).toBe(true);
    const adj = await staffAdjustPoints(db, {
      actor: desk,
      technicianId: binh.id,
      delta: 0.5,
      reason: 'came in to help early',
    });
    expect(adj.ok).toBe(true);
    const audit =
      await sql`select action, actor_user_id, before, after from audit_log where entity_id = ${binh.id} or (action = 'points_adjusted') order by at`;
    expect(audit.filter((a) => a.action === 'break')[0]!.actor_user_id).toBe(desk.userId);
    const adjusted = audit.find((a) => a.action === 'points_adjusted')!;
    expect(adjusted.actor_user_id).toBe(desk.userId);
    expect(adjusted.before).toMatchObject({ points: 0 });
    expect(adjusted.after).toMatchObject({ points: 0.5, delta: 0.5 });
  });

  it('a points adjustment needs a reason', async () => {
    const r = await staffAdjustPoints(db, {
      actor: desk,
      technicianId: binh.id,
      delta: 1,
      reason: ' ',
    });
    expect(r).toMatchObject({ ok: false, reason: 'reason_required' });
  });

  it('the receptionist edits skills and restrictions; a technician cannot', async () => {
    const profile = {
      skillCategoryIds: null,
      tags: ['gel'],
      restrictions: [{ type: 'no_kids' as const, value: null, note: null }],
    };
    expect((await saveProfile(db, { actor: desk, technicianId: lan.id, profile })).ok).toBe(true);
    expect(await saveProfile(db, { actor: techActor, technicianId: lan.id, profile })).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect(
      await staffSetStatus(db, { actor: techActor, technicianId: binh.id, to: 'break' }),
    ).toEqual({ ok: false, reason: 'not_allowed' });
    expect(
      await staffAdjustPoints(db, {
        actor: techActor,
        technicianId: binh.id,
        delta: -1,
        reason: 'x',
      }),
    ).toEqual({ ok: false, reason: 'not_allowed' });
  });

  it('only the owner switches receptionist edits; off stops the receptionist, not the manager', async () => {
    expect(await setReceptionistEdits(db, { actor: manager, on: false })).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect((await setReceptionistEdits(db, { actor: owner, on: false })).ok).toBe(true);
    expect(await mayEditTechnicians(db, desk)).toBe(false);
    expect(await mayEditTechnicians(db, manager)).toBe(true);
    expect(await staffSetStatus(db, { actor: desk, technicianId: binh.id, to: 'break' })).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    const [a] =
      await sql`select before, after from audit_log where action = 'technician_edits_setting'`;
    expect(a!.before).toEqual({ receptionistEditsTechnicians: true });
    expect(a!.after).toEqual({ receptionistEditsTechnicians: false });
    await setReceptionistEdits(db, { actor: owner, on: true });
  });

  it('the database refuses a technician writing points, skills, status or the setting (RLS)', async () => {
    const tries = [
      (tx: TransactionSql) =>
        tx`insert into turn_ledger (organization_id, location_id, technician_id, shift_id, delta, reason_type) select ${ORG}, ${LOC}, ${lan.id}, shift_id, 5, 'manual' from technician_status where technician_id = ${lan.id}`,
      (tx: TransactionSql) =>
        tx`insert into technician_tags (organization_id, location_id, technician_id, tag) values (${ORG}, ${LOC}, ${lan.id}, 'boss')`,
      (tx: TransactionSql) =>
        tx`update technician_status set status = 'break' where technician_id = ${binh.id}`,
      (tx: TransactionSql) =>
        tx`update locations set receptionist_edits_technicians = false where id = ${LOC}`,
      (tx: TransactionSql) => tx`update clients set first_name = 'x'`,
    ];
    for (const attempt of tries) {
      await expect(asUser(lan.userId, attempt)).rejects.toThrow(/permission denied/);
    }
  });
});

describe('client names and search', () => {
  it('splits, joins and shortens names', () => {
    expect(nameParts({ name: '  Lan   Nguyen Thi ' })).toEqual({
      firstName: 'Lan',
      lastName: 'Nguyen Thi',
    });
    expect(nameParts({ firstName: 'Ngọc', lastName: '' })).toEqual({
      firstName: 'Ngọc',
      lastName: null,
    });
    expect(shortName('Lan', 'nguyen')).toBe('Lan N.');
    expect(shortName('Lan', null)).toBe('Lan');
    expect(shortName(null, 'Le')).toBe('L.');
    expect(searchKey('Đỗ Thị Ngọc')).toBe('do thi ngoc');
  });

  it('reads a query as a phone or a name', () => {
    expect(parseClientQuery('(813) 555-0201')).toEqual({ phone: '8135550201' });
    expect(parseClientQuery('1-813-555-0201')).toEqual({ phone: '8135550201' });
    expect(parseClientQuery('0201')).toEqual({ phone: '0201' });
    expect(parseClientQuery('Ngọc')).toEqual({ name: 'ngoc' });
    expect(parseClientQuery('a')).toBeNull();
    expect(parseClientQuery('12')).toBeNull();
  });

  it('a walk-in keeps first and last name; search finds by phone digits and by name without accents', async () => {
    const r = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      actor: { userId: desk.userId },
      client: { firstName: 'Ngọc', lastName: 'Võ', phone: '813-555-0204' },
    });
    expect(r.ok).toBe(true);
    await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      actor: { userId: desk.userId },
      client: { name: 'Lan Nguyen', phone: '(813) 555-0201' },
    });
    const [row] =
      await sql`select first_name, last_name, name, search_name from clients where phone = '+18135550204'`;
    expect(row).toEqual({
      first_name: 'Ngọc',
      last_name: 'Võ',
      name: 'Ngọc Võ',
      search_name: 'ngoc vo',
    });
    expect(
      (await searchClients(db, { locationId: LOC, query: '555 0204' })).map((h) => h.firstName),
    ).toEqual(['Ngọc']);
    expect(
      (await searchClients(db, { locationId: LOC, query: 'ngoc' })).map((h) => h.lastName),
    ).toEqual(['Võ']);
    expect(
      (await searchClients(db, { locationId: LOC, query: 'vo' })).map((h) => h.firstName),
    ).toEqual(['Ngọc']);
    expect(
      (await searchClients(db, { locationId: LOC, query: 'NGUYEN' })).map((h) => h.firstName),
    ).toEqual(['Lan']);
    expect(await searchClients(db, { locationId: LOC, query: '%' })).toEqual([]);
    expect(await searchClients(db, { locationId: randomUUID(), query: 'ngoc' })).toEqual([]);
    // RLS: a technician reads no client rows at all.
    expect((await asUser(lan.userId, (tx) => tx`select id from clients`)).length).toBe(0);
    const [n] = await sql`select count(*)::int as n from clients`;
    expect(n!.n).toBe(2);
  });

  it('client detail counts visits and the usual technician; the desk edits names and notes, audited without the values', async () => {
    const [c] = await sql<{ id: string }[]>`select id from clients where phone = '+18135550201'`;
    const [v] = await sql<{ id: string }[]>`select id from visits where client_id = ${c!.id}`;
    const call = await callNext(db, {
      visitId: v!.id,
      actor: { userId: desk.userId },
      locationId: LOC,
    });
    expect(call.ok).toBe(true);
    if (!call.ok) return;
    await respondToCall(db, {
      callId: call.callId,
      technicianId: call.technicianId,
      response: 'accepted',
      actor: { userId: null },
    });
    await finishVisit(db, { technicianId: call.technicianId, actor: { userId: null } });
    const d = await clientDetail(db, LOC, c!.id);
    expect(d).toMatchObject({ firstName: 'Lan', lastName: 'Nguyen', visitCount: 1 });
    expect(d!.usualTechnician).not.toBeNull();
    expect(d!.recent[0]!.services).toEqual(['Basic manicure']);
    expect(await clientDetail(db, randomUUID(), c!.id)).toBeNull();

    const u = await updateClient(db, {
      actor: { userId: desk.userId, organizationId: ORG, locationId: LOC },
      clientId: c!.id,
      firstName: 'Lân',
      lastName: 'Nguyễn',
      notes: 'likes nude pink',
    });
    expect(u.ok).toBe(true);
    const [after] = await sql`select name, search_name, notes from clients where id = ${c!.id}`;
    expect(after).toEqual({
      name: 'Lân Nguyễn',
      search_name: 'lan nguyen',
      notes: 'likes nude pink',
    });
    const [audit] = await sql`select after from audit_log where action = 'client_updated'`;
    expect(audit!.after).toEqual({ changed: ['firstName', 'lastName', 'notes'] });
    expect(JSON.stringify(audit)).not.toContain('nude');
    expect(
      await updateClient(db, {
        actor: { userId: desk.userId, organizationId: ORG, locationId: LOC },
        clientId: c!.id,
        firstName: ' ',
        lastName: '',
        notes: null,
      }),
    ).toEqual({ ok: false, reason: 'name_required' });
  });
});

describe('rule templates and the preview', () => {
  it('standard is the Heavenly rules; simple rotation is one turn a service, no appointment discount', async () => {
    const base = await activeRules(db, LOC);
    // v0.16.0: the salon's own service points (by_service) are kept by the template.
    expect(templateConfig('standard', base)).toEqual({
      ...HEAVENLY_RULE_CONFIG_V1,
      points: { ...HEAVENLY_RULE_CONFIG_V1.points, by_service: base.points.by_service },
    });
    const simple = templateConfig('simple_rotation', base);
    expect(validateRuleConfig(simple).ok).toBe(true);
    expect(simple.points).toMatchObject({
      default_service: 1,
      fill_or_full_set: 1,
      appointment_discount: 0,
      combined_fill_full_cap: null,
    });
    expect(simple.queue.sort).toEqual(['points_asc', 'check_in_asc']);
    expect(simple.attention).toEqual(base.attention);
  });

  it('an excused deny stays cancelled in the preview whatever the deny penalty', async () => {
    const base = await activeRules(db, LOC);
    const r = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [manicure],
      actor: { userId: desk.userId },
    });
    if (!r.ok) throw new Error('walk-in');
    const call = await callNext(db, {
      visitId: r.visitId,
      actor: { userId: desk.userId },
      locationId: LOC,
    });
    if (!call.ok) throw new Error('call');
    await respondToCall(db, {
      callId: call.callId,
      technicianId: call.technicianId,
      response: 'denied',
      // A reason that costs the penalty (break and personal excuse themselves, v0.15.0).
      denyReason: 'other',
      actor: { userId: null },
    });
    const [deny] = await sql<
      { id: string }[]
    >`select id from turn_ledger where reason_type = 'deny'`;
    const { excusePenalty } = await import('../src/engine');
    const ex = await excusePenalty(db, {
      ledgerId: deny!.id,
      actor: { userId: owner.userId, organizationId: ORG, locationId: LOC },
      reason: 'break',
    });
    expect(ex.ok).toBe(true);
    const harsher = structuredClone(base);
    harsher.penalties.deny = 2;
    const rows = await previewBoard(db, LOC, harsher);
    const who = rows.find((x) => x.technicianId === call.technicianId)!;
    expect(who.previewPoints).toBe(who.points);
  });
});

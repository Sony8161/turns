// Done-when (Part 9, customer kiosk): an owner or manager pairs an iPad with a
// one-time code; only hashes are stored; revoking stops the token at once; a
// check-in makes a waiting visit the desk must confirm before any call (the
// engine and a trigger both refuse); the answer never says whether the phone
// is on file; every step is audited without the customer's name or phone; no
// app role can read the kiosk table (threat model T7, T12, T20, T25).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callNext, type ManagerActor } from '../src/engine';
import {
  checkKioskPin,
  cleanKioskName,
  createKioskDevice,
  kioskCheckIn,
  kioskFromToken,
  kioskMenu,
  listKiosks,
  newPairingCode,
  pairKiosk,
  reviewKioskVisit,
  revokeKiosk,
  type KioskDevice,
} from '../src/kiosk';
import { addLocation } from '../src/locations';
import { HEAVENLY, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import { checkIn, transition } from '../src/status';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
let LOC2: string;
let manager: ManagerActor;
let manager2: ManagerActor;
let ownerId: string;
let deskId: string;
let manicure: string;
let pedicure: string;
let techId: string;
let techUser: string;
let device: KioskDevice;
let token: string;

async function person(name: string, role: string, locationId: string): Promise<string> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${name}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${locationId}, ${role})`;
  return userId;
}

async function asUser(userId: string, query: string) {
  return sql
    .begin(async (tx) => {
      await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`;
      await tx.unsafe('set local role authenticated');
      return tx.unsafe(query);
    })
    .catch((e: { code?: string }) => e);
}

async function paired(
  actor: ManagerActor,
  name = 'Front iPad',
): Promise<{ device: KioskDevice; token: string }> {
  const made = await createKioskDevice(db, { actor, name, pin: '2468' });
  if (!made.ok) throw new Error(made.reason);
  const p = await pairKiosk(db, { code: made.pairingCode });
  if (!p.ok) throw new Error(p.reason);
  return { device: p.device, token: p.token };
}

beforeAll(async () => {
  await resetAndMigrate();
  await seedHeavenly(TEST_URL);
  db = createDb(TEST_URL);
  const second = await addLocation(db, { organizationId: ORG, name: 'Heavenly Nails second' });
  if (!second.ok) throw new Error(second.reason);
  LOC2 = second.locationId;
  ownerId = await person('Phu', 'owner', LOC);
  deskId = await person('Hanh', 'receptionist', LOC);
  manager = { userId: await person('Mai', 'manager', LOC), organizationId: ORG, locationId: LOC };
  manager2 = {
    userId: await person('Kim', 'manager', LOC2),
    organizationId: ORG,
    locationId: LOC2,
  };
  techUser = await person('An', 'technician', LOC);
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${techUser}, ${ORG}, ${LOC}, 'An') returning id`;
  techId = t!.id;
  const byName = async (name: string) => {
    const [r] = await sql<
      { id: string }[]
    >`select id from services where location_id = ${LOC} and name = ${name}`;
    return r!.id;
  };
  manicure = await byName('Basic manicure');
  const [p] = await sql<
    { id: string }[]
  >`select id from services where location_id = ${LOC} and id <> ${manicure} and archived_at is null limit 1`;
  pedicure = p!.id;
  ({ device, token } = await paired(manager));
});

afterAll(async () => {
  await db?.$client.end();
  await sql.end();
});

describe('pairing', () => {
  it('stores only hashes: no code, token or PIN in the table', async () => {
    const made = await createKioskDevice(db, { actor: manager, name: 'Spare iPad', pin: '1357' });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const p = await pairKiosk(db, { code: made.pairingCode });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const [row] = await sql`select * from kiosk_devices where id = ${made.deviceId}`;
    const text = JSON.stringify(row);
    expect(text).not.toContain(made.pairingCode.replace('-', ''));
    expect(text).not.toContain(p.token);
    expect(text).not.toContain('1357');
    expect(row!.pin_hash).toMatch(/^scrypt\$/);
  });

  it('a code works once, and not after it expires', async () => {
    const made = await createKioskDevice(db, { actor: manager, name: 'Once', pin: '1111' });
    if (!made.ok) throw new Error(made.reason);
    expect((await pairKiosk(db, { code: made.pairingCode.toLowerCase() })).ok).toBe(true);
    expect(await pairKiosk(db, { code: made.pairingCode })).toEqual({
      ok: false,
      reason: 'bad_code',
    });
    const late = await createKioskDevice(db, { actor: manager, name: 'Late', pin: '1111' });
    if (!late.ok) throw new Error(late.reason);
    expect(
      await pairKiosk(db, { code: late.pairingCode, now: new Date(Date.now() + 16 * 60_000) }),
    ).toEqual({ ok: false, reason: 'bad_code' });
  });

  it('refuses a bad PIN or an empty name', async () => {
    expect(await createKioskDevice(db, { actor: manager, name: 'x', pin: '12a4' })).toEqual({
      ok: false,
      reason: 'bad_pin',
    });
    expect(await createKioskDevice(db, { actor: manager, name: '   ', pin: '1234' })).toEqual({
      ok: false,
      reason: 'bad_name',
    });
  });

  it('a new pairing code moves the kiosk to a new iPad; the old token stops', async () => {
    const k = await paired(manager, 'Moving');
    const again = await newPairingCode(db, { actor: manager, deviceId: k.device.deviceId });
    if (!again.ok) throw new Error(again.reason);
    expect(await kioskFromToken(db, k.token)).not.toBeNull();
    const p = await pairKiosk(db, { code: again.pairingCode });
    expect(p.ok).toBe(true);
    expect(await kioskFromToken(db, k.token)).toBeNull();
    if (p.ok) expect((await kioskFromToken(db, p.token))?.deviceId).toBe(k.device.deviceId);
  });

  it('revoke stops the token at once; another location cannot revoke it', async () => {
    const k = await paired(manager, 'To revoke');
    expect(await revokeKiosk(db, { actor: manager2, deviceId: k.device.deviceId })).toEqual({
      ok: false,
      reason: 'unknown_device',
    });
    expect(await kioskFromToken(db, k.token)).not.toBeNull();
    expect(await revokeKiosk(db, { actor: manager, deviceId: k.device.deviceId })).toEqual({
      ok: true,
    });
    expect(await kioskFromToken(db, k.token)).toBeNull();
    expect(await newPairingCode(db, { actor: manager, deviceId: k.device.deviceId })).toEqual({
      ok: false,
      reason: 'unknown_device',
    });
    const list = await listKiosks(db, LOC);
    const row = list.find((r) => r.id === k.device.deviceId)!;
    expect(row.revokedAt).not.toBeNull();
    expect(JSON.stringify(list)).not.toMatch(/hash/i);
    // Working iPads first, revoked ones below.
    const firstRevoked = list.findIndex((r) => r.revokedAt !== null);
    expect(list.slice(firstRevoked).every((r) => r.revokedAt !== null)).toBe(true);
    expect((await listKiosks(db, LOC2)).some((r) => r.id === k.device.deviceId)).toBe(false);
  });

  it('unknown or junk tokens find nothing', async () => {
    expect(await kioskFromToken(db, '')).toBeNull();
    expect(await kioskFromToken(db, 'not-a-token')).toBeNull();
    expect(await kioskFromToken(db, 'x'.repeat(5000))).toBeNull();
  });

  it('every pairing step is audited', async () => {
    const rows = await sql<
      { action: string }[]
    >`select action from audit_log where entity_type = 'kiosk_devices' and entity_id = ${device.deviceId} order by at`;
    expect(rows.map((r) => r.action)).toEqual(['kiosk_created', 'kiosk_paired']);
  });
});

describe('PIN', () => {
  it('unlocks with the right PIN only, and audits every try', async () => {
    expect(await checkKioskPin(db, device, '0000')).toBe(false);
    expect(await checkKioskPin(db, device, '24680')).toBe(false);
    expect(await checkKioskPin(db, device, '2468')).toBe(true);
    const rows = await sql<
      { action: string }[]
    >`select action from audit_log where entity_id = ${device.deviceId} and action like 'kiosk_%' and action not in ('kiosk_created','kiosk_paired') order by at`;
    expect(rows.map((r) => r.action)).toEqual([
      'kiosk_pin_failed',
      'kiosk_pin_failed',
      'kiosk_unlocked',
    ]);
  });
});

describe('check-in', () => {
  it('cleans the typed name', () => {
    expect(cleanKioskName('  Lan \u0000 Nguyen\u202e ')).toBe('Lan Nguyen');
    expect(cleanKioskName('\u200b ')).toBeNull();
    expect(cleanKioskName(42)).toBeNull();
    expect(cleanKioskName('a'.repeat(100))!.length).toBe(40);
  });

  it('the menu has services and names only, from its own location', async () => {
    const m = await kioskMenu(db, device);
    expect(m.services.length).toBeGreaterThan(0);
    expect(m.technicians.map((t) => t.name)).toEqual(['An']);
    expect(Object.keys(m.technicians[0]!).sort()).toEqual(['id', 'name']);
  });

  it('makes a waiting visit that needs the desk, audited without name or phone', async () => {
    const r = await kioskCheckIn(db, {
      device,
      name: 'Lan',
      phone: '(813) 555-0142',
      serviceIds: [manicure],
      attributes: { gender: 'female', isKid: false, age: null },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [v] = await sql<
      {
        source: string;
        status: string;
        needs_confirm: boolean;
        kiosk_name: string;
        kiosk_device_id: string;
        created_by: string | null;
      }[]
    >`select source, status, needs_confirm, kiosk_name, kiosk_device_id, created_by from visits where id = ${r.visitIds[0]!}`;
    expect(v).toEqual({
      source: 'self_checkin',
      status: 'waiting',
      needs_confirm: true,
      kiosk_name: 'Lan',
      kiosk_device_id: device.deviceId,
      created_by: null,
    });
    const audit = await sql<
      { action: string; after: unknown }[]
    >`select action, after from audit_log where entity_id = ${r.visitIds[0]!}`;
    expect(audit.map((a) => a.action)).toEqual(['kiosk_check_in']);
    const text = JSON.stringify(audit);
    expect(text).not.toContain('Lan');
    expect(text).not.toContain('555');
    expect(text).toContain(device.deviceId);
  });

  it('answers the same for a known phone and never overwrites the stored name', async () => {
    await sql`insert into clients (organization_id, location_id, name, phone) values (${ORG}, ${LOC}, 'Thu Tran', '+18135550177')`;
    const known = await kioskCheckIn(db, {
      device,
      name: 'Someone Else',
      phone: '813-555-0177',
      serviceIds: [manicure],
    });
    const fresh = await kioskCheckIn(db, {
      device,
      name: 'New Person',
      phone: '813-555-0188',
      serviceIds: [manicure],
    });
    expect(known.ok && fresh.ok).toBe(true);
    if (!known.ok || !fresh.ok) return;
    expect(Object.keys(known).sort()).toEqual(Object.keys(fresh).sort());
    expect(known.visitIds).toHaveLength(1);
    const [c] = await sql<
      { name: string }[]
    >`select name from clients where phone = '+18135550177'`;
    expect(c!.name).toBe('Thu Tran');
  });

  it('a name with no phone makes no client row', async () => {
    const [before] = await sql<{ n: number }[]>`select count(*)::int as n from clients`;
    const r = await kioskCheckIn(db, { device, name: 'Walk', serviceIds: [manicure] });
    expect(r.ok).toBe(true);
    const [after] = await sql<{ n: number }[]>`select count(*)::int as n from clients`;
    expect(after!.n).toBe(before!.n);
  });

  it('refuses bad input with plain reasons', async () => {
    expect(await kioskCheckIn(db, { device, name: ' ', serviceIds: [manicure] })).toEqual({
      ok: false,
      reason: 'bad_name',
    });
    expect(await kioskCheckIn(db, { device, name: 'A', serviceIds: [] })).toEqual({
      ok: false,
      reason: 'no_services',
    });
    expect(
      await kioskCheckIn(db, { device, name: 'A', phone: '12', serviceIds: [manicure] }),
    ).toEqual({ ok: false, reason: 'bad_phone' });
    expect(await kioskCheckIn(db, { device, name: 'A', serviceIds: [randomUUID()] })).toEqual({
      ok: false,
      reason: 'unknown_service',
    });
    expect(
      await kioskCheckIn(db, {
        device,
        name: 'A',
        serviceIds: [manicure],
        requestedTechnicianId: randomUUID(),
      }),
    ).toEqual({ ok: false, reason: 'unknown_technician' });
  });

  it("cannot use another location's menu", async () => {
    const [s2] = await sql<
      { id: string }[]
    >`select id from services where location_id = ${LOC2} limit 1`;
    if (!s2) return;
    expect(await kioskCheckIn(db, { device, name: 'A', serviceIds: [s2.id] })).toEqual({
      ok: false,
      reason: 'unknown_service',
    });
  });
});

describe('desk confirm', () => {
  it('nobody is called until the desk confirms; then the engine calls', async () => {
    await checkIn(db, { technicianId: techId, actor: { userId: techUser }, position: null });
    await transition(db, { technicianId: techId, to: 'available', actor: { userId: techUser } });
    const r = await kioskCheckIn(db, { device, name: 'Hoa', serviceIds: [manicure] });
    if (!r.ok) throw new Error(r.reason);
    const visitId = r.visitIds[0]!;
    expect(
      await callNext(db, { visitId, actor: { userId: deskId }, locationId: LOC }),
    ).toMatchObject({ ok: false, reason: 'needs_confirm' });
    // The database refuses too, whatever the app does.
    const err =
      await sql`insert into turn_calls (organization_id, location_id, visit_id, technician_id, queue_snapshot) values (${ORG}, ${LOC}, ${visitId}, ${techId}, '[]'::jsonb)`.catch(
        (e: Error) => e,
      );
    expect(String(err)).toMatch(/confirm/);
    expect(await reviewKioskVisit(db, { actor: manager2, visitId, decision: 'confirm' })).toEqual({
      ok: false,
      reason: 'wrong_location',
    });
    const desk: ManagerActor = { userId: deskId, organizationId: ORG, locationId: LOC };
    expect(await reviewKioskVisit(db, { actor: desk, visitId, decision: 'confirm' })).toEqual({
      ok: true,
      visitIds: [visitId],
    });
    expect(await reviewKioskVisit(db, { actor: desk, visitId, decision: 'confirm' })).toEqual({
      ok: false,
      reason: 'not_pending',
    });
    const called = await callNext(db, { visitId, actor: { userId: deskId }, locationId: LOC });
    expect(called.ok).toBe(true);
    const [v] = await sql<
      { confirmed_by: string }[]
    >`select confirmed_by from visits where id = ${visitId}`;
    expect(v!.confirmed_by).toBe(deskId);
  });

  it('decline cancels both visits of a same-time pair', async () => {
    const r = await kioskCheckIn(db, {
      device,
      name: 'Pair',
      serviceIds: [manicure, pedicure],
      sameTime: true,
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.visitIds).toHaveLength(2);
    const desk: ManagerActor = { userId: deskId, organizationId: ORG, locationId: LOC };
    const d = await reviewKioskVisit(db, {
      actor: desk,
      visitId: r.visitIds[1]!,
      decision: 'decline',
    });
    expect(d.ok && d.visitIds.sort()).toEqual([...r.visitIds].sort());
    const rows = await sql<
      { status: string; needs_confirm: boolean }[]
    >`select status, needs_confirm from visits where id in ${sql(r.visitIds)}`;
    expect(rows.every((x) => x.status === 'cancelled' && !x.needs_confirm)).toBe(true);
    const audit = await sql<
      { action: string }[]
    >`select action from audit_log where entity_id in ${sql(r.visitIds)} and action = 'kiosk_declined'`;
    expect(audit).toHaveLength(2);
  });

  it('a walk-in from the desk does not wait for a confirm', async () => {
    const [v] = await sql<
      { n: number }[]
    >`select count(*)::int as n from visits where kiosk_device_id is null and needs_confirm`;
    expect(v!.n).toBe(0);
    const err =
      await sql`insert into visits (organization_id, location_id, needs_confirm) values (${ORG}, ${LOC}, true)`.catch(
        (e: Error) => e,
      );
    expect(String(err)).toMatch(/visits_confirm_needs_kiosk/);
  });

  it('a kiosk visit cannot point at another location (trigger)', async () => {
    const err =
      await sql`insert into visits (organization_id, location_id, kiosk_device_id, needs_confirm) values (${ORG}, ${LOC2}, ${device.deviceId}, true)`.catch(
        (e: Error) => e,
      );
    expect(String(err)).toMatch(/another location/);
  });
});

describe('row-level security', () => {
  it('no app role can read kiosk_devices, not even the owner (T25)', async () => {
    for (const userId of [ownerId, manager.userId!, deskId, techUser]) {
      const err = await asUser(userId, 'select token_hash from kiosk_devices');
      expect((err as { code?: string }).code).toBe('42501');
    }
    const anon = await sql
      .begin(async (tx) => {
        await tx.unsafe('set local role anon');
        return tx.unsafe('select id from kiosk_devices');
      })
      .catch((e: { code?: string }) => e);
    expect((anon as { code?: string }).code).toBe('42501');
  });

  it("a receptionist reads the kiosk name only at their own location's visits", async () => {
    const kim = await person('Kim2', 'receptionist', LOC2);
    const rows = (await asUser(kim, 'select kiosk_name from visits')) as unknown[];
    expect(Array.isArray(rows) ? rows.length : -1).toBe(0);
    const own = (await asUser(
      deskId,
      'select kiosk_name from visits where kiosk_name is not null',
    )) as unknown[];
    expect(Array.isArray(own) ? own.length : -1).toBeGreaterThan(0);
  });

  it('a technician cannot read the visits with kiosk names', async () => {
    const rows = (await asUser(
      techUser,
      'select kiosk_name from visits where kiosk_name is not null',
    )) as unknown[];
    expect(Array.isArray(rows) ? rows.length : -1).toBe(0);
  });
});

// v0.16.1 "Fixes from demo filming" (Duong, 2026-11-12): the audit log reads
// like a person wrote it. Names instead of ids, before → after where something
// changed, no raw ids; the client of a visit is "First L." only on the viewer
// (clients.visitLabels), never inside an AuditRow, so the CSV keeps its ids.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { visitLabels } from '../src/clients';
import { adjustPoints, callNext, createWalkIn } from '../src/engine';
import { auditEntries, localDate, readableParts, type AuditRow } from '../src/reports';
import { HEAVENLY, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import { checkIn, transition } from '../src/status';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
const TZ = 'America/New_York';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
let rows: AuditRow[];
let visitId: string;
let linh: { id: string; userId: string };
let manicure: { id: string; name: string };

async function newUser(name: string, role: string): Promise<string> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${role}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${LOC}, ${role}::role)`;
  return userId;
}

beforeAll(async () => {
  await resetAndMigrate();
  await seedHeavenly(TEST_URL);
  db = createDb(TEST_URL);
  const [s] = await sql<
    { id: string; name: string }[]
  >`select id, name from services where location_id = ${LOC} order by name limit 1`;
  manicure = s!;
  const userId = await newUser('Linh', 'technician');
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${userId}, ${ORG}, ${LOC}, 'Linh') returning id`;
  linh = { id: t!.id, userId };
  await checkIn(db, { technicianId: linh.id, actor: { userId }, position: null });
  await transition(db, { technicianId: linh.id, to: 'available', actor: { userId } });

  const v = await createWalkIn(db, {
    organizationId: ORG,
    locationId: LOC,
    serviceIds: [manicure.id],
    client: { firstName: 'Jenny', lastName: 'Kim', phone: '813 555 0177' },
    actor: { userId: null },
  });
  if (!v.ok) throw new Error(v.reason);
  visitId = v.visitId;
  const called = await callNext(db, { visitId, actor: { userId: null }, locationId: LOC });
  if (!called.ok) throw new Error(`call: ${called.reason}`);

  const managerId = await newUser('Vy', 'manager');
  const adj = await adjustPoints(db, {
    technicianId: linh.id,
    delta: 1,
    reason: 'test',
    actor: { userId: managerId, organizationId: ORG, locationId: LOC },
  });
  if (!adj.ok) throw new Error(`adjust: ${adj.reason}`);

  const today = localDate(new Date(), TZ);
  rows = await auditEntries(db, { locationId: LOC, from: today, to: today });
});

afterAll(async () => {
  await sql.end();
});

describe('readable details in the audit viewer', () => {
  it('a call names the client visit by reference and never shows a raw id', () => {
    const sent = rows.find((r) => r.action === 'call_sent')!;
    expect(sent.readable).toContainEqual({ key: 'visit', value: { kind: 'visit', id: visitId } });
    // The only id left is the visit reference the viewer resolves.
    const shown = JSON.stringify(sent.readable.filter((p) => p.value.kind !== 'visit'));
    expect(shown).not.toMatch(UUID);
    // The CSV fields keep their ids, as before.
    expect(sent.fields.map(([k]) => k)).toContain('visit');
  });

  it('the walk-in shows its services by name and the client only on the viewer', async () => {
    const created = rows.find((r) => r.action === 'visit_created')!;
    expect(created.readable).toContainEqual({
      key: 'services',
      value: { kind: 'services', names: [manicure.name] },
    });
    expect(JSON.stringify(rows)).not.toContain('Jenny');
    const labels = await visitLabels(db, LOC, [visitId]);
    expect(labels.get(visitId)).toEqual({ client: 'Jenny K.', services: [manicure.name] });
  });

  it('a points adjustment reads before → after', () => {
    const adj = rows.find((r) => r.action === 'points_adjusted')!;
    const points = adj.readable.find((p) => p.key === 'points')!;
    expect(points.was).toEqual({ kind: 'points', n: 0 });
    expect(points.value).toEqual({ kind: 'points', n: 1 });
    expect(adj.readable).toContainEqual({
      key: 'change',
      value: { kind: 'points', n: 1, signed: true },
    });
  });

  it('a status change reads from → to and leaves plumbing out', () => {
    const ready = rows.find((r) => r.action === 'available')!;
    expect(ready.readable).toContainEqual({
      key: 'status',
      value: { kind: 'code', group: 'status', code: 'available' },
      was: { kind: 'code', group: 'status', code: 'checked_in' },
    });
    expect(JSON.stringify(ready.readable)).not.toMatch(UUID);
  });

  it('a visit from another location is never labelled', async () => {
    const labels = await visitLabels(db, randomUUID(), [visitId]);
    expect(labels.size).toBe(0);
  });
});

describe('readableParts (pure)', () => {
  const refs = {
    people: new Map([
      ['11111111-1111-4111-8111-111111111111', 'Linh'],
      ['22222222-2222-4222-8222-222222222222', 'Mai'],
    ]),
    services: new Map([['33333333-3333-4333-8333-333333333333', 'Gel manicure']]),
  };
  const base = { entityType: 'visits', entityId: null, responseSeconds: null };

  it('a reassign shows the technician change; otherwise the technician is its own column', () => {
    const moved = readableParts(
      {
        ...base,
        action: 'visit_reassigned',
        before: { technicianId: '11111111-1111-4111-8111-111111111111' },
        after: { technicianId: '22222222-2222-4222-8222-222222222222' },
      },
      refs,
    );
    expect(moved).toEqual([
      {
        key: 'technician',
        value: { kind: 'text', text: 'Mai' },
        was: { kind: 'text', text: 'Linh' },
      },
    ]);
    const help = readableParts(
      {
        ...base,
        action: 'help_requested',
        before: null,
        after: { technicianId: '11111111-1111-4111-8111-111111111111', hasReason: true },
      },
      refs,
    );
    expect(help).toEqual([]);
  });

  it('drops unknown ids, nested objects and anything personal', () => {
    const parts = readableParts(
      {
        ...base,
        action: 'kiosk_check_in',
        before: null,
        after: {
          kioskDeviceId: '44444444-4444-4444-8444-444444444444',
          somethingId: '55555555-5555-4555-8555-555555555555',
          clientName: 'Jenny Kim',
          phone: '+18135550177',
          note: 'french tip',
          serviceIds: [
            '33333333-3333-4333-8333-333333333333',
            '66666666-6666-4666-8666-666666666666',
          ],
          requestedTechnicianId: '22222222-2222-4222-8222-222222222222',
          partyId: '77777777-7777-4777-8777-777777777777',
          source: 'self_checkin',
          nested: { a: 1 },
        },
      },
      refs,
    );
    expect(parts).toEqual([
      { key: 'services', value: { kind: 'services', names: ['Gel manicure'] } },
      { key: 'asked_for', value: { kind: 'text', text: 'Mai' } },
      { key: 'group', value: { kind: 'bool', value: true } },
      { key: 'source', value: { kind: 'code', group: 'source', code: 'self_checkin' } },
    ]);
  });
});

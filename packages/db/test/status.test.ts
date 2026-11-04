// Done-when (REQ-09c1e578): every legal and illegal transition has a test; the
// daily total is reproduced from ledger rows only; a technician cannot write
// turn_ledger directly; audit rows cannot be edited through any path.
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HEAVENLY, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import {
  TRANSITIONS,
  checkIn,
  locationStatus,
  postPoints,
  shiftTotal,
  transition,
  type TechnicianState,
} from '../src/status';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
let techId: string;
let techUser: string;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
// Heavenly's seed has no geofence; tests set one when they need it.
const SALON = { lat: 27.95, lng: -82.46 };
const INSIDE = { lat: 27.9501, lng: -82.4601 }; // ~15 m
const OUTSIDE = { lat: 27.96, lng: -82.46 }; // ~1.1 km

async function newTech(name: string): Promise<{ id: string; userId: string }> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${name}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${LOC}, 'technician')`;
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${userId}, ${ORG}, ${LOC}, ${name}) returning id`;
  return { id: t!.id, userId };
}

/** Drive a technician to a given state by legal moves. */
async function driveTo(id: string, userId: string, target: TechnicianState) {
  const actor = { userId };
  await sql`delete from technician_status where technician_id = ${id}`;
  if (target === 'off') return;
  await checkIn(db, { technicianId: id, actor, position: null });
  if (target === 'checked_in') return;
  await transition(db, { technicianId: id, to: 'available', actor });
  if (target === 'available') return;
  await transition(db, { technicianId: id, to: target, actor });
}

/** Run as a Supabase user, the way PostgREST would. */
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
  const t = await newTech('Thảo');
  techId = t.id;
  techUser = t.userId;
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

const STATES: TechnicianState[] = ['off', 'checked_in', 'available', 'in_service', 'break', 'out'];

describe('status machine', () => {
  for (const from of STATES) {
    for (const to of STATES) {
      if (to === from) continue;
      const legal = TRANSITIONS[from].includes(to);
      it(`${from} → ${to} is ${legal ? 'allowed' : 'refused'}`, async () => {
        await driveTo(techId, techUser, from);
        const actor = { userId: techUser };
        const result =
          to === 'checked_in'
            ? await checkIn(db, { technicianId: techId, actor, position: null })
            : await transition(db, { technicianId: techId, to, actor });
        expect(result.ok).toBe(legal);
        if (!legal && !result.ok) {
          expect(result).toMatchObject({ reason: 'illegal_transition', from, to });
        }
        const [row] = await sql<
          { status: string }[]
        >`select status from technician_status where technician_id = ${techId}`;
        expect(row?.status ?? 'off').toBe(legal ? to : from);
      });
    }
  }

  it('writes an audit row for every move, with before and after', async () => {
    await driveTo(techId, techUser, 'break');
    const rows = await sql<
      { action: string; before: unknown; after: unknown; actor_user_id: string }[]
    >`select action, before, after, actor_user_id from audit_log
      where entity_id = ${techId} order by at desc limit 3`;
    expect(rows.map((r) => r.action)).toEqual(['break', 'available', 'check_in']);
    expect(rows[0]).toMatchObject({
      before: { status: 'available' },
      after: { status: 'break', expectedBackAt: null },
      actor_user_id: techUser,
    });
  });

  it('records the readiness checklist time and the check-out time on the shift', async () => {
    await driveTo(techId, techUser, 'available');
    await transition(db, { technicianId: techId, to: 'off', actor: { userId: techUser } });
    const [shift] = await sql<
      { ready_at: Date | null; checked_out_at: Date | null }[]
    >`select ready_at, checked_out_at from shifts where technician_id = ${techId}`;
    expect(shift?.ready_at).toBeTruthy();
    expect(shift?.checked_out_at).toBeTruthy();
  });
});

describe('check-in geofence (server-side, from the location row and rule_config)', () => {
  beforeAll(async () => {
    await sql`update locations set geofence_lat = ${SALON.lat}, geofence_lng = ${SALON.lng}, geofence_radius_m = 100 where id = ${LOC}`;
  });
  afterAll(async () => {
    await sql`update locations set geofence_lat = null, geofence_lng = null, geofence_radius_m = null where id = ${LOC}`;
  });

  it('accepts a position inside the fence and records the distance', async () => {
    await driveTo(techId, techUser, 'off');
    const r = await checkIn(db, {
      technicianId: techId,
      actor: { userId: techUser },
      position: INSIDE,
    });
    expect(r.ok).toBe(true);
    const [a] = await sql<
      { after: { geofence: { passed: boolean; distanceM: number } } }[]
    >`select after from audit_log where entity_id = ${techId} and action = 'check_in' order by at desc limit 1`;
    expect(a?.after.geofence.passed).toBe(true);
    expect(a?.after.geofence.distanceM).toBeLessThan(100);
  });

  it('refuses a position outside the fence and a missing position', async () => {
    await driveTo(techId, techUser, 'off');
    const far = await checkIn(db, {
      technicianId: techId,
      actor: { userId: techUser },
      position: OUTSIDE,
    });
    expect(far).toMatchObject({ ok: false, reason: 'outside_geofence', radiusM: 100 });
    const none = await checkIn(db, {
      technicianId: techId,
      actor: { userId: techUser },
      position: null,
    });
    expect(none).toEqual({ ok: false, reason: 'no_location_fix' });
    const rows = await sql`select 1 from technician_status where technician_id = ${techId}`;
    expect(rows.length).toBe(0);
  });

  it('ignores the fence when the rules do not require being on site', async () => {
    await sql`update rule_configs set config = jsonb_set(config, '{eligibility,require_on_site}', 'false') where location_id = ${LOC}`;
    try {
      await driveTo(techId, techUser, 'off');
      const r = await checkIn(db, {
        technicianId: techId,
        actor: { userId: techUser },
        position: OUTSIDE,
      });
      expect(r.ok).toBe(true);
    } finally {
      await sql`update rule_configs set config = jsonb_set(config, '{eligibility,require_on_site}', 'true') where location_id = ${LOC}`;
    }
  });
});

describe('check-in position record (threat model T5)', () => {
  it('refuses a fix looser than the fence, and logs the raw position on success', async () => {
    await sql`update locations set geofence_lat = ${SALON.lat}, geofence_lng = ${SALON.lng}, geofence_radius_m = 100 where id = ${LOC}`;
    try {
      await driveTo(techId, techUser, 'off');
      const loose = await checkIn(db, {
        technicianId: techId,
        actor: { userId: techUser },
        position: { ...INSIDE, accuracyM: 250 },
      });
      expect(loose).toMatchObject({ ok: false, reason: 'poor_location_accuracy', radiusM: 100 });
      const ok = await checkIn(db, {
        technicianId: techId,
        actor: { userId: techUser },
        position: { ...INSIDE, accuracyM: 12 },
      });
      expect(ok.ok).toBe(true);
      const [a] = await sql<
        { after: { geofence: { position: { accuracyM: number }; reason: string } } }[]
      >`select after from audit_log where entity_id = ${techId} and action = 'check_in' order by at desc limit 1`;
      expect(a?.after.geofence.position.accuracyM).toBe(12);
      expect(a?.after.geofence.reason).toBe('ok');
    } finally {
      await sql`update locations set geofence_lat = null, geofence_lng = null, geofence_radius_m = null where id = ${LOC}`;
    }
  });

  it('records "no_fence" rather than a pass when on-site is required but no fence is set', async () => {
    await driveTo(techId, techUser, 'off');
    const r = await checkIn(db, {
      technicianId: techId,
      actor: { userId: techUser },
      position: null,
    });
    expect(r.ok).toBe(true);
    const [a] = await sql<
      { after: { geofence: { passed: boolean | null; reason: string } } }[]
    >`select after from audit_log where entity_id = ${techId} and action = 'check_in' order by at desc limit 1`;
    expect(a?.after.geofence).toMatchObject({ passed: null, reason: 'no_fence' });
  });
});

describe('audit log cannot be truncated', () => {
  it('refuses truncate', async () => {
    await expect(sql`truncate audit_log`).rejects.toThrow(/append-only/);
  });
});

describe('points ledger', () => {
  it('reproduces the daily total from rows only, including halves and penalties', async () => {
    await driveTo(techId, techUser, 'available');
    const [status] = await sql<
      { shift_id: string }[]
    >`select shift_id from technician_status where technician_id = ${techId}`;
    const shiftId = status!.shift_id;
    const base = {
      organizationId: ORG,
      locationId: LOC,
      technicianId: techId,
      shiftId,
      actorUserId: null,
    };
    await db.transaction(async (tx) => {
      await postPoints(tx, { ...base, delta: 1, reasonType: 'visit' });
      await postPoints(tx, { ...base, delta: 0.5, reasonType: 'visit' });
      await postPoints(tx, { ...base, delta: -0.5, reasonType: 'visit', note: 'appointment' });
      await postPoints(tx, { ...base, delta: 1, reasonType: 'deny', actorUserId: techUser });
    });
    expect(await shiftTotal(db, shiftId)).toBe(2);
    const [count] = await sql<
      { n: number }[]
    >`select count(*)::int as n from turn_ledger where shift_id = ${shiftId}`;
    expect(count?.n).toBe(4);
    const board = await locationStatus(db, LOC);
    expect(board.find((r) => r.technicianId === techId)).toMatchObject({
      status: 'available',
      points: 2,
    });
  });

  it('cannot be written directly by a technician', async () => {
    await expect(
      asUser(
        techUser,
        (
          tx,
        ) => tx`insert into turn_ledger (organization_id, location_id, technician_id, shift_id, delta, reason_type)
          select ${ORG}, ${LOC}, ${techId}, shift_id, 5, 'manual' from technician_status where technician_id = ${techId}`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('is readable by a member of the salon', async () => {
    const rows = await asUser(
      techUser,
      (tx) => tx`select delta from turn_ledger where technician_id = ${techId}`,
    );
    expect(rows.length).toBe(4);
  });
});

describe('audit log', () => {
  it('refuses update and delete, even for the database owner', async () => {
    await expect(sql`update audit_log set reason = 'edited'`).rejects.toThrow(/append-only/);
    await expect(sql`delete from audit_log`).rejects.toThrow(/append-only/);
  });

  it('is readable by owners and managers, not technicians', async () => {
    const count = (userId: string) =>
      asUser(userId, async (tx) => {
        const [row] = await tx<{ n: number }[]>`select count(*)::int as n from audit_log`;
        return row?.n ?? 0;
      });
    expect(await count(techUser)).toBe(0);
    const ownerId = randomUUID();
    await sql`insert into auth.users (id, aud, role, email) values (${ownerId}, 'authenticated', 'authenticated', ${`owner-${ownerId.slice(0, 6)}@example.test`})`;
    await sql`insert into profiles (id, display_name) values (${ownerId}, 'Phu')`;
    await sql`insert into memberships (user_id, organization_id, location_id, role) values (${ownerId}, ${ORG}, ${LOC}, 'owner')`;
    expect(await count(ownerId)).toBeGreaterThan(0);
  });
});

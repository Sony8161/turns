// A salon setup code creates a new organization with its first location, an
// owner membership, default categories and rule config v1. Single use, expires.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HEAVENLY_RULE_CONFIG_V1 } from '../src/seed';
import { createDb, type Db } from '../src/server';
import { createSetupCode, redeemSetupCode } from '../src/setup';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;

async function newAuthUser(name: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${id}, 'authenticated', 'authenticated', ${`${name}-${id.slice(0, 8)}@example.test`})`;
  return id;
}

beforeAll(async () => {
  await resetAndMigrate();
  db = createDb(TEST_URL);
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

describe('setup codes', () => {
  it('create a salon with one location, an owner, categories and rules', async () => {
    const setup = await createSetupCode(db, { note: 'for Mai' });
    const mai = await newAuthUser('mai');
    const result = await redeemSetupCode(db, {
      code: setup.code,
      userId: mai,
      displayName: 'Mai',
      salonName: "Mai's Nails",
      locationName: 'Brandon',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [org] = await sql`select name from organizations where id = ${result.organizationId}`;
    expect(org?.name).toBe("Mai's Nails");
    const [loc] = await sql`select name from locations where id = ${result.locationId}`;
    expect(loc?.name).toBe('Brandon');
    const [m] = await sql`select role from memberships where user_id = ${mai}`;
    expect(m?.role).toBe('owner');
    const cats =
      await sql`select count(*)::int as n from service_categories where organization_id = ${result.organizationId}`;
    expect(cats[0]?.n).toBe(4);
    // A new salon can take a walk-in on day one: the starting menu comes with it.
    const menu =
      await sql`select count(*)::int as n from services where organization_id = ${result.organizationId}`;
    expect(menu[0]?.n).toBe(14);
    const [rc] =
      await sql`select version, config from rule_configs where organization_id = ${result.organizationId}`;
    expect(rc?.version).toBe(1);
    // v0.16.0: the starting menu's own service points come with it (polish change 0, fix 0).
    const own = await sql<
      { id: string }[]
    >`select id from services where organization_id = ${result.organizationId} and name in ('Polish change', 'Nail fix / repair')`;
    expect(own.length).toBe(2);
    for (const o of own) expect(rc?.config.points.by_service[o.id]).toBe(0);
    expect({ ...rc?.config, points: { ...rc?.config.points, by_service: undefined } }).toEqual({
      ...HEAVENLY_RULE_CONFIG_V1,
      points: { ...HEAVENLY_RULE_CONFIG_V1.points, by_service: undefined },
    });
    const [code] =
      await sql`select used_by, organization_id from setup_codes where id = ${setup.id}`;
    expect(code).toEqual({ used_by: mai, organization_id: result.organizationId });
  });

  it('cannot be used twice', async () => {
    const setup = await createSetupCode(db);
    const a = await newAuthUser('a');
    const b = await newAuthUser('b');
    const first = await redeemSetupCode(db, {
      code: setup.code,
      userId: a,
      displayName: 'A',
      salonName: 'A Nails',
      locationName: 'Main',
    });
    expect(first.ok).toBe(true);
    const second = await redeemSetupCode(db, {
      code: setup.code,
      userId: b,
      displayName: 'B',
      salonName: 'B Nails',
      locationName: 'Main',
    });
    expect(second).toEqual({ ok: false, reason: 'used' });
    const orgs = await sql`select count(*)::int as n from organizations where name = 'B Nails'`;
    expect(orgs[0]?.n).toBe(0);
  });

  it('expire, and reject unknown codes', async () => {
    const setup = await createSetupCode(db, { ttlHours: -1 });
    const late = await newAuthUser('late');
    const input = { userId: late, displayName: 'L', salonName: 'L', locationName: 'L' };
    expect(await redeemSetupCode(db, { ...input, code: setup.code })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(await redeemSetupCode(db, { ...input, code: 'ZZZZZ-ZZZZZ' })).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('are invisible to app users', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe('set local role authenticated');
        return tx`select id from setup_codes`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});

// Done-when (REQ-63a6ce89): seed Heavenly main location, repeatably.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HEAVENLY,
  HEAVENLY_CATEGORIES,
  HEAVENLY_RULE_CONFIG_V1,
  seedHeavenly,
  startingRuleConfig,
} from '../src/seed';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();

beforeAll(async () => {
  await resetAndMigrate();
});

afterAll(async () => {
  await sql.end();
});

describe('seedHeavenly', () => {
  it('creates the organization, location, categories and rule config v1', async () => {
    const ids = await seedHeavenly(TEST_URL);

    const [org] = await sql`select name from organizations where id = ${ids.organizationId}`;
    expect(org?.name).toBe(HEAVENLY.organization);

    const [loc] =
      await sql`select name, timezone, organization_id from locations where id = ${ids.locationId}`;
    expect(loc).toMatchObject({
      name: HEAVENLY.location,
      timezone: HEAVENLY.timezone,
      organization_id: ids.organizationId,
    });

    const cats =
      await sql`select name from service_categories where location_id = ${ids.locationId} order by name`;
    expect(cats.map((c) => c.name)).toEqual([...HEAVENLY_CATEGORIES].map((c) => c.name).sort());

    const [rc] =
      await sql`select config from rule_configs where location_id = ${ids.locationId} and version = 1`;
    // v0.16.0: Heavenly's rules plus the starting menu's own service points.
    const menu = await sql<
      { id: string; name: string }[]
    >`select id, name from services where location_id = ${ids.locationId}`;
    expect(rc?.config).toEqual(startingRuleConfig(new Map(menu.map((m) => [m.name, m.id]))));
    const byName = new Map(menu.map((m) => [m.id, m.name]));
    const own = Object.entries(
      (rc?.config as { points: { by_service: Record<string, number> } }).points.by_service,
    ).map(([id, p]) => [byName.get(id), p]);
    expect(own.sort()).toEqual([
      ['Gel polish change', 1],
      ['Nail fix / repair', 0],
      ['Polish change', 0],
    ]);
  });

  it('is idempotent', async () => {
    const first = await seedHeavenly(TEST_URL);
    const second = await seedHeavenly(TEST_URL);
    expect(second).toEqual(first);

    const [counts] = await sql`
      select (select count(*) from organizations)::int as orgs,
             (select count(*) from locations)::int as locs,
             (select count(*) from service_categories)::int as cats,
             (select count(*) from rule_configs)::int as rcs`;
    expect(counts).toEqual({ orgs: 1, locs: 1, cats: HEAVENLY_CATEGORIES.length, rcs: 1 });
  });

  it('keeps the unconfirmed rule value as null, not a guess', () => {
    // v0.16.0 (Duong): a request counts as a full normal turn; no longer open.
    expect(HEAVENLY_RULE_CONFIG_V1.requests.requested_counts_points).toBe(1);
    expect(HEAVENLY_RULE_CONFIG_V1.penalties.late_tiers[2]?.start_points).toBeNull();
  });
});

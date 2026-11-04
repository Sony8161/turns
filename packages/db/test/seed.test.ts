// Done-when (REQ-63a6ce89): seed Heavenly main location, repeatably.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HEAVENLY, HEAVENLY_CATEGORIES, HEAVENLY_RULE_CONFIG_V1, seedHeavenly } from '../src/seed';
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
    expect(rc?.config).toEqual(HEAVENLY_RULE_CONFIG_V1);
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

  it('keeps the two unconfirmed rule values as null, not a guess', () => {
    expect(HEAVENLY_RULE_CONFIG_V1.requests.requested_counts_points).toBeNull();
    expect(HEAVENLY_RULE_CONFIG_V1.penalties.late_tiers[2].start_points).toBeNull();
  });
});

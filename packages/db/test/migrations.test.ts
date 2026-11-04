// Done-when (REQ-63a6ce89): migrations apply from an empty database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_TABLES } from '../src/schema';
import { resetAndMigrate, superuser } from './helpers';

const sql = superuser();

beforeAll(async () => {
  await resetAndMigrate();
});

afterAll(async () => {
  await sql.end();
});

describe('migrations on an empty database', () => {
  it('create every Part 1 table', async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`;
    const names = rows.map((r) => r.table_name).sort();
    expect(names).toEqual([...TENANT_TABLES].sort());
  });

  it('turn row-level security on for every table', async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select relname, relrowsecurity from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r'`;
    const off = rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    expect(off).toEqual([]);
  });

  it('apply a second time without error', async () => {
    await expect(resetAndMigrate()).resolves.toBeUndefined();
  });
});

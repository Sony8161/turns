// Done-when (REQ-63a6ce89): a user from a second salon cannot read or write
// any Heavenly row. Threat model T1, T2. Runs against the local Supabase stack
// so auth.uid(), the authenticated and anon roles, and Supabase's default
// privileges behave as on cloud.
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetAndMigrate, superuser } from './helpers';

const sql = superuser();

type Tenant = { org: string; location: string; user: string };
let heavenly: Tenant;
let other: Tenant;

const ORG_SCOPED = [
  'locations',
  'memberships',
  'technicians',
  'service_categories',
  'services',
  'rule_configs',
] as const;

async function seedTenant(name: string): Promise<Tenant> {
  const user = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${user}, 'authenticated', 'authenticated', ${`${name}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${user}, ${name})`;
  const [org] = await sql<
    { id: string }[]
  >`insert into organizations (name) values (${name}) returning id`;
  const [loc] = await sql<
    { id: string }[]
  >`insert into locations (organization_id, name) values (${org!.id}, ${`${name} main`}) returning id`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${user}, ${org!.id}, ${loc!.id}, 'owner')`;
  await sql`insert into technicians (user_id, organization_id, location_id, display_name) values (${user}, ${org!.id}, ${loc!.id}, ${name})`;
  const [cat] = await sql<
    { id: string }[]
  >`insert into service_categories (organization_id, location_id, name, base_points) values (${org!.id}, ${loc!.id}, 'manicure', 1.0) returning id`;
  await sql`insert into services (organization_id, location_id, category_id, name) values (${org!.id}, ${loc!.id}, ${cat!.id}, 'basic manicure')`;
  await sql`insert into rule_configs (organization_id, location_id, version, config) values (${org!.id}, ${loc!.id}, 1, '{}')`;
  return { org: org!.id, location: loc!.id, user };
}

/** Run `fn` as the given Postgres role with the given JWT claims, as PostgREST would. */
async function asRole<T>(
  role: 'authenticated' | 'anon',
  userId: string | null,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  // postgres.js types begin() as UnwrapPromiseArray<T>; for a single value that is T.
  return (await sql.begin(async (tx) => {
    const claims = userId ? { sub: userId, role } : { role };
    await tx`select set_config('request.jwt.claim.sub', ${userId ?? ''}, true)`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    await tx.unsafe(`set local role ${role}`);
    return fn(tx);
  })) as T;
}

const asUser = <T>(userId: string, fn: (tx: TransactionSql) => Promise<T>) =>
  asRole('authenticated', userId, fn);

beforeAll(async () => {
  await resetAndMigrate();
  heavenly = await seedTenant('heavenly');
  other = await seedTenant('other');
});

afterAll(async () => {
  await sql.end();
});

describe('a user from another salon', () => {
  for (const table of ORG_SCOPED) {
    it(`cannot read Heavenly rows in ${table}`, async () => {
      const rows = await asUser(other.user, (tx) =>
        tx.unsafe(`select organization_id from ${table}`),
      );
      expect(rows.length).toBeGreaterThan(0); // sees their own rows
      expect(rows.every((r) => r.organization_id === other.org)).toBe(true);
    });
  }

  it('cannot read the Heavenly organization', async () => {
    const rows = await asUser(other.user, (tx) => tx`select id from organizations`);
    expect(rows.map((r) => r.id)).toEqual([other.org]);
  });

  it('cannot read Heavenly profiles', async () => {
    const rows = await asUser(other.user, (tx) => tx`select id from profiles`);
    expect(rows.map((r) => r.id)).toEqual([other.user]);
  });

  it('cannot insert into a Heavenly location', async () => {
    await expect(
      asUser(
        other.user,
        (tx) =>
          tx`insert into locations (organization_id, name) values (${heavenly.org}, 'intruder')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  // "permission denied", not "0 rows": the right itself must be absent (T2).
  it('cannot update Heavenly rows', async () => {
    await expect(
      asUser(
        other.user,
        (tx) => tx`update organizations set name = 'x' where id = ${heavenly.org}`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('cannot delete Heavenly rows', async () => {
    await expect(
      asUser(
        other.user,
        (tx) => tx`delete from rule_configs where organization_id = ${heavenly.org}`,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('an app user, even in their own salon', () => {
  it('cannot write rule_configs directly (writes go through the server)', async () => {
    await expect(
      asUser(
        heavenly.user,
        (tx) =>
          tx`insert into rule_configs (organization_id, location_id, version, config) values (${heavenly.org}, ${heavenly.location}, 2, '{}')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  // TRUNCATE ignores row-level security; only a missing grant stops it.
  it('cannot truncate a table', async () => {
    await expect(asUser(heavenly.user, (tx) => tx`truncate memberships`)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('the anon role', () => {
  it('reads nothing', async () => {
    await expect(asRole('anon', null, (tx) => tx`select id from organizations`)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('Supabase default privileges', () => {
  // Supabase grants anon and authenticated ALL on new public tables by default.
  // The migration must revoke that for tables created later (Parts 2 to 10).
  it('no longer grant app roles write on a table created after the migration', async () => {
    await sql`create table public.zz_probe (id int)`;
    try {
      const [p] = await sql<{ a_ins: boolean; a_sel: boolean; n_sel: boolean }[]>`
        select has_table_privilege('authenticated', 'public.zz_probe', 'INSERT') as a_ins,
               has_table_privilege('authenticated', 'public.zz_probe', 'SELECT') as a_sel,
               has_table_privilege('anon', 'public.zz_probe', 'SELECT') as n_sel`;
      expect(p).toEqual({ a_ins: false, a_sel: false, n_sel: false });
    } finally {
      await sql`drop table public.zz_probe`;
    }
  });
});

describe('the schema itself, even for the server key', () => {
  // T1: a server bug that pairs salon A with a location of salon B is refused
  // by the composite foreign key, not left to a filter someone remembers.
  it('refuses a membership that points at another salon’s location', async () => {
    await expect(
      sql`insert into memberships (user_id, organization_id, location_id, role)
          values (${other.user}, ${other.org}, ${heavenly.location}, 'technician')`,
    ).rejects.toThrow(/violates foreign key constraint "memberships_location_fk"/);
  });

  it('refuses a service whose category belongs to another salon', async () => {
    const [cat] = await sql<
      { id: string }[]
    >`select id from service_categories where organization_id = ${heavenly.org} limit 1`;
    await expect(
      sql`insert into services (organization_id, location_id, category_id, name)
          values (${other.org}, ${other.location}, ${cat!.id}, 'stolen')`,
    ).rejects.toThrow(/violates foreign key constraint "services_category_fk"/);
  });

  it('refuses to delete a salon that still has data', async () => {
    await expect(sql`delete from organizations where id = ${other.org}`).rejects.toThrow(
      /violates foreign key constraint/,
    );
  });
});

describe('the Heavenly owner', () => {
  it('sees exactly their own organization', async () => {
    const rows = await asUser(heavenly.user, (tx) => tx`select id from organizations`);
    expect(rows.map((r) => r.id)).toEqual([heavenly.org]);
  });
});

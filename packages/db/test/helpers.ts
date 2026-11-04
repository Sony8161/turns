// Test database helpers. These wipe data, so they refuse anything that is not
// a local database.
import postgres from 'postgres';
import { runMigrations } from '../src/migrate';

export const TEST_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

function assertLocal(url: string): void {
  const u = new URL(url);
  const host = u.hostname;
  // postgres.js lets ?host= override the hostname, so check that too.
  if (u.searchParams.has('host') || u.searchParams.has('hostaddr')) {
    throw new Error('refusing a database URL that overrides its host');
  }
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`refusing to reset a non-local database: ${host}`);
  }
}

// Drops every object we created in `public` without dropping the schema itself.
// Dropping the schema would also drop Supabase's default privileges on it, and
// the tests exist to prove our migration handles those (code review, 2026-11-04).
const RESET_PUBLIC = `
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('drop table if exists public.%I cascade', r.tablename);
  end loop;
  for r in
    select p.proname, oidvectortypes(p.proargtypes) as args
    from pg_proc p where p.pronamespace = 'public'::regnamespace
  loop
    execute format('drop function if exists public.%I(%s) cascade', r.proname, r.args);
  end loop;
  for r in
    select typname from pg_type
    where typnamespace = 'public'::regnamespace and typtype = 'e'
  loop
    execute format('drop type if exists public.%I cascade', r.typname);
  end loop;
end $$;
`;

// Supabase's starting point: anon, authenticated and service_role get ALL on
// every new table, sequence and function in public. Our migration revokes it;
// that revoke is global and survives a table reset, so put it back here or the
// default-privilege test passes for the wrong reason after the first run.
const RESTORE_SUPABASE_DEFAULTS = `
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;
`;

/** Remove everything the migrations created, then apply every migration. */
export async function resetAndMigrate(url = TEST_URL): Promise<void> {
  assertLocal(url);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(RESET_PUBLIC);
    await sql.unsafe(RESTORE_SUPABASE_DEFAULTS);
    await sql.unsafe('drop schema if exists drizzle cascade;');
    // auth.users is outside public; drop the users the tests created.
    await sql.unsafe(`delete from auth.users where email like '%@example.test'`);
  } finally {
    await sql.end();
  }
  await runMigrations(url);
}

export function superuser(url = TEST_URL) {
  assertLocal(url);
  return postgres(url, { max: 1, onnotice: () => {} });
}

// Server-only entry: owns the Postgres driver. Never import this from apps/mobile
// or from a Next.js client component; import '@turn/db' (schema and types) there.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>;

/** One connection pool per process. Callers own closing it via `db.$client.end()`. */
export function createDb(url: string) {
  const client = postgres(url, { prepare: false });
  return drizzle(client, { schema });
}

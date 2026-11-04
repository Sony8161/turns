import 'server-only';
// The service connection. Skips row-level security, so everything that uses it
// must take the salon from the verified session, never from the request
// (threat model T1; decisions memo 1, condition 1). The import above makes the
// build fail if a client file ever reaches this (T16).
import { createDb, type Db } from '@turn/db/server';

const globalForDb = globalThis as unknown as { __turnDb?: Db };

export function db(): Db {
  if (!globalForDb.__turnDb) {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is not set');
    globalForDb.__turnDb = createDb(url);
  }
  return globalForDb.__turnDb;
}

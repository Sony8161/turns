// Fixed-window rate limiter backed by one row per key. One atomic upsert, so
// concurrent requests cannot both slip under the limit. Server only.
import { sql } from 'drizzle-orm';
import type { Db } from './server';

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

/** `cost` (v0.17.1): how many this request counts as, e.g. each person in a
 *  kiosk group. A whole number, 1 or more. */
export async function consumeRateLimit(
  db: Db,
  key: string,
  limit: number,
  windowSeconds: number,
  cost = 1,
): Promise<RateLimitResult> {
  const n = Math.max(1, Math.floor(cost));
  const result = await db.execute<{ count: number; reset_at: Date }>(sql`
    insert into rate_limits (key, count, reset_at)
    values (${key}, ${n}, now() + make_interval(secs => ${windowSeconds}))
    on conflict (key) do update set
      count = case when rate_limits.reset_at <= now() then ${n} else rate_limits.count + ${n} end,
      reset_at = case when rate_limits.reset_at <= now()
                      then now() + make_interval(secs => ${windowSeconds})
                      else rate_limits.reset_at end
    returning count, reset_at`);
  const row = result[0];
  if (!row) throw new Error('rate limit upsert returned nothing');
  const count = Number(row.count);
  const retryAfterSeconds = Math.max(
    0,
    Math.ceil((new Date(row.reset_at).getTime() - Date.now()) / 1000),
  );
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds };
}

/** Housekeeping: rows whose window has passed. Safe to run any time. */
export async function pruneRateLimits(db: Db): Promise<void> {
  await db.execute(sql`delete from rate_limits where reset_at <= now()`);
}

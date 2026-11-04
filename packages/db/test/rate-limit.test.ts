// Done-when (REQ-a5e7a172): SMS sending has a per-phone (and per-IP) limit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumeRateLimit, pruneRateLimits } from '../src/rate-limit';
import { createDb, type Db } from '../src/server';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;

beforeAll(async () => {
  await resetAndMigrate();
  db = createDb(TEST_URL);
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

describe('consumeRateLimit', () => {
  it('allows up to the limit in a window, then refuses', async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await consumeRateLimit(db, 'otp:contact:a', 3, 60));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]!.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keeps keys separate', async () => {
    expect((await consumeRateLimit(db, 'otp:contact:b', 1, 60)).allowed).toBe(true);
    expect((await consumeRateLimit(db, 'otp:contact:c', 1, 60)).allowed).toBe(true);
    expect((await consumeRateLimit(db, 'otp:contact:b', 1, 60)).allowed).toBe(false);
  });

  it('starts a new window once the old one has passed', async () => {
    expect((await consumeRateLimit(db, 'otp:ip:x', 1, 1)).allowed).toBe(true);
    expect((await consumeRateLimit(db, 'otp:ip:x', 1, 1)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await consumeRateLimit(db, 'otp:ip:x', 1, 1)).allowed).toBe(true);
  });

  it('survives concurrent calls without over-admitting', async () => {
    const hits = await Promise.all(
      Array.from({ length: 10 }, () => consumeRateLimit(db, 'otp:contact:race', 4, 60)),
    );
    expect(hits.filter((h) => h.allowed).length).toBe(4);
  });

  it('is invisible to app users and prunes expired rows', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe('set local role authenticated');
        return tx`select key from rate_limits`;
      }),
    ).rejects.toThrow(/permission denied/);
    await new Promise((r) => setTimeout(r, 1100));
    await pruneRateLimits(db);
    const rows = await sql`select key from rate_limits where key = 'otp:ip:x'`;
    expect(rows.length).toBe(0);
  });
});

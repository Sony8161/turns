// Done-when (REQ-a5e7a172): an invite code is single-use and expires; it binds
// the user to one location and one role. Threat model T9.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite, hashCode, normalizeCode, redeemInvite } from '../src/invites';
import { HEAVENLY, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
let ownerId: string;

async function newAuthUser(name: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${id}, 'authenticated', 'authenticated', ${`${name}-${id.slice(0, 8)}@example.test`})`;
  return id;
}

beforeAll(async () => {
  await resetAndMigrate();
  await seedHeavenly(TEST_URL);
  db = createDb(TEST_URL);
  ownerId = await newAuthUser('owner');
  await sql`insert into profiles (id, display_name) values (${ownerId}, 'Phu')`;
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

describe('invite codes', () => {
  it('are stored only as a hash, and match regardless of case or dashes', async () => {
    const invite = await createInvite(db, {
      organizationId: HEAVENLY.organizationId,
      locationId: HEAVENLY.locationId,
      role: 'receptionist',
      createdBy: ownerId,
    });
    const [row] = await sql`select code_hash from invite_codes where id = ${invite.id}`;
    expect(row?.code_hash).toBe(hashCode(invite.code));
    expect(row?.code_hash).not.toContain(normalizeCode(invite.code));
    expect(hashCode(invite.code.toLowerCase().replace('-', ' '))).toBe(hashCode(invite.code));
  });

  it('bind a technician to the location and role, and create their technician row', async () => {
    const invite = await createInvite(db, {
      organizationId: HEAVENLY.organizationId,
      locationId: HEAVENLY.locationId,
      role: 'technician',
      createdBy: ownerId,
    });
    const techId = await newAuthUser('thao');
    const result = await redeemInvite(db, {
      code: invite.code,
      userId: techId,
      displayName: 'Thảo',
    });
    expect(result).toEqual({
      ok: true,
      organizationId: HEAVENLY.organizationId,
      locationId: HEAVENLY.locationId,
      locationName: HEAVENLY.location,
      role: 'technician',
    });
    const [m] = await sql`select role, active from memberships where user_id = ${techId}`;
    expect(m).toEqual({ role: 'technician', active: true });
    const [t] = await sql`select display_name from technicians where user_id = ${techId}`;
    expect(t?.display_name).toBe('Thảo');
  });

  it('cannot be used twice', async () => {
    const invite = await createInvite(db, {
      organizationId: HEAVENLY.organizationId,
      locationId: HEAVENLY.locationId,
      role: 'receptionist',
      createdBy: ownerId,
    });
    const first = await newAuthUser('first');
    const second = await newAuthUser('second');
    expect(
      (await redeemInvite(db, { code: invite.code, userId: first, displayName: 'A' })).ok,
    ).toBe(true);
    expect(await redeemInvite(db, { code: invite.code, userId: second, displayName: 'B' })).toEqual(
      { ok: false, reason: 'used' },
    );
    const rows = await sql`select 1 from memberships where user_id = ${second}`;
    expect(rows.length).toBe(0);
  });

  it('refuse an account that already belongs to the salon (roles change only by owner or manager)', async () => {
    const first = await createInvite(db, {
      organizationId: HEAVENLY.organizationId,
      locationId: HEAVENLY.locationId,
      role: 'technician',
      createdBy: ownerId,
    });
    const second = await createInvite(db, {
      organizationId: HEAVENLY.organizationId,
      locationId: HEAVENLY.locationId,
      role: 'receptionist',
      createdBy: ownerId,
    });
    const quyen = await newAuthUser('quyen');
    expect(
      (await redeemInvite(db, { code: first.code, userId: quyen, displayName: 'Quyên' })).ok,
    ).toBe(true);
    expect(
      await redeemInvite(db, { code: second.code, userId: quyen, displayName: 'Quyên' }),
    ).toEqual({
      ok: false,
      reason: 'already_member',
    });
    const roles = await sql`select role from memberships where user_id = ${quyen}`;
    expect(roles.map((r) => r.role)).toEqual(['technician']);
    const [code] = await sql`select used_at from invite_codes where id = ${second.id}`;
    expect(code?.used_at).toBeNull(); // the code stays usable by a new person
  });

  it('expire', async () => {
    const invite = await createInvite(db, {
      organizationId: HEAVENLY.organizationId,
      locationId: HEAVENLY.locationId,
      role: 'manager',
      createdBy: ownerId,
      ttlHours: -1,
    });
    const late = await newAuthUser('late');
    expect(await redeemInvite(db, { code: invite.code, userId: late, displayName: 'L' })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('reject a code that was never issued', async () => {
    const nobody = await newAuthUser('nobody');
    expect(
      await redeemInvite(db, { code: 'ZZZZZ-ZZZZZ', userId: nobody, displayName: 'N' }),
    ).toEqual({ ok: false, reason: 'unknown' });
  });

  it('are invisible to app users', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe('set local role authenticated');
        return tx`select id from invite_codes`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});

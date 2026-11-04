// Done-when (Part 5, Duong 2026-11-04): an owner or manager changes roles, and
// that is the only way a role changes; staff are archived, never deleted;
// every change writes an audit row with a reason; a manager at location A
// cannot act at location B (threat model T10).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redeemInvite } from '../src/invites';
import { HEAVENLY, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import {
  archiveMember,
  canSetRole,
  changeRole,
  listStaff,
  makeInvite,
  restoreMember,
  type StaffActor,
} from '../src/staff';
import { checkIn, transition } from '../src/status';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
let otherLoc: string;
let owner: StaffActor;
let manager: StaffActor;
let managerB: StaffActor;
let thaoMembership: string;
let thaoUser: string;
let hanhMembership: string;

async function newMember(
  name: string,
  role: StaffActor['role'],
  locationId: string = LOC,
): Promise<{ userId: string; membershipId: string }> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${name}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  const [m] = await sql<
    { id: string }[]
  >`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${locationId}, ${role}) returning id`;
  if (role === 'technician') {
    await sql`insert into technicians (user_id, organization_id, location_id, display_name) values (${userId}, ${ORG}, ${locationId}, ${name})`;
  }
  return { userId, membershipId: m!.id };
}

beforeAll(async () => {
  await resetAndMigrate();
  await seedHeavenly(TEST_URL);
  db = createDb(TEST_URL);
  const [b] = await sql<
    { id: string }[]
  >`insert into locations (organization_id, name) values (${ORG}, 'Heavenly Brandon') returning id`;
  otherLoc = b!.id;
  const o = await newMember('Phu', 'owner');
  owner = { userId: o.userId, role: 'owner', organizationId: ORG, locationId: LOC };
  const v = await newMember('Vy', 'manager');
  manager = { userId: v.userId, role: 'manager', organizationId: ORG, locationId: LOC };
  const vb = await newMember('Vy B', 'manager', otherLoc);
  managerB = { userId: vb.userId, role: 'manager', organizationId: ORG, locationId: otherLoc };
  const t = await newMember('Thảo', 'technician');
  thaoMembership = t.membershipId;
  thaoUser = t.userId;
  const h = await newMember('Hạnh', 'receptionist');
  hanhMembership = h.membershipId;
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

describe('canSetRole', () => {
  it('owners set any role; managers never touch an owner; nobody else sets roles', () => {
    expect(canSetRole('owner', 'technician', 'owner')).toBe(true);
    expect(canSetRole('manager', 'technician', 'manager')).toBe(true);
    expect(canSetRole('manager', 'owner', 'manager')).toBe(false);
    expect(canSetRole('manager', 'manager', 'owner')).toBe(false);
    expect(canSetRole('receptionist', 'technician', 'technician')).toBe(false);
    expect(canSetRole('technician', 'technician', 'technician')).toBe(false);
  });
});

describe('invites from the admin screen', () => {
  it('an owner makes a code that joins a new person with that role, and it is audited', async () => {
    const r = await makeInvite(db, { actor: owner, role: 'receptionist' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const newbie = randomUUID();
    await sql`insert into auth.users (id, aud, role, email) values (${newbie}, 'authenticated', 'authenticated', ${`new-${newbie.slice(0, 6)}@example.test`})`;
    const joined = await redeemInvite(db, { code: r.code, userId: newbie, displayName: 'Mới' });
    expect(joined).toMatchObject({ ok: true, role: 'receptionist', locationId: LOC });
    const [audit] = await sql<
      { action: string; actor_user_id: string }[]
    >`select action, actor_user_id from audit_log where action = 'invite_created' order by at desc limit 1`;
    expect(audit).toEqual({ action: 'invite_created', actor_user_id: owner.userId });
  });

  it('a manager cannot make an owner code', async () => {
    expect(await makeInvite(db, { actor: manager, role: 'owner' })).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect((await makeInvite(db, { actor: manager, role: 'technician' })).ok).toBe(true);
  });
});

describe('changeRole', () => {
  it('a manager at location A cannot change a role at location B', async () => {
    const r = await changeRole(db, {
      actor: managerB,
      membershipId: thaoMembership,
      toRole: 'receptionist',
    });
    expect(r).toEqual({ ok: false, reason: 'wrong_location' });
    const [m] = await sql`select role from memberships where id = ${thaoMembership}`;
    expect(m?.role).toBe('technician');
  });

  it('nobody changes their own role', async () => {
    const [own] = await sql<
      { id: string }[]
    >`select id from memberships where user_id = ${owner.userId}`;
    expect(
      await changeRole(db, { actor: owner, membershipId: own!.id, toRole: 'manager' }),
    ).toEqual({ ok: false, reason: 'own_membership' });
  });

  it('a technician on shift keeps their role until they check out', async () => {
    const [t] = await sql<{ id: string }[]>`select id from technicians where user_id = ${thaoUser}`;
    await checkIn(db, { technicianId: t!.id, actor: { userId: thaoUser }, position: null });
    const r = await changeRole(db, {
      actor: manager,
      membershipId: thaoMembership,
      toRole: 'receptionist',
    });
    expect(r).toEqual({ ok: false, reason: 'on_shift' });
    await transition(db, { technicianId: t!.id, to: 'off', actor: { userId: thaoUser } });
  });

  it('a manager moves a technician to receptionist: the technician row goes inactive, audit has the reason', async () => {
    const r = await changeRole(db, {
      actor: manager,
      membershipId: thaoMembership,
      toRole: 'receptionist',
      reason: 'moving to the desk',
    });
    expect(r).toEqual({ ok: true });
    const [m] = await sql`select role, active from memberships where id = ${thaoMembership}`;
    expect(m).toEqual({ role: 'receptionist', active: true });
    const [t] = await sql`select active from technicians where user_id = ${thaoUser}`;
    expect(t?.active).toBe(false);
    const [audit] = await sql<
      {
        before: { role: string };
        after: { role: string };
        reason: string;
        actor_user_id: string;
      }[]
    >`select before, after, reason, actor_user_id from audit_log where action = 'role_changed' and entity_id = ${thaoMembership} order by at desc limit 1`;
    expect(audit).toMatchObject({
      before: { role: 'technician' },
      after: { role: 'receptionist' },
      reason: 'moving to the desk',
      actor_user_id: manager.userId,
    });
  });

  it('back to technician: the same technician row comes back active (history kept)', async () => {
    const [before] = await sql<
      { id: string }[]
    >`select id from technicians where user_id = ${thaoUser}`;
    const r = await changeRole(db, {
      actor: owner,
      membershipId: thaoMembership,
      toRole: 'technician',
    });
    expect(r).toEqual({ ok: true });
    const rows = await sql<
      { id: string; active: boolean }[]
    >`select id, active from technicians where user_id = ${thaoUser}`;
    expect(rows).toEqual([{ id: before!.id, active: true }]);
  });

  it('a manager cannot promote to owner', async () => {
    expect(
      await changeRole(db, { actor: manager, membershipId: hanhMembership, toRole: 'owner' }),
    ).toEqual({ ok: false, reason: 'not_allowed' });
  });
});

describe('archive and restore', () => {
  it('needs a reason, cannot cross locations, and never deletes', async () => {
    expect(
      await archiveMember(db, { actor: owner, membershipId: hanhMembership, reason: ' ' }),
    ).toEqual({ ok: false, reason: 'reason_required' });
    expect(
      await archiveMember(db, { actor: managerB, membershipId: hanhMembership, reason: 'left' }),
    ).toEqual({ ok: false, reason: 'wrong_location' });
    const r = await archiveMember(db, {
      actor: manager,
      membershipId: hanhMembership,
      reason: 'left the salon',
    });
    expect(r).toEqual({ ok: true });
    const [m] = await sql`select active from memberships where id = ${hanhMembership}`;
    expect(m?.active).toBe(false);
    const [audit] = await sql<
      { reason: string }[]
    >`select reason from audit_log where action = 'member_archived' and entity_id = ${hanhMembership}`;
    expect(audit?.reason).toBe('left the salon');
  });

  it('archived staff stay in the list for the owner and manager, and can be restored', async () => {
    const list = await listStaff(db, LOC);
    const hanh = list.find((s) => s.membershipId === hanhMembership);
    expect(hanh).toMatchObject({ displayName: 'Hạnh', role: 'receptionist', active: false });
    // Active rows first.
    const firstArchived = list.findIndex((s) => !s.active);
    expect(firstArchived).toBeGreaterThan(0);
    expect(list.slice(firstArchived).every((s) => !s.active)).toBe(true);
    expect(await restoreMember(db, { actor: owner, membershipId: hanhMembership })).toEqual({
      ok: true,
    });
    const [m] = await sql`select active from memberships where id = ${hanhMembership}`;
    expect(m?.active).toBe(true);
  });

  it('archiving a technician also inactivates their technician row; a manager cannot archive the owner', async () => {
    const r = await archiveMember(db, {
      actor: owner,
      membershipId: thaoMembership,
      reason: 'moved away',
    });
    expect(r).toEqual({ ok: true });
    const [t] = await sql`select active from technicians where user_id = ${thaoUser}`;
    expect(t?.active).toBe(false);
    // An archived member keeps their role until restored (no ghost technician row).
    expect(
      await changeRole(db, { actor: owner, membershipId: thaoMembership, toRole: 'manager' }),
    ).toEqual({ ok: false, reason: 'archived' });
    // Restoring a technician brings the same technician row back.
    expect(await restoreMember(db, { actor: owner, membershipId: thaoMembership })).toEqual({
      ok: true,
    });
    const [back] = await sql`select active from technicians where user_id = ${thaoUser}`;
    expect(back?.active).toBe(true);
    const [own] = await sql<
      { id: string }[]
    >`select id from memberships where user_id = ${owner.userId}`;
    expect(await archiveMember(db, { actor: manager, membershipId: own!.id, reason: 'x' })).toEqual(
      { ok: false, reason: 'not_allowed' },
    );
  });
});

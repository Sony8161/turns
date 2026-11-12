// Part 6 (REQ-5336cf7a): a technician's skills, tags and restrictions are set
// by an owner or manager at their own location, checked before they are
// saved, and every save writes an audit row with before and after.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  doesEverything,
  loadProfile,
  loadProfiles,
  saveProfile,
  validateProfile,
} from '../src/profile';
import { HEAVENLY, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import type { StaffActor } from '../src/staff';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
let manager: StaffActor;
let managerB: StaffActor;
let receptionist: StaffActor;
let tech: string;
let manicureCat: string;
let pedicureCat: string;

async function newUser(name: string, role: StaffActor['role'], locationId: string) {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${name}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${locationId}, ${role})`;
  return userId;
}

beforeAll(async () => {
  await resetAndMigrate();
  await seedHeavenly(TEST_URL);
  db = createDb(TEST_URL);
  const [b] = await sql<
    { id: string }[]
  >`insert into locations (organization_id, name) values (${ORG}, 'Heavenly Brandon') returning id`;
  manager = {
    userId: await newUser('Vy', 'manager', LOC),
    role: 'manager',
    organizationId: ORG,
    locationId: LOC,
  };
  managerB = {
    userId: await newUser('Vy B', 'manager', b!.id),
    role: 'manager',
    organizationId: ORG,
    locationId: b!.id,
  };
  receptionist = {
    userId: await newUser('Hạnh', 'receptionist', LOC),
    role: 'receptionist',
    organizationId: ORG,
    locationId: LOC,
  };
  const techUser = await newUser('Thảo', 'technician', LOC);
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${techUser}, ${ORG}, ${LOC}, 'Thảo') returning id`;
  tech = t!.id;
  const cats = await sql<
    { id: string; name: string }[]
  >`select id, name from service_categories where location_id = ${LOC}`;
  manicureCat = cats.find((c) => c.name === 'manicure')!.id;
  pedicureCat = cats.find((c) => c.name === 'pedicure')!.id;
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

describe('validateProfile', () => {
  it('refuses an empty skill list, a bad age, a blank custom note, a repeated type, a long tag', () => {
    expect(validateProfile({ skillCategoryIds: [], tags: [], restrictions: [] })).toEqual({
      ok: false,
      reason: 'no_skills',
    });
    expect(
      validateProfile({
        skillCategoryIds: null,
        tags: [],
        restrictions: [{ type: 'min_client_age', value: 0, note: null }],
      }),
    ).toEqual({ ok: false, reason: 'bad_age' });
    expect(
      validateProfile({
        skillCategoryIds: null,
        tags: [],
        restrictions: [{ type: 'custom', value: null, note: '  ' }],
      }),
    ).toEqual({ ok: false, reason: 'bad_restriction' });
    expect(
      validateProfile({
        skillCategoryIds: null,
        tags: [],
        restrictions: [
          { type: 'no_kids', value: null, note: null },
          { type: 'no_kids', value: null, note: null },
        ],
      }),
    ).toEqual({ ok: false, reason: 'bad_restriction' });
    expect(
      validateProfile({ skillCategoryIds: null, tags: ['x'.repeat(41)], restrictions: [] }),
    ).toEqual({ ok: false, reason: 'bad_tag' });
  });
  it('trims and de-duplicates tags; drops stray values on flag restrictions', () => {
    const r = validateProfile({
      skillCategoryIds: ['a', 'a'],
      tags: [' fast ', 'fast', '', 'design'],
      restrictions: [{ type: 'no_kids', value: 9, note: 'ignored' }],
    });
    expect(r).toEqual({
      ok: true,
      input: {
        skillCategoryIds: ['a'],
        tags: ['fast', 'design'],
        restrictions: [{ type: 'no_kids', value: null, note: null }],
      },
    });
  });
});

describe('saveProfile', () => {
  it('a new technician does everything and has no restrictions', async () => {
    const p = await loadProfile(db, tech);
    expect(doesEverything(p)).toBe(true);
    expect(p.restrictions).toEqual([]);
  });

  it('a manager saves skills, tags and restrictions; the audit row has before and after', async () => {
    const r = await saveProfile(db, {
      actor: manager,
      technicianId: tech,
      profile: {
        skillCategoryIds: [manicureCat, pedicureCat],
        tags: ['fast'],
        restrictions: [
          { type: 'no_male_clients', value: null, note: null },
          { type: 'min_client_age', value: 10, note: null },
          { type: 'custom', value: null, note: 'no acrylic smell' },
        ],
      },
    });
    expect(r).toEqual({ ok: true });
    const p = await loadProfile(db, tech);
    expect(new Set(p.skillCategoryIds)).toEqual(new Set([manicureCat, pedicureCat]));
    expect(p.tags).toEqual(['fast']);
    expect(p.restrictions).toHaveLength(3);
    const [audit] = await sql<
      { before: { restrictions: unknown[] }; after: { tags: string[] } }[]
    >`select before, after from audit_log where action = 'technician_profile_changed' and entity_id = ${tech} order by at desc limit 1`;
    expect(audit?.before.restrictions).toEqual([]);
    expect(audit?.after.tags).toEqual(['fast']);
    // Back to "does everything": the skill rows go, the audit keeps the old list.
    const back = await saveProfile(db, {
      actor: manager,
      technicianId: tech,
      profile: { skillCategoryIds: null, tags: [], restrictions: [] },
    });
    expect(back).toEqual({ ok: true });
    expect(doesEverything(await loadProfile(db, tech))).toBe(true);
    // No rows at all: the location map has no entry for them.
    expect((await loadProfiles(db, LOC)).get(tech)).toBeUndefined();
  });

  it('a receptionist cannot when the owner turned it off (v0.13.0: on by default); a manager at another location cannot; unknown ids are refused', async () => {
    const empty = { skillCategoryIds: null, tags: [], restrictions: [] };
    await sql`update locations set receptionist_edits_technicians = false`;
    expect(
      await saveProfile(db, { actor: receptionist, technicianId: tech, profile: empty }),
    ).toEqual({ ok: false, reason: 'not_allowed' });
    await sql`update locations set receptionist_edits_technicians = true`;
    expect(
      (await saveProfile(db, { actor: receptionist, technicianId: tech, profile: empty })).ok,
    ).toBe(true);
    expect(await saveProfile(db, { actor: managerB, technicianId: tech, profile: empty })).toEqual({
      ok: false,
      reason: 'wrong_location',
    });
    expect(
      await saveProfile(db, {
        actor: manager,
        technicianId: tech,
        profile: { ...empty, skillCategoryIds: [randomUUID()] },
      }),
    ).toEqual({ ok: false, reason: 'unknown_category' });
    expect(
      await saveProfile(db, { actor: manager, technicianId: randomUUID(), profile: empty }),
    ).toEqual({ ok: false, reason: 'unknown_technician' });
  });
});

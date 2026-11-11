// Development-only seed: sample accounts for every role at Heavenly, fresh
// invite and setup codes, and a dev-codes.txt file at the repo root with all of
// it. Safe to run again: accounts are re-used, codes are new each time.
// Refuses any database or auth server that is not on localhost.
// Usage: DATABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run db:seed:dev
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { addAppointment } from './appointments';
import { createWalkIn } from './engine';
import { createInvite, type Role } from './invites';
import { addLocation } from './locations';
import { loadProfiles, saveProfile, type ProfileInput } from './profile';
import {
  appointments,
  memberships,
  profiles,
  serviceCategories,
  services,
  technicians,
  visits,
} from './schema';
import { HEAVENLY, seedHeavenly } from './seed';
import { createDb, type Db } from './server';
import { createSetupCode } from './setup';

// Phones are 555 numbers (never real). Each is in supabase/config.toml under
// [auth.sms.test_otp] with the code 123456, so every account signs in by phone.
export const SAMPLE_ACCOUNTS: { name: string; email: string; phone: string; role: Role }[] = [
  { name: 'Phu', email: 'phu@example.test', phone: '+18135550100', role: 'owner' },
  { name: 'Vy', email: 'vy@example.test', phone: '+18135550101', role: 'manager' },
  { name: 'Hạnh', email: 'hanh@example.test', phone: '+18135550102', role: 'receptionist' },
  { name: 'Thảo', email: 'thao@example.test', phone: '+18135550103', role: 'technician' },
  { name: 'Linh', email: 'linh@example.test', phone: '+18135550104', role: 'technician' },
  { name: 'Mai', email: 'mai@example.test', phone: '+18135550105', role: 'technician' },
];
// Part 7: Heavenly's second location (placeholder name until Phu gives it),
// with its own receptionist and technician. Phu is owner at both.
export const SECOND_LOCATION = {
  id: '00000000-0000-4000-8000-000000000003',
  name: 'Heavenly Nails second',
} as const;
export const SECOND_ACCOUNTS: { name: string; email: string; phone: string; role: Role }[] = [
  { name: 'Kim', email: 'kim@example.test', phone: '+18135550106', role: 'receptionist' },
  { name: 'Châu', email: 'chau@example.test', phone: '+18135550107', role: 'technician' },
];
export const SPARE_TEST_PHONE = '+18135550109';
export const TEST_CODE = '123456';

// Part 6 (Duong, 2026-11-04): sample technicians with attributes, so the
// engine's skips can be watched on the board. Set once; a technician whose
// profile was edited by hand is left alone.
export const SAMPLE_PROFILES: Record<string, { skipCategories: string[]; profile: ProfileInput }> =
  {
    Thảo: {
      skipCategories: [],
      profile: {
        skillCategoryIds: null,
        tags: ['fast'],
        restrictions: [{ type: 'no_male_clients', value: null, note: null }],
      },
    },
    Linh: {
      skipCategories: [],
      profile: {
        skillCategoryIds: null,
        tags: ['design'],
        restrictions: [
          { type: 'no_kids', value: null, note: null },
          { type: 'min_client_age', value: 12, note: null },
        ],
      },
    },
    Mai: {
      // Everything but full sets.
      skipCategories: ['full_set'],
      profile: {
        skillCategoryIds: [],
        tags: [],
        restrictions: [
          { type: 'no_same_time', value: null, note: null },
          { type: 'custom', value: null, note: 'prefers mornings' },
        ],
      },
    },
  };

// Canned walk-ins with client attributes: a man (Thảo is skipped), a kid of 8
// (Linh is skipped), a both-at-once pair (Mai is skipped), a full set (Mai
// lacks the skill). Added only when the location has no visits yet, so
// re-runs do not pile up.
export const SAMPLE_WALK_INS: {
  services: string[];
  gender?: 'female' | 'male';
  isKid?: boolean;
  age?: number;
  sameTime?: boolean;
  note: string;
}[] = [
  { services: ['Basic manicure'], gender: 'male', note: 'sample: a man' },
  { services: ['Basic pedicure'], gender: 'female', isKid: true, age: 8, note: 'sample: a kid, 8' },
  {
    services: ['Gel manicure', 'Spa pedicure'],
    gender: 'female',
    sameTime: true,
    note: 'sample: both at once',
  },
  { services: ['Acrylic full set'], note: 'sample: a full set' },
];

async function seedProfiles(db: Db, ownerId: string): Promise<void> {
  const existing = await loadProfiles(db, HEAVENLY.locationId);
  const techs = await db
    .select({ id: technicians.id, name: technicians.displayName })
    .from(technicians)
    .where(eq(technicians.locationId, HEAVENLY.locationId));
  const cats = await db
    .select({ id: serviceCategories.id, name: serviceCategories.name })
    .from(serviceCategories)
    .where(eq(serviceCategories.locationId, HEAVENLY.locationId));
  const actor = {
    userId: ownerId,
    role: 'owner' as const,
    organizationId: HEAVENLY.organizationId,
    locationId: HEAVENLY.locationId,
  };
  for (const t of techs) {
    const sample = SAMPLE_PROFILES[t.name];
    if (!sample || existing.has(t.id)) continue;
    const skillCategoryIds = sample.skipCategories.length
      ? cats.filter((c) => !sample.skipCategories.includes(c.name)).map((c) => c.id)
      : null;
    const r = await saveProfile(db, {
      actor,
      technicianId: t.id,
      profile: { ...sample.profile, skillCategoryIds },
    });
    if (!r.ok) throw new Error(`sample profile for ${t.name}: ${r.reason}`);
  }
}

// Part 7: two hand-entered appointments, added once (when the location has
// none): Thảo in 25 minutes (inside the 30-minute buffer, so she is skipped
// until the client arrives) and Linh in two hours.
async function seedAppointments(db: Db, receptionistId: string): Promise<void> {
  const any = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(eq(appointments.locationId, HEAVENLY.locationId))
    .limit(1);
  if (any.length) return;
  const techs = await db
    .select({ id: technicians.id, name: technicians.displayName })
    .from(technicians)
    .where(eq(technicians.locationId, HEAVENLY.locationId));
  const byName = new Map(techs.map((t) => [t.name, t.id]));
  const at = (min: number) => new Date(Math.ceil(Date.now() / 300_000) * 300_000 + min * 60_000);
  const actor = {
    userId: receptionistId,
    organizationId: HEAVENLY.organizationId,
    locationId: HEAVENLY.locationId,
  };
  for (const s of [
    { name: 'Thảo', start: 25, minutes: 75, client: 'Sample: full set' },
    { name: 'Linh', start: 120, minutes: 45, client: 'Sample: gel manicure' },
  ]) {
    const technicianId = byName.get(s.name);
    if (!technicianId) continue;
    const r = await addAppointment(db, {
      actor,
      technicianId,
      clientName: s.client,
      startAt: at(s.start),
      endAt: at(s.start + s.minutes),
    });
    if (!r.ok) throw new Error(`sample appointment for ${s.name}: ${r.reason}`);
  }
}

async function seedWalkIns(db: Db, ownerId: string): Promise<void> {
  const any = await db
    .select({ id: visits.id })
    .from(visits)
    .where(eq(visits.locationId, HEAVENLY.locationId))
    .limit(1);
  if (any.length) return;
  const menu = await db
    .select({ id: services.id, name: services.name })
    .from(services)
    .where(
      and(
        eq(services.locationId, HEAVENLY.locationId),
        inArray(
          services.name,
          SAMPLE_WALK_INS.flatMap((w) => w.services),
        ),
      ),
    );
  const byName = new Map(menu.map((s) => [s.name, s.id]));
  for (const w of SAMPLE_WALK_INS) {
    const r = await createWalkIn(db, {
      organizationId: HEAVENLY.organizationId,
      locationId: HEAVENLY.locationId,
      serviceIds: w.services.map((n) => byName.get(n)!).filter(Boolean),
      actor: { userId: ownerId },
      attributes: { gender: w.gender ?? null, isKid: w.isKid ?? null, age: w.age ?? null },
      sameTime: w.sameTime ?? false,
      note: w.note,
    });
    if (!r.ok) throw new Error(`sample walk-in "${w.note}": ${r.reason}`);
  }
}

const LOCAL_AUTH_URL = 'http://127.0.0.1:54321/auth/v1';
function localServiceKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set (see .env.example)');
  return key;
}

function assertLocal(url: string): void {
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`seed-dev refuses a non-local database: ${host}`);
  }
}

type AuthUser = { id: string; email?: string; phone?: string };

/** Creates (or finds) a local auth user with email and phone, both confirmed. */
async function ensureLocalAuthUser(email: string, phone: string): Promise<string> {
  const key = localServiceKey();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  const created = await fetch(`${LOCAL_AUTH_URL}/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, phone, email_confirm: true, phone_confirm: true }),
  });
  if (created.ok) return ((await created.json()) as AuthUser).id;

  const list = await fetch(`${LOCAL_AUTH_URL}/admin/users?page=1&per_page=500`, { headers });
  if (!list.ok) throw new Error(`auth admin list failed: ${list.status}`);
  const { users } = (await list.json()) as { users: AuthUser[] };
  // GoTrue stores phones without the plus sign.
  const bare = phone.replace(/^\+/, '');
  const existing = users.find((u) => u.email === email || u.phone === bare || u.phone === phone);
  if (!existing) throw new Error(`could not create or find auth user ${email}`);
  return existing.id;
}

async function ensureAccount(
  db: Db,
  a: (typeof SAMPLE_ACCOUNTS)[number],
  locationId: string = HEAVENLY.locationId,
): Promise<string> {
  const userId = await ensureLocalAuthUser(a.email, a.phone);
  await db
    .insert(profiles)
    .values({ id: userId, displayName: a.name, email: a.email, phone: a.phone })
    .onConflictDoNothing();
  await db
    .insert(memberships)
    .values({
      userId,
      organizationId: HEAVENLY.organizationId,
      locationId,
      role: a.role,
    })
    .onConflictDoNothing();
  if (a.role === 'technician') {
    await db
      .insert(technicians)
      .values({
        userId,
        organizationId: HEAVENLY.organizationId,
        locationId,
        displayName: a.name,
      })
      .onConflictDoNothing();
  }
  return userId;
}

export async function seedDev(
  url: string,
): Promise<{ technicianCode: string; receptionistCode: string; setupCode: string; notes: string }> {
  assertLocal(url);
  await seedHeavenly(url);
  const db = createDb(url);
  try {
    let ownerId = '';
    let receptionistId = '';
    for (const a of SAMPLE_ACCOUNTS) {
      const id = await ensureAccount(db, a);
      if (a.role === 'owner') ownerId = id;
      if (a.role === 'receptionist') receptionistId = id;
    }
    // After the owner exists, so Phu becomes owner of the second location too.
    const second = await addLocation(db, {
      organizationId: HEAVENLY.organizationId,
      name: SECOND_LOCATION.name,
      id: SECOND_LOCATION.id,
      actorUserId: ownerId,
    });
    if (!second.ok) throw new Error(`second location: ${second.reason}`);
    await db
      .insert(memberships)
      .values({
        userId: ownerId,
        organizationId: HEAVENLY.organizationId,
        locationId: second.locationId,
        role: 'owner',
      })
      .onConflictDoNothing();
    for (const a of SECOND_ACCOUNTS) await ensureAccount(db, a, second.locationId);
    const base = {
      organizationId: HEAVENLY.organizationId,
      locationId: HEAVENLY.locationId,
      createdBy: ownerId,
    };
    const tech = await createInvite(db, { ...base, role: 'technician' });
    const reception = await createInvite(db, { ...base, role: 'receptionist' });
    const setup = await createSetupCode(db, { note: 'dev seed' });
    await seedProfiles(db, ownerId);
    await seedWalkIns(db, ownerId);
    await seedAppointments(db, receptionistId);

    const lines = [
      `Local sample data, written ${new Date().toISOString()} by npm run db:seed:dev`,
      `Every sign-in code is ${TEST_CODE}. Emails also work: the code arrives in Mailpit, http://127.0.0.1:54324`,
      '',
      'Accounts at Heavenly Nails main:',
      ...SAMPLE_ACCOUNTS.map(
        (a) => `  ${a.role.padEnd(13)} ${a.name.padEnd(6)} phone ${a.phone}   email ${a.email}`,
      ),
      '',
      `Accounts at ${SECOND_LOCATION.name} (Part 7; Phu is owner here too, switch with "Location" in the admin nav):`,
      ...SECOND_ACCOUNTS.map(
        (a) => `  ${a.role.padEnd(13)} ${a.name.padEnd(6)} phone ${a.phone}   email ${a.email}`,
      ),
      '',
      `Spare phone for a brand-new person (use with a code below): ${SPARE_TEST_PHONE}`,
      `Staff invite, technician:    ${tech.code}`,
      `Staff invite, receptionist:  ${reception.code}`,
      `Salon setup code (new salon): ${setup.code}`,
      '',
      'Screens: owner/manager/receptionist -> http://localhost:3000/admin   technician -> http://localhost:3000/me',
      'Join with a code: /join   New salon: /setup   (sign out first; a code is for a new account)',
      '',
      'Sample technicians (Part 6): Thảo takes no male clients; Linh takes no kids and nobody under 12;',
      'Mai does everything but full sets and no both-at-once visits. Staff -> Skills and restrictions to change.',
      'Sample walk-ins (added once, when the salon had no visits): a man, a kid of 8, a both-at-once pair, a full set.',
      'Check the three technicians in and press Call next on each to watch who is skipped and why.',
      'Sample appointments (Part 7, added once): Thảo in 25 min (she is skipped until the client arrives), Linh in 2 h.',
      'Appointments -> pick services -> Client arrived. A calendar sync from a local file:',
      '  npm run -w @turn/db feed:local -- "Mai" --sample',
    ];
    const notes = lines.join('\n');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    writeFileSync(join(root, 'dev-codes.txt'), notes + '\n', 'utf8');
    return {
      technicianCode: tech.code,
      receptionistCode: reception.code,
      setupCode: setup.code,
      notes,
    };
  } finally {
    await db.$client.end();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  seedDev(url).then(
    (r) => console.log(r.notes),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

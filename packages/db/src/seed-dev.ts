// Development-only seed: sample accounts for every role at Heavenly, fresh
// invite and setup codes, and a dev-codes.txt file at the repo root with all of
// it. Safe to run again: accounts are re-used, codes are new each time.
// Refuses any database or auth server that is not on localhost.
// Usage: DATABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run db:seed:dev
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInvite, type Role } from './invites';
import { memberships, profiles, technicians } from './schema';
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
export const SPARE_TEST_PHONE = '+18135550109';
export const TEST_CODE = '123456';

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

async function ensureAccount(db: Db, a: (typeof SAMPLE_ACCOUNTS)[number]): Promise<string> {
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
      locationId: HEAVENLY.locationId,
      role: a.role,
    })
    .onConflictDoNothing();
  if (a.role === 'technician') {
    await db
      .insert(technicians)
      .values({
        userId,
        organizationId: HEAVENLY.organizationId,
        locationId: HEAVENLY.locationId,
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
    for (const a of SAMPLE_ACCOUNTS) {
      const id = await ensureAccount(db, a);
      if (a.role === 'owner') ownerId = id;
    }
    const base = {
      organizationId: HEAVENLY.organizationId,
      locationId: HEAVENLY.locationId,
      createdBy: ownerId,
    };
    const tech = await createInvite(db, { ...base, role: 'technician' });
    const reception = await createInvite(db, { ...base, role: 'receptionist' });
    const setup = await createSetupCode(db, { note: 'dev seed' });

    const lines = [
      `Local sample data, written ${new Date().toISOString()} by npm run db:seed:dev`,
      `Every sign-in code is ${TEST_CODE}. Emails also work: the code arrives in Mailpit, http://127.0.0.1:54324`,
      '',
      'Accounts at Heavenly Nails main:',
      ...SAMPLE_ACCOUNTS.map(
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

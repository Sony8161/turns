// Development-only seed: an owner account for Heavenly and fresh invite codes,
// so the join and sign-in flows can be tried on the local stack. Refuses any
// database or auth server that is not on localhost. Never run against cloud.
// Usage: DATABASE_URL=... npm run db:seed:dev
import { createInvite } from './invites';
import { memberships, profiles } from './schema';
import { HEAVENLY, seedHeavenly } from './seed';
import { createDb } from './server';
import { createSetupCode } from './setup';

export const DEV_OWNER = {
  email: 'phu@example.test',
  name: 'Phu',
} as const;

// Local auth server. The service key comes from the environment (the value
// `npx supabase start` prints), so no key sits in source even for local.
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

/** Creates the owner through the local auth server, so every auth column is right. */
async function ensureLocalAuthUser(email: string): Promise<string> {
  const key = localServiceKey();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  const created = await fetch(`${LOCAL_AUTH_URL}/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, email_confirm: true }),
  });
  if (created.ok) return ((await created.json()) as { id: string }).id;

  const list = await fetch(`${LOCAL_AUTH_URL}/admin/users?page=1&per_page=200`, { headers });
  if (!list.ok) throw new Error(`auth admin list failed: ${list.status}`);
  const { users } = (await list.json()) as { users: { id: string; email?: string }[] };
  const existing = users.find((u) => u.email === email);
  if (!existing) throw new Error(`could not create or find auth user ${email}`);
  return existing.id;
}

export async function seedDev(
  url: string,
): Promise<{ technicianCode: string; receptionistCode: string; setupCode: string }> {
  assertLocal(url);
  await seedHeavenly(url);
  const ownerId = await ensureLocalAuthUser(DEV_OWNER.email);
  const db = createDb(url);
  try {
    await db
      .insert(profiles)
      .values({ id: ownerId, displayName: DEV_OWNER.name, email: DEV_OWNER.email })
      .onConflictDoNothing();
    await db
      .insert(memberships)
      .values({
        userId: ownerId,
        organizationId: HEAVENLY.organizationId,
        locationId: HEAVENLY.locationId,
        role: 'owner',
      })
      .onConflictDoNothing();
    const tech = await createInvite(db, {
      organizationId: HEAVENLY.organizationId,
      locationId: HEAVENLY.locationId,
      role: 'technician',
      createdBy: ownerId,
    });
    const reception = await createInvite(db, {
      organizationId: HEAVENLY.organizationId,
      locationId: HEAVENLY.locationId,
      role: 'receptionist',
      createdBy: ownerId,
    });
    const setup = await createSetupCode(db, { note: 'dev seed' });
    return { technicianCode: tech.code, receptionistCode: reception.code, setupCode: setup.code };
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
    (codes) => {
      console.log(`owner: ${DEV_OWNER.email} (code arrives in Mailpit, http://127.0.0.1:54324)`);
      console.log(`technician invite: ${codes.technicianCode}`);
      console.log(`receptionist invite: ${codes.receptionistCode}`);
      console.log(`salon setup code (new salon + owner): ${codes.setupCode}`);
      console.log('test phone for sign-in: 813 555 0100, code 123456');
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

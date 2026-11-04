'use server';

import { eq } from 'drizzle-orm';
import { setupCodes } from '@turn/db';
import { hashCode } from '@turn/db/invites';
import { consumeRateLimit } from '@turn/db/rate-limit';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { clientIp } from '@/lib/request';
import { setInviteCookie } from '../join/invite-cookie';

export type SetupState = {
  typed?: { code: string; name: string; salonName: string; locationName: string };
  error?: 'unknown' | 'used' | 'expired' | 'fields' | 'tooMany';
};

const field = (formData: FormData, key: string, max: number) =>
  String(formData.get(key) ?? '')
    .trim()
    .slice(0, max);

/** Checks the setup code without using it, remembers the answers, then sign-in. */
export async function startSetup(_prev: SetupState, formData: FormData): Promise<SetupState> {
  const typed = {
    code: field(formData, 'code', 20),
    name: field(formData, 'name', 80),
    salonName: field(formData, 'salonName', 80),
    locationName: field(formData, 'locationName', 80),
  };
  if (!typed.name || !typed.salonName || !typed.locationName) return { typed, error: 'fields' };

  const attempts = await consumeRateLimit(db(), `setup:ip:${await clientIp()}`, 20, 15 * 60);
  if (!attempts.allowed) return { typed, error: 'tooMany' };

  const [setup] = await db()
    .select({ usedAt: setupCodes.usedAt, expiresAt: setupCodes.expiresAt })
    .from(setupCodes)
    .where(eq(setupCodes.codeHash, hashCode(typed.code)));
  if (!setup) return { typed, error: 'unknown' };
  if (setup.usedAt) return { typed, error: 'used' };
  if (setup.expiresAt.getTime() < Date.now()) return { typed, error: 'expired' };

  await setInviteCookie({ kind: 'setup', ...typed });
  redirect('/login');
}

'use server';

import { eq } from 'drizzle-orm';
import { inviteCodes } from '@turn/db';
import { hashCode } from '@turn/db/invites';
import { consumeRateLimit } from '@turn/db/rate-limit';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { clientIp } from '@/lib/request';
import { setInviteCookie } from './invite-cookie';

export type JoinState = {
  typed?: { code: string; name: string };
  error?: 'unknown' | 'used' | 'expired' | 'name' | 'tooMany';
};

/** Checks the code without using it, remembers it, then sends the person to sign in. */
export async function startJoin(_prev: JoinState, formData: FormData): Promise<JoinState> {
  const code = String(formData.get('code') ?? '').trim();
  const name = String(formData.get('name') ?? '')
    .trim()
    .slice(0, 80);
  const typed = { code, name };
  if (name.length < 1) return { typed, error: 'name' };

  // Codes carry about 50 bits, but a limit costs nothing (threat model T9).
  const attempts = await consumeRateLimit(db(), `join:ip:${await clientIp()}`, 20, 15 * 60);
  if (!attempts.allowed) return { typed, error: 'tooMany' };

  const [invite] = await db()
    .select({ usedAt: inviteCodes.usedAt, expiresAt: inviteCodes.expiresAt })
    .from(inviteCodes)
    .where(eq(inviteCodes.codeHash, hashCode(code)));
  if (!invite) return { typed, error: 'unknown' };
  if (invite.usedAt) return { typed, error: 'used' };
  if (invite.expiresAt.getTime() < Date.now()) return { typed, error: 'expired' };

  await setInviteCookie({ kind: 'invite', code, name });
  redirect('/login');
}

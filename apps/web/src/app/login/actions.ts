'use server';

import { eq } from 'drizzle-orm';
import { inviteCodes } from '@turn/db';
import { hashCode } from '@turn/db/invites';
import { consumeRateLimit } from '@turn/db/rate-limit';
import { redirect } from 'next/navigation';
import { parseContact, type Contact } from '@/lib/contact';
import { db } from '@/lib/db';
import { clientIp } from '@/lib/request';
import { adminAuth } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { clearInviteCookie, readInviteCookie } from '../join/invite-cookie';

export type LoginState =
  | { step: 'contact'; typed?: string; error?: 'invalidContact' | 'tooMany' | 'unknown' }
  | { step: 'code'; contact: Contact; error?: 'badCode' | 'unknown' };

// Threat model T7: codes per contact and per address, in a 15-minute window.
const WINDOW = 15 * 60;
const PER_CONTACT = 5;
const PER_IP = 20;

/** One action for the whole sign-in: the form says which step it is on. */
export async function login(prev: LoginState, formData: FormData): Promise<LoginState> {
  const intent = formData.get('intent');
  if (intent === 'back') return { step: 'contact' };
  if (intent === 'verify' && prev.step === 'code') return verifyCode(prev, formData);
  return sendCode(formData);
}

async function sendCode(formData: FormData): Promise<LoginState> {
  const typed = String(formData.get('contact') ?? '');
  const contact = parseContact(typed);
  if (!contact) return { step: 'contact', typed, error: 'invalidContact' };

  const ip = await clientIp();
  const [byContact, byIp] = await Promise.all([
    consumeRateLimit(db(), `otp:contact:${contact.value}`, PER_CONTACT, WINDOW),
    consumeRateLimit(db(), `otp:ip:${ip}`, PER_IP, WINDOW),
  ]);
  if (!byContact.allowed || !byIp.allowed) return { step: 'contact', typed, error: 'tooMany' };

  // Accounts are created only behind a valid invite (T9); signup is off at the
  // auth server, so the public anon key cannot create one directly.
  if (await inviteIsRedeemable()) await ensureAuthUser(contact);

  const supabase = await createClient();
  const options = { shouldCreateUser: false };
  const { error } =
    contact.kind === 'email'
      ? await supabase.auth.signInWithOtp({ email: contact.value, options })
      : await supabase.auth.signInWithOtp({ phone: contact.value, options });
  if (error?.status === 429) return { step: 'contact', typed, error: 'tooMany' };
  // Any other error (including "no such account") still shows the code step,
  // so the form never reveals who is staff.
  return { step: 'code', contact };
}

async function inviteIsRedeemable(): Promise<boolean> {
  const invite = await readInviteCookie();
  if (!invite) return false;
  const [row] = await db()
    .select({ usedAt: inviteCodes.usedAt, expiresAt: inviteCodes.expiresAt })
    .from(inviteCodes)
    .where(eq(inviteCodes.codeHash, hashCode(invite.code)));
  return !!row && !row.usedAt && row.expiresAt.getTime() > Date.now();
}

async function ensureAuthUser(contact: Contact): Promise<void> {
  const { error } = await adminAuth().createUser(
    contact.kind === 'email'
      ? { email: contact.value, email_confirm: true }
      : { phone: contact.value, phone_confirm: true },
  );
  // Already registered is fine; anything else surfaces as a failed code later.
  if (error && !/already|exists/i.test(error.message)) {
    console.error('createUser failed', { kind: contact.kind, code: error.code });
  }
}

async function verifyCode(
  prev: Extract<LoginState, { step: 'code' }>,
  formData: FormData,
): Promise<LoginState> {
  const token = String(formData.get('code') ?? '').trim();
  if (!/^\d{6}$/.test(token)) return { ...prev, error: 'badCode' };

  const ip = await clientIp();
  const attempts = await consumeRateLimit(db(), `verify:ip:${ip}`, 30, WINDOW);
  if (!attempts.allowed) return { ...prev, error: 'badCode' };

  const supabase = await createClient();
  const { data, error } =
    prev.contact.kind === 'email'
      ? await supabase.auth.verifyOtp({ email: prev.contact.value, token, type: 'email' })
      : await supabase.auth.verifyOtp({ phone: prev.contact.value, token, type: 'sms' });
  if (error || !data.user) return { ...prev, error: 'badCode' };

  const invite = await readInviteCookie();
  redirect(invite ? '/join/finish' : '/admin');
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  await clearInviteCookie();
  redirect('/');
}

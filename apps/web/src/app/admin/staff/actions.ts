'use server';

import type { Role } from '@turn/db/invites';
import {
  archiveMember,
  changeRole,
  makeInvite,
  restoreMember,
  type StaffActor,
  type StaffError,
} from '@turn/db/staff';
import { revalidatePath } from 'next/cache';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';

export type StaffState = {
  error?: StaffError | 'bad_role';
  /** A fresh invite code, shown once. */
  code?: string;
  expiresAt?: string;
  done?: 'role' | 'archive' | 'restore';
};

const ROLES: readonly Role[] = ['owner', 'manager', 'receptionist', 'technician'];

function roleOf(raw: FormDataEntryValue | null): Role | null {
  const s = String(raw ?? '');
  return (ROLES as readonly string[]).includes(s) ? (s as Role) : null;
}

/** One action for the staff screen; the form says what it wants. The actor's
 *  role and location come from their membership, never from the form (T10). */
export async function staffAction(_prev: StaffState, formData: FormData): Promise<StaffState> {
  const actor = await requireActor();
  const m = membershipWith(actor, 'invite_staff');
  if (!m) return { error: 'not_allowed' };
  const me: StaffActor = {
    userId: actor.userId,
    role: m.role,
    organizationId: m.organizationId,
    locationId: m.locationId,
  };
  const intent = String(formData.get('intent') ?? '');
  const membershipId = String(formData.get('membershipId') ?? '');
  const reason = String(formData.get('reason') ?? '');

  let result: { ok: true } | { ok: false; reason: StaffError };
  let state: StaffState = {};
  switch (intent) {
    case 'invite': {
      const role = roleOf(formData.get('role'));
      if (!role) return { error: 'bad_role' };
      const r = await makeInvite(db(), { actor: me, role });
      if (!r.ok) return { error: r.reason };
      return { code: r.code, expiresAt: r.expiresAt.toISOString() };
    }
    case 'role': {
      const toRole = roleOf(formData.get('role'));
      if (!toRole) return { error: 'bad_role' };
      result = await changeRole(db(), { actor: me, membershipId, toRole, reason });
      state = { done: 'role' };
      break;
    }
    case 'archive':
      result = await archiveMember(db(), { actor: me, membershipId, reason });
      state = { done: 'archive' };
      break;
    case 'restore':
      result = await restoreMember(db(), { actor: me, membershipId });
      state = { done: 'restore' };
      break;
    default:
      return {};
  }
  revalidatePath('/admin/staff');
  revalidatePath('/admin');
  return result.ok ? state : { error: result.reason };
}

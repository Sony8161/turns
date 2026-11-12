'use server';

import { saveProfile, type ProfileError } from '@turn/db/profile';
import type { StaffActor } from '@turn/db/staff';
import { revalidatePath } from 'next/cache';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { isUuid } from '@/lib/ids';
import { profileFromForm } from '../profile-form';
import { guarded } from '@/lib/action';

export type ProfileState = { error?: ProfileError | 'server'; saved?: boolean; ref?: string };

/** Saves a technician's skills, tags and restrictions. The actor's role and
 *  location come from their membership, never from the form (T10). */
export async function saveProfileAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  return guarded('saveProfileAction', { error: 'server' } as ProfileState, () =>
    saveProfileActionRun(_prev, formData),
  );
}

async function saveProfileActionRun(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const actor = await requireActor();
  // Who may save is decided in saveProfile (receptionists too, unless the
  // owner turned it off; v0.13.0).
  const m = membershipWith(actor, 'view_board');
  if (!m) return { error: 'not_allowed' };
  const me: StaffActor = {
    userId: actor.userId,
    role: m.role,
    organizationId: m.organizationId,
    locationId: m.locationId,
  };
  const technicianId = String(formData.get('technicianId') ?? '');
  if (!isUuid(technicianId)) return { error: 'unknown_technician' };
  const profile = profileFromForm(formData);
  if (profile.skillCategoryIds?.some((id) => !isUuid(id))) return { error: 'unknown_category' };
  const result = await saveProfile(db(), { actor: me, technicianId, profile });
  revalidatePath(`/admin/staff/${technicianId}`);
  revalidatePath('/admin/staff');
  revalidatePath('/admin');
  return result.ok ? { saved: true } : { error: result.reason };
}

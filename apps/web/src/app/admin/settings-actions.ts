'use server';

import { setCheckoutList } from '@turn/db/checkout';
import { setReceptionistSeesPhone } from '@turn/db/clients';
import { revalidatePath } from 'next/cache';
import { guarded } from '@/lib/action';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';

export type SwitchState = { saved?: boolean; error?: string; ref?: string };

async function owner() {
  const actor = await requireActor();
  const m = membershipWith(actor, 'manage_rules');
  if (!m) return null;
  return {
    userId: actor.userId,
    role: m.role,
    organizationId: m.organizationId,
    locationId: m.locationId,
  };
}

/** v0.18.0 (F1): the owner turns the board's "To check out" list on or off. */
export async function checkoutListAction(
  _prev: SwitchState,
  formData: FormData,
): Promise<SwitchState> {
  return guarded('checkoutListAction', { error: 'server' } as SwitchState, async () => {
    const actor = await owner();
    if (!actor) return { error: 'not_allowed' };
    const r = await setCheckoutList(db(), { actor, on: formData.get('on') === 'on' });
    revalidatePath('/admin');
    revalidatePath('/admin/rules');
    return r.ok ? { saved: true } : { error: r.reason };
  });
}

/** v0.18.0 (Duong, 2026-11-13): receptionists see whole client phone numbers,
 *  or, switched off, the last four with "Show" (v0.17.1). */
export async function phoneSettingAction(
  _prev: SwitchState,
  formData: FormData,
): Promise<SwitchState> {
  return guarded('phoneSettingAction', { error: 'server' } as SwitchState, async () => {
    const actor = await owner();
    if (!actor) return { error: 'not_allowed' };
    const r = await setReceptionistSeesPhone(db(), { actor, on: formData.get('on') === 'on' });
    revalidatePath('/admin/staff');
    revalidatePath('/admin/clients');
    return r.ok ? { saved: true } : { error: r.reason };
  });
}

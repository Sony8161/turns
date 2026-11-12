'use server';

import { setReceptionistEdits } from '@turn/db/tech-settings';
import { revalidatePath } from 'next/cache';
import { guarded } from '@/lib/action';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';

export type ToggleState = { saved?: boolean; error?: string; ref?: string };

/** The owner switches receptionist edits of technicians on or off (audited). */
export async function receptionistEditsAction(
  prev: ToggleState,
  formData: FormData,
): Promise<ToggleState> {
  return guarded('receptionistEditsAction', { error: 'server' } as ToggleState, async () => {
    const actor = await requireActor();
    const m = membershipWith(actor, 'manage_rules');
    if (!m) return { error: 'not_allowed' };
    const r = await setReceptionistEdits(db(), {
      actor: {
        userId: actor.userId,
        role: m.role,
        organizationId: m.organizationId,
        locationId: m.locationId,
      },
      on: formData.get('on') === 'on',
    });
    revalidatePath('/admin/staff');
    revalidatePath('/admin');
    return r.ok ? { saved: true } : { error: r.reason };
  });
}

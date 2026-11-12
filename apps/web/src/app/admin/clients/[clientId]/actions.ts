'use server';

import { updateClient } from '@turn/db/clients';
import { revalidatePath } from 'next/cache';
import { guarded } from '@/lib/action';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { isUuid } from '@/lib/ids';

export type ClientState = { saved?: boolean; error?: string; ref?: string };

/** Saves a client's names and notes. Location from the membership (T10). */
export async function saveClientAction(
  prev: ClientState,
  formData: FormData,
): Promise<ClientState> {
  return guarded('saveClientAction', { error: 'server' } as ClientState, async () => {
    const actor = await requireActor();
    const m = membershipWith(actor, 'enter_walkins');
    if (!m) return { error: 'not_allowed' };
    const clientId = String(formData.get('clientId') ?? '');
    if (!isUuid(clientId)) return { error: 'unknown_client' };
    const r = await updateClient(db(), {
      actor: { userId: actor.userId, organizationId: m.organizationId, locationId: m.locationId },
      clientId,
      firstName: String(formData.get('firstName') ?? ''),
      lastName: String(formData.get('lastName') ?? ''),
      notes: String(formData.get('notes') ?? ''),
    });
    revalidatePath(`/admin/clients/${clientId}`);
    return r.ok ? { saved: true } : { error: r.reason };
  });
}

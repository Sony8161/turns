'use server';

import { revealClientPhone, updateClient } from '@turn/db/clients';
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

export type ShowPhoneState = { phone?: string; error?: string; ref?: string };

/** v0.17.1 (review #4): "Show" on a masked phone. Counted against the same
 *  per-person limit as search and audited (no number in the audit row).
 *  Role and location from the membership (T10). */
export async function showClientPhone(clientId: string): Promise<ShowPhoneState> {
  return guarded('showClientPhone', { error: 'server' } as ShowPhoneState, async () => {
    const actor = await requireActor();
    const m = membershipWith(actor, 'view_board');
    if (!m) return { error: 'not_allowed' };
    if (!isUuid(clientId)) return { error: 'unknown_client' };
    const r = await revealClientPhone(db(), {
      viewer: {
        userId: actor.userId,
        role: m.role,
        organizationId: m.organizationId,
        locationId: m.locationId,
      },
      clientId,
    });
    if (!r.ok) return { error: r.reason };
    return { phone: r.phone ? r.phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3') : '' };
  });
}

'use server';

import type { StaffActor } from '@turn/db/staff';
import {
  STAFF_STATUS_MOVES,
  staffAdjustPoints,
  staffSetStatus,
  type StaffStatusMove,
} from '@turn/db/tech-settings';
import { revalidatePath } from 'next/cache';
import { guarded } from '@/lib/action';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { isUuid } from '@/lib/ids';

export type TodayState = { ref?: string; error?: string; done?: 'status' | 'adjust' };

const HALF_STEPS = new Set(['-2', '-1.5', '-1', '-0.5', '0.5', '1', '1.5', '2']);

/** Today's status and a points adjustment for one technician (v0.13.0).
 *  Who may is decided next to the write (tech-settings.ts); the role and
 *  location come from the membership, never from the form (T10). */
export async function techTodayAction(prev: TodayState, formData: FormData): Promise<TodayState> {
  return guarded('techTodayAction', { error: 'server' } as TodayState, () => run(prev, formData));
}

async function run(_prev: TodayState, formData: FormData): Promise<TodayState> {
  const actor = await requireActor();
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
  const intent = String(formData.get('intent') ?? '');
  let result: { ok: true } | { ok: false; reason: string };
  let done: TodayState['done'];
  if (intent === 'status') {
    const to = String(formData.get('to') ?? '') as StaffStatusMove;
    if (!STAFF_STATUS_MOVES.includes(to)) return { error: 'bad_input' };
    result = await staffSetStatus(db(), { actor: me, technicianId, to });
    done = 'status';
  } else if (intent === 'adjust') {
    const raw = String(formData.get('delta') ?? '');
    if (!HALF_STEPS.has(raw)) return { error: 'bad_delta' };
    result = await staffAdjustPoints(db(), {
      actor: me,
      technicianId,
      delta: Number(raw),
      reason: String(formData.get('reason') ?? ''),
    });
    done = 'adjust';
  } else {
    return { error: 'bad_input' };
  }
  revalidatePath(`/admin/staff/${technicianId}`);
  revalidatePath('/admin');
  revalidatePath('/me');
  return result.ok ? { done } : { error: result.reason };
}

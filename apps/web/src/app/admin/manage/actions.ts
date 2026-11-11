'use server';

import {
  adjustPoints,
  excusePenalty,
  reassignVisit,
  type ManagerActor,
  type Skipped,
} from '@turn/db/engine';
import { revalidatePath } from 'next/cache';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { uuidOf } from '@/lib/ids';
import { can } from '@/lib/permissions';
import { toSkippedLines, type SkippedLine } from '../chips';

export type ManageState = {
  error?: string;
  detail?: string;
  /** For target_not_eligible: the target and why, in the desk's words. */
  skipped?: SkippedLine[];
  done?: 'reassign' | 'excuse' | 'adjust';
};

const HALF_STEPS = new Set(['-2', '-1.5', '-1', '-0.5', '0.5', '1', '1.5', '2']);

/** One action for the overrides screen; the form says what it wants. The
 *  manager's location comes from their membership, never from the form (T10). */
export async function manageAction(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const actor = await requireActor();
  const m = membershipWith(actor, 'override_queue');
  if (!m) return { error: 'not_allowed' };
  const me: ManagerActor = {
    userId: actor.userId,
    organizationId: m.organizationId,
    locationId: m.locationId,
  };
  const intent = String(formData.get('intent') ?? '');
  const reason = String(formData.get('reason') ?? '');
  const flag = (name: string) => formData.get(name) === 'on' || formData.get(name) === 'true';

  let result: { ok: true } | { ok: false; reason: string; detail?: string; skipped?: Skipped[] };
  let done: ManageState['done'];
  switch (intent) {
    case 'reassign': {
      if (!can(m.role, 'reassign_visit')) return { error: 'not_allowed' };
      const visitId = uuidOf(formData.get('visitId'));
      const toTechnicianId = uuidOf(formData.get('technicianId'));
      if (!visitId) return { error: 'unknown_visit' };
      if (!toTechnicianId) return { error: 'unknown_technician' };
      result = await reassignVisit(db(), {
        visitId,
        toTechnicianId,
        actor: me,
        reason,
        penalizeFirst: flag('penalizeFirst'),
        force: flag('force'),
      });
      done = 'reassign';
      break;
    }
    case 'excuse': {
      const ledgerId = uuidOf(formData.get('ledgerId'));
      if (!ledgerId) return { error: 'unknown_penalty' };
      result = await excusePenalty(db(), { ledgerId, actor: me, reason });
      done = 'excuse';
      break;
    }
    case 'adjust': {
      if (!can(m.role, 'adjust_points')) return { error: 'not_allowed' };
      const raw = String(formData.get('delta') ?? '');
      if (!HALF_STEPS.has(raw)) return { error: 'bad_delta' };
      const technicianId = uuidOf(formData.get('technicianId'));
      if (!technicianId) return { error: 'unknown_technician' };
      result = await adjustPoints(db(), {
        technicianId,
        delta: Number(raw),
        actor: me,
        reason,
      });
      done = 'adjust';
      break;
    }
    default:
      return { error: 'bad_input' };
  }
  revalidatePath('/admin/manage');
  revalidatePath('/admin');
  revalidatePath('/me');
  if (result.ok) return { done };
  return { error: result.reason, detail: result.detail, skipped: toSkippedLines(result.skipped) };
}

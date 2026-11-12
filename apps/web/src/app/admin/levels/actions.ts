'use server';

import {
  isSkillLevel,
  setServiceLevels,
  setTechnicianLevel,
  SKILL_LEVELS,
  type LevelError,
} from '@turn/db/levels';
import type { StaffActor } from '@turn/db/staff';
import { revalidatePath } from 'next/cache';
import { guarded } from '@/lib/action';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { isUuid } from '@/lib/ids';

export type LevelState = { error?: LevelError | 'server'; saved?: boolean; ref?: string };

/** The signed-in owner or manager at their own location; the engine checks
 *  the role again (levels.ts), so no screen can skip it. */
async function staffActor(): Promise<StaffActor | null> {
  const actor = await requireActor();
  const m = membershipWith(actor, 'edit_technicians');
  if (!m) return null;
  return {
    userId: actor.userId,
    role: m.role,
    organizationId: m.organizationId,
    locationId: m.locationId,
  };
}

/** A technician's level and the services ticked for them (v0.14.0). */
export async function saveTechnicianLevel(
  prev: LevelState,
  formData: FormData,
): Promise<LevelState> {
  return guarded('saveTechnicianLevel', { error: 'server' } as LevelState, () =>
    saveTechnicianLevelRun(prev, formData),
  );
}

async function saveTechnicianLevelRun(_prev: LevelState, formData: FormData): Promise<LevelState> {
  const me = await staffActor();
  if (!me) return { error: 'not_allowed' };
  const technicianId = String(formData.get('technicianId') ?? '');
  if (!isUuid(technicianId)) return { error: 'unknown_technician' };
  const raw = String(formData.get('level') ?? '');
  const level = raw === '' ? null : raw;
  if (level !== null && !isSkillLevel(level)) return { error: 'bad_level' };
  // "Tick everything for this level" sends no list: the engine pre-fills.
  const prefill = formData.get('intent') === 'fill';
  const serviceIds = formData.getAll('service').filter((v): v is string => isUuid(v));
  const result = await setTechnicianLevel(db(), {
    actor: me,
    technicianId,
    level,
    serviceIds: prefill ? null : serviceIds,
  });
  revalidatePath(`/admin/staff/${technicianId}`);
  revalidatePath('/admin');
  return result.ok ? { saved: true } : { error: result.reason };
}

/** Who gets a service by turn, its lowest level, and whether the desk picks. */
export async function saveServiceLevels(prev: LevelState, formData: FormData): Promise<LevelState> {
  return guarded('saveServiceLevels', { error: 'server' } as LevelState, () =>
    saveServiceLevelsRun(prev, formData),
  );
}

async function saveServiceLevelsRun(_prev: LevelState, formData: FormData): Promise<LevelState> {
  const me = await staffActor();
  if (!me) return { error: 'not_allowed' };
  const serviceId = String(formData.get('serviceId') ?? '');
  if (!isUuid(serviceId)) return { error: 'unknown_service' };
  const minLevel = String(formData.get('minLevel') ?? '');
  if (!isSkillLevel(minLevel)) return { error: 'bad_level' };
  const turnLevels = SKILL_LEVELS.filter((l) => formData.get(`turn.${l}`) === 'on');
  const result = await setServiceLevels(db(), {
    actor: me,
    serviceId,
    minLevel,
    turnLevels,
    deskPicks: formData.get('deskPicks') === 'on',
  });
  revalidatePath('/admin/levels');
  revalidatePath('/admin');
  return result.ok ? { saved: true } : { error: result.reason };
}

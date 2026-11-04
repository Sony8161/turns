'use server';

import { eq } from 'drizzle-orm';
import { technicianStatus } from '@turn/db';
import { checkIn, transition, type TechnicianState } from '@turn/db/status';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { requireActor } from '@/lib/auth';
import { technicianForUser } from '@/lib/technician';

export type MeState = {
  error?:
    | 'illegal_transition'
    | 'outside_geofence'
    | 'no_location_fix'
    | 'poor_location_accuracy'
    | 'not_technician';
  distanceM?: number;
  radiusM?: number;
  accuracyM?: number;
};

// The moves a technician may make for themself. "finish" ends a service (the
// design doc: in service ends when the technician taps complete); in Part 4
// it also posts the visit's points.
const TECH_MOVES = new Set(['check_in', 'available', 'break', 'out', 'off', 'finish']);

/** A technician moves their own status. The technician row comes from the
 *  session and must be active with an active membership (threat model T10). */
export async function moveStatus(_prev: MeState, formData: FormData): Promise<MeState> {
  const actor = await requireActor();
  const tech = await technicianForUser(actor.userId);
  if (!tech) return { error: 'not_technician' };

  const intent = String(formData.get('intent') ?? '');
  if (!TECH_MOVES.has(intent)) return {};

  const [current] = await db()
    .select({ status: technicianStatus.status })
    .from(technicianStatus)
    .where(eq(technicianStatus.technicianId, tech.id));
  // Leaving in_service is only through "finish" (points post there in Part 4),
  // never through a plain "available".
  if (current?.status === 'in_service' && intent !== 'finish') {
    return { error: 'illegal_transition' };
  }
  if (current?.status !== 'in_service' && intent === 'finish') {
    return { error: 'illegal_transition' };
  }

  const to = (intent === 'finish' ? 'available' : intent) as Exclude<TechnicianState, 'checked_in'>;
  const result =
    intent === 'check_in'
      ? await checkIn(db(), {
          technicianId: tech.id,
          actor: { userId: actor.userId },
          position: readPosition(formData),
        })
      : await transition(db(), {
          technicianId: tech.id,
          to,
          actor: { userId: actor.userId },
          reason: intent === 'finish' ? 'finished' : null,
        });

  revalidatePath('/me');
  revalidatePath('/admin');
  if (result.ok) return {};
  switch (result.reason) {
    case 'outside_geofence':
      return { error: result.reason, distanceM: result.distanceM, radiusM: result.radiusM };
    case 'poor_location_accuracy':
      return { error: result.reason, accuracyM: result.accuracyM, radiusM: result.radiusM };
    case 'unknown_technician':
      return { error: 'not_technician' };
    default:
      return { error: result.reason };
  }
}

function readPosition(formData: FormData): { lat: number; lng: number; accuracyM?: number } | null {
  const lat = Number(formData.get('lat'));
  const lng = Number(formData.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  const accuracyM = Number(formData.get('accuracy'));
  return { lat, lng, accuracyM: Number.isFinite(accuracyM) ? accuracyM : undefined };
}

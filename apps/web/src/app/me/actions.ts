'use server';

import { eq } from 'drizzle-orm';
import { technicianStatus } from '@turn/db';
import { DENY_REASONS, finishVisit, respondToCall, type DenyReason } from '@turn/db/engine';
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
    | 'not_technician'
    | 'not_your_call'
    | 'already_answered'
    | 'no_visit_in_service';
  distanceM?: number;
  radiusM?: number;
  accuracyM?: number;
};

// The moves a technician may make for themself. "finish" ends the service they
// are in: points post and they are back in line.
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
  // Leaving in_service is only through "finish", never through a plain move.
  if (current?.status === 'in_service' && intent !== 'finish') {
    return { error: 'illegal_transition' };
  }

  if (intent === 'finish') {
    const done = await finishVisit(db(), {
      technicianId: tech.id,
      actor: { userId: actor.userId },
    });
    revalidatePath('/me');
    revalidatePath('/admin');
    return done.ok ? {} : { error: 'no_visit_in_service' };
  }

  const result =
    intent === 'check_in'
      ? await checkIn(db(), {
          technicianId: tech.id,
          actor: { userId: actor.userId },
          position: readPosition(formData),
        })
      : await transition(db(), {
          technicianId: tech.id,
          to: intent as Exclude<TechnicianState, 'checked_in'>,
          actor: { userId: actor.userId },
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

/** Accept or deny the call on this technician's phone. The call must be theirs. */
export async function answerCall(_prev: MeState, formData: FormData): Promise<MeState> {
  const actor = await requireActor();
  const tech = await technicianForUser(actor.userId);
  if (!tech) return { error: 'not_technician' };
  const callId = String(formData.get('callId') ?? '');
  const intent = String(formData.get('intent') ?? '');
  const deny = intent.startsWith('deny:') ? intent.slice(5) : null;
  if (deny && !(DENY_REASONS as readonly string[]).includes(deny)) return {};

  const result = await respondToCall(db(), {
    callId,
    technicianId: tech.id,
    response: deny ? 'denied' : 'accepted',
    denyReason: (deny ?? undefined) as DenyReason | undefined,
    actor: { userId: actor.userId },
  });
  revalidatePath('/me');
  revalidatePath('/admin');
  if (result.ok) return {};
  if (result.reason === 'not_your_call' || result.reason === 'already_answered') {
    return { error: result.reason };
  }
  return { error: 'illegal_transition' };
}

function readPosition(formData: FormData): { lat: number; lng: number; accuracyM?: number } | null {
  const lat = Number(formData.get('lat'));
  const lng = Number(formData.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  const accuracyM = Number(formData.get('accuracy'));
  return { lat, lng, accuracyM: Number.isFinite(accuracyM) ? accuracyM : undefined };
}

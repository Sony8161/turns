'use server';

import { eq } from 'drizzle-orm';
import { technicianStatus } from '@turn/db';
import {
  clientLeft,
  DENY_REASONS,
  finishVisit,
  respondToCall,
  type DenyReason,
} from '@turn/db/engine';
import { askForHelp } from '@turn/db/help';
import { checkIn, transition, type TechnicianState } from '@turn/db/status';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { requireActor } from '@/lib/auth';
import { technicianForUser } from '@/lib/technician';
import { guarded } from '@/lib/action';
import { isUuid } from '@/lib/ids';

export type MeState = {
  /** Reference shown for an unplanned failure (v0.10.1). */
  ref?: string;
  error?:
    | 'illegal_transition'
    | 'outside_geofence'
    | 'no_location_fix'
    | 'poor_location_accuracy'
    | 'not_technician'
    | 'not_your_call'
    | 'already_answered'
    | 'no_visit_in_service'
    | 'open_call'
    | 'bad_split'
    | 'too_many'
    | 'not_called'
    | 'server';
  distanceM?: number;
  radiusM?: number;
  accuracyM?: number;
};

// The moves a technician may make for themself. "finish" ends the service they
// are in: points post and they are back in line.
const TECH_MOVES = new Set(['check_in', 'available', 'break', 'out', 'off', 'finish']);

/** A technician moves their own status. The technician row comes from the
 *  session and must be active with an active membership (threat model T10). */
export async function moveStatus(prev: MeState, formData: FormData): Promise<MeState> {
  return guarded('moveStatus', { error: 'server' } as MeState, () => moveStatusRun(prev, formData));
}

async function moveStatusRun(_prev: MeState, formData: FormData): Promise<MeState> {
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
export async function answerCall(prev: MeState, formData: FormData): Promise<MeState> {
  return guarded('answerCall', { error: 'server' } as MeState, () => answerCallRun(prev, formData));
}

async function answerCallRun(_prev: MeState, formData: FormData): Promise<MeState> {
  const actor = await requireActor();
  const tech = await technicianForUser(actor.userId);
  if (!tech) return { error: 'not_technician' };
  const callId = String(formData.get('callId') ?? '');
  const intent = String(formData.get('intent') ?? '');
  // v0.14.0: "decline" answers an offer or a desk pick (never a penalty; the
  // engine decides that from the call, not from this word).
  const deny = intent === 'decline' ? 'other' : intent.startsWith('deny:') ? intent.slice(5) : null;
  if (deny && !(DENY_REASONS as readonly string[]).includes(deny)) return {};
  // "split": the services this technician keeps; the rest go back to the line.
  const keep =
    intent === 'split'
      ? formData.getAll('keep').filter((v): v is string => typeof v === 'string' && isUuid(v))
      : undefined;
  if (keep && keep.length === 0) return { error: 'bad_split' };

  const result = await respondToCall(db(), {
    callId,
    technicianId: tech.id,
    response: deny ? 'denied' : 'accepted',
    denyReason: (deny ?? undefined) as DenyReason | undefined,
    ...(keep ? { keepServiceIds: keep } : {}),
    actor: { userId: actor.userId },
  });
  revalidatePath('/me');
  revalidatePath('/admin');
  if (result.ok) return {};
  if (
    result.reason === 'not_your_call' ||
    result.reason === 'already_answered' ||
    result.reason === 'bad_split'
  ) {
    return { error: result.reason };
  }
  return { error: 'illegal_transition' };
}

/** v0.16.0: the called technician marks that the client left before she started. */
export async function markClientLeft(prev: MeState, formData: FormData): Promise<MeState> {
  return guarded('markClientLeft', { error: 'server' } as MeState, () =>
    markClientLeftRun(prev, formData),
  );
}

async function markClientLeftRun(_prev: MeState, formData: FormData): Promise<MeState> {
  const actor = await requireActor();
  const tech = await technicianForUser(actor.userId);
  if (!tech) return { error: 'not_technician' };
  const visitId = String(formData.get('visitId') ?? '');
  if (!isUuid(visitId)) return { error: 'not_called' };
  const result = await clientLeft(db(), {
    visitId,
    actor: { userId: actor.userId },
    locationId: tech.locationId,
    technicianId: tech.id,
  });
  revalidatePath('/me');
  revalidatePath('/admin');
  if (result.ok) return {};
  return { error: result.reason === 'not_your_call' ? 'not_your_call' : 'not_called' };
}

/** v0.16.0: "Need help": the desk board shows it until someone acknowledges it. */
export async function askHelp(prev: MeState, formData: FormData): Promise<MeState> {
  return guarded('askHelp', { error: 'server' } as MeState, () => askHelpRun(prev, formData));
}

async function askHelpRun(_prev: MeState, formData: FormData): Promise<MeState> {
  const actor = await requireActor();
  const tech = await technicianForUser(actor.userId);
  if (!tech) return { error: 'not_technician' };
  const result = await askForHelp(db(), {
    technicianId: tech.id,
    actor: { userId: actor.userId },
    reason: String(formData.get('reason') ?? '').slice(0, 200),
  });
  revalidatePath('/me');
  revalidatePath('/admin');
  if (result.ok) return {};
  return { error: result.reason === 'too_many' ? 'too_many' : 'not_technician' };
}

function readPosition(formData: FormData): { lat: number; lng: number; accuracyM?: number } | null {
  const lat = Number(formData.get('lat'));
  const lng = Number(formData.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  const accuracyM = Number(formData.get('accuracy'));
  return { lat, lng, accuracyM: Number.isFinite(accuracyM) ? accuracyM : undefined };
}

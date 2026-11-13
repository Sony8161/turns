'use server';

import {
  addAppointment,
  appointmentArrived,
  cancelAppointment,
  markNoShow,
  editAppointment,
  type DeskActor,
} from '@turn/db/appointments';
import { callNext } from '@turn/db/engine';
import { pollFeeds, removeFeed, setFeed } from '@turn/db/feeds';
import { locations } from '@turn/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { membershipWith, requireActor, type Membership } from '@/lib/auth';
import { db } from '@/lib/db';
import { uuidOf } from '@/lib/ids';
import { can } from '@/lib/permissions';
import { appointmentFromForm } from './form';
import { guarded } from '@/lib/action';

export type AppointmentsState = {
  /** Reference shown for an unplanned failure (v0.10.1). */
  ref?: string;
  error?: string;
  detail?: string;
  done?: string;
  /** For "arrived": who the visit went to. */
  name?: string;
  polled?: number;
  failed?: number;
};

async function timezoneOf(locationId: string): Promise<string> {
  const [l] = await db()
    .select({ timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, locationId));
  return l?.timezone ?? 'America/New_York';
}

function deskActor(userId: string, m: Membership): DeskActor {
  return { userId, organizationId: m.organizationId, locationId: m.locationId };
}

function refresh() {
  revalidatePath('/admin/appointments');
  revalidatePath('/admin');
  revalidatePath('/me');
}

/** Feed URL problems share a few names with appointment errors; keep them apart. */
const feedReason = (r: string) => (r === 'too_long' ? 'too_long_url' : r);

/**
 * One action for the appointments screen; the form says what it wants. The
 * location always comes from the membership, never from the form (T10). The
 * desk roles (enter_walkins) handle appointments; only the owner sets a
 * calendar link (T13).
 */
export async function appointmentsAction(
  _prev: AppointmentsState,
  formData: FormData,
): Promise<AppointmentsState> {
  return guarded('appointmentsAction', { error: 'server' } as AppointmentsState, () =>
    appointmentsActionRun(_prev, formData),
  );
}

async function appointmentsActionRun(
  _prev: AppointmentsState,
  formData: FormData,
): Promise<AppointmentsState> {
  const actor = await requireActor();
  const m = membershipWith(actor, 'enter_walkins');
  if (!m) return { error: 'not_allowed' };
  const me = deskActor(actor.userId, m);
  const intent = String(formData.get('intent') ?? '');

  switch (intent) {
    case 'add': {
      const f = appointmentFromForm(formData, await timezoneOf(m.locationId));
      if (!f.ok) return { error: f.error };
      const r = await addAppointment(db(), { actor: me, ...f });
      refresh();
      return r.ok ? { done: 'added' } : { error: r.reason };
    }
    case 'change': {
      const appointmentId = uuidOf(formData.get('appointmentId'));
      if (!appointmentId) return { error: 'unknown_appointment' };
      const f = appointmentFromForm(formData, await timezoneOf(m.locationId));
      if (!f.ok) return { error: f.error };
      const r = await editAppointment(db(), { actor: me, appointmentId, ...f });
      refresh();
      return r.ok ? { done: 'changed' } : { error: r.reason };
    }
    case 'cancel': {
      const appointmentId = uuidOf(formData.get('appointmentId'));
      if (!appointmentId) return { error: 'unknown_appointment' };
      const r = await cancelAppointment(db(), {
        actor: me,
        appointmentId,
        reason: String(formData.get('reason') ?? ''),
      });
      refresh();
      return r.ok ? { done: 'cancelled' } : { error: r.reason };
    }
    case 'no_show': {
      // v0.17.0 (WALK-001): nobody's points change; the tech is free again.
      const appointmentId = uuidOf(formData.get('appointmentId'));
      if (!appointmentId) return { error: 'unknown_appointment' };
      const r = await markNoShow(db(), { actor: me, appointmentId });
      refresh();
      return r.ok ? { done: 'no_show' } : { error: r.reason };
    }
    case 'arrived': {
      const appointmentId = uuidOf(formData.get('appointmentId'));
      if (!appointmentId) return { error: 'unknown_appointment' };
      const serviceIds = formData
        .getAll('service')
        .map(uuidOf)
        .filter((x): x is string => x !== null);
      const r = await appointmentArrived(db(), { actor: me, appointmentId, serviceIds });
      if (!r.ok) {
        refresh();
        return { error: r.reason };
      }
      // Call the booked technician straight away; when they cannot take it the
      // visit waits on the board and the desk sees why.
      const call = can(m.role, 'call_technician')
        ? await callNext(db(), {
            visitId: r.visitId,
            actor: { userId: actor.userId },
            locationId: m.locationId,
          })
        : null;
      refresh();
      if (call && !call.ok) return { error: call.reason, detail: call.detail };
      return { done: 'arrived', name: String(formData.get('technicianName') ?? '') };
    }
    case 'sync': {
      const r = await pollFeeds(db(), {
        locationId: m.locationId,
        force: true,
        actorUserId: actor.userId,
      });
      refresh();
      return { done: 'synced', polled: r.polled, failed: r.failed };
    }
    case 'setFeed':
    case 'removeFeed': {
      if (!can(m.role, 'manage_rules')) return { error: 'not_allowed' };
      const owner = membershipWith(actor, 'manage_rules');
      if (!owner || owner.locationId !== m.locationId) return { error: 'not_allowed' };
      const technicianId = uuidOf(formData.get('technicianId'));
      if (!technicianId) return { error: 'unknown_technician' };
      const staff = {
        userId: actor.userId,
        role: owner.role,
        organizationId: owner.organizationId,
        locationId: owner.locationId,
      };
      const r =
        intent === 'setFeed'
          ? await setFeed(db(), {
              actor: staff,
              technicianId,
              url: String(formData.get('url') ?? ''),
            })
          : await removeFeed(db(), { actor: staff, technicianId });
      refresh();
      if (!r.ok) return { error: feedReason(r.reason) };
      return { done: intent === 'setFeed' ? 'feedSet' : 'feedRemoved' };
    }
    default:
      return { error: 'not_allowed' };
  }
}

'use server';
// Connect Fresha (v0.11.0): test a calendar link without saving it, save it,
// disconnect it. Two callers: the owner, for any technician at their location
// (setup step and Appointments), and a technician, for their own row only
// (after joining, and /me/calendar). Who and where always come from the
// session, never from the form (T10). Fresha links only from these screens.
// The URL goes in, never back out: results carry counts and names (T14).
import { feedHosts, removeFeed, setFeed, syncFeed } from '@turn/db/feeds';
import { feedStateFor, testFeedLink } from '@turn/db/fresha';
import { consumeRateLimit } from '@turn/db/rate-limit';
import type { StaffActor } from '@turn/db/staff';
import { revalidatePath } from 'next/cache';
import { guarded } from './action';
import { membershipWith, requireActor } from './auth';
import { db } from './db';
import { uuidOf } from './ids';
import { technicianForUser } from './technician';

export type CalendarMode = 'owner' | 'self';

export type CalendarTestState =
  | {
      ok: true;
      upcoming: number;
      calendarName: string | null;
      suggestedTechnicianId: string | null;
    }
  | { ok: false; error: string; ref?: string };

export type CalendarSaveState =
  | {
      ok: true;
      synced: boolean;
      upcoming: number;
      /** v0.17.1: her own link waits for the owner or a manager (nothing synced). */
      pending?: boolean;
    }
  | { ok: false; error: string; ref?: string };

export type CalendarRemoveState = { ok: true } | { ok: false; error: string; ref?: string };

const MAX_URL = 2048;
// Each test or save fetches from Fresha: per person, not per screen.
const TRIES = 20;
const WINDOW_S = 15 * 60;

async function who(
  mode: CalendarMode,
  rawTechnicianId: unknown,
): Promise<{ actor: StaffActor; technicianId: string | undefined } | { error: string }> {
  const session = await requireActor();
  if (mode === 'self') {
    const tech = await technicianForUser(session.userId);
    if (!tech) return { error: 'not_allowed' };
    return {
      actor: {
        userId: session.userId,
        role: 'technician',
        organizationId: tech.organizationId,
        locationId: tech.locationId,
      },
      technicianId: tech.id,
    };
  }
  const m = membershipWith(session, 'manage_rules');
  if (!m || m.role !== 'owner') return { error: 'not_allowed' };
  const technicianId = rawTechnicianId === undefined ? undefined : uuidOf(rawTechnicianId);
  if (rawTechnicianId !== undefined && !technicianId) return { error: 'unknown_technician' };
  return {
    actor: {
      userId: session.userId,
      role: 'owner',
      organizationId: m.organizationId,
      locationId: m.locationId,
    },
    technicianId: technicianId ?? undefined,
  };
}

async function allowed(userId: string): Promise<boolean> {
  const r = await consumeRateLimit(db(), `feedlink:user:${userId}`, TRIES, WINDOW_S);
  return r.allowed;
}

function refresh() {
  for (const p of ['/admin/appointments', '/admin', '/me', '/me/calendar', '/setup/calendars']) {
    revalidatePath(p);
  }
}

const urlOf = (raw: unknown) => (typeof raw === 'string' ? raw.trim().slice(0, MAX_URL + 1) : '');

export async function testCalendarLink(input: {
  mode: CalendarMode;
  technicianId?: string;
  url: string;
}): Promise<CalendarTestState> {
  return guarded(
    'testCalendarLink',
    { ok: false, error: 'server' } as CalendarTestState,
    async () => {
      const w = await who(input.mode, input.technicianId);
      if ('error' in w) return { ok: false, error: w.error };
      if (!(await allowed(w.actor.userId))) return { ok: false, error: 'too_many' };
      const r = await testFeedLink(db(), {
        actor: w.actor,
        technicianId: w.technicianId,
        url: urlOf(input.url),
        hosts: feedHosts(),
      });
      return r.ok ? r : { ok: false, error: r.reason };
    },
  );
}

export async function saveCalendarLink(input: {
  mode: CalendarMode;
  technicianId?: string;
  url: string;
}): Promise<CalendarSaveState> {
  return guarded(
    'saveCalendarLink',
    { ok: false, error: 'server' } as CalendarSaveState,
    async () => {
      const w = await who(input.mode, input.technicianId);
      if ('error' in w) return { ok: false, error: w.error };
      if (!w.technicianId) return { ok: false, error: 'unknown_technician' };
      if (!(await allowed(w.actor.userId))) return { ok: false, error: 'too_many' };
      const r = await setFeed(db(), {
        actor: w.actor,
        technicianId: w.technicianId,
        url: urlOf(input.url),
        hosts: feedHosts(),
      });
      if (!r.ok) return { ok: false, error: r.reason };
      // v0.17.1 (review #6): waiting for the owner or a manager: nothing to sync.
      if (r.pending) {
        refresh();
        return { ok: true, synced: false, upcoming: 0, pending: true };
      }
      // Sync now, so the appointments are there when the screen comes back; the
      // cron keeps it in step after that. A failed first sync is not a failed save.
      let synced = false;
      let upcoming = 0;
      try {
        const s = await syncFeed(db(), { feedId: r.feedId, actorUserId: w.actor.userId });
        if (s.ok) {
          synced = true;
          upcoming = (await feedStateFor(db(), w.technicianId)).upcoming ?? 0;
        }
      } catch {
        synced = false;
      }
      refresh();
      return { ok: true, synced, upcoming };
    },
  );
}

export async function removeCalendarLink(input: {
  mode: CalendarMode;
  technicianId?: string;
}): Promise<CalendarRemoveState> {
  return guarded(
    'removeCalendarLink',
    { ok: false, error: 'server' } as CalendarRemoveState,
    async () => {
      const w = await who(input.mode, input.technicianId);
      if ('error' in w) return { ok: false, error: w.error };
      if (!w.technicianId) return { ok: false, error: 'unknown_technician' };
      const r = await removeFeed(db(), { actor: w.actor, technicianId: w.technicianId });
      refresh();
      return r.ok ? { ok: true } : { ok: false, error: r.reason };
    },
  );
}

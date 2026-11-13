// Connect Fresha (v0.11.0): the onboarding side of calendar feeds. Test a
// link without saving it, read the calendar's name, suggest whose calendar it
// is. Server only. The URL never leaves the server: results carry a count, the
// calendar's display name and a technician id, never the link (T14). The fetch
// is the same pinned, size- and time-limited one the poll uses (T13).
import { and, asc, count, eq, gt, isNull } from 'drizzle-orm';
import {
  FEED_AHEAD_DAYS,
  FEED_PAST_HOURS,
  FEED_STALE_MIN,
  calendarName,
  checkFreshaUrl,
  feedFetcher,
  feedHosts,
  feedTechnician,
  locationZone,
  parseIcs,
  suggestTechnician,
  type FetchOptions,
  type FetchText,
} from './feeds';
import { appointments, calendarFeeds, technicians } from './schema';
import type { Db } from './server';
import type { StaffActor } from './staff';
import { writeAudit } from './status';

// v0.17.1: the calendar name helpers live with the feeds now (a technician's
// own link may have to carry her name, feeds.setFeed); re-exported here.
export { calendarName, normalizeName, suggestTechnician } from './feeds';

export type FeedTestResult =
  | {
      ok: true;
      /** Open appointments still to come in the sync window. */
      upcoming: number;
      calendarName: string | null;
      /** The owner only; a technician is not told about other people. */
      suggestedTechnicianId: string | null;
    }
  | { ok: false; reason: string };

/**
 * Fetches and reads a link without saving it. The owner may test any link
 * (optionally for a technician at their location); a technician only for
 * their own row. Every test writes a `feed_tested` row with the outcome and
 * never the URL.
 */
export async function testFeedLink(
  db: Db,
  input: {
    actor: StaffActor;
    url: string;
    technicianId?: string;
    fetchText?: FetchText;
    /** v0.17.1: test hooks for the real fetch (every hop checked). */
    fetchOptions?: FetchOptions;
    hosts?: string[];
    now?: Date;
  },
): Promise<FeedTestResult> {
  const { actor } = input;
  const now = input.now ?? new Date();
  if (actor.role !== 'owner' && actor.role !== 'technician') {
    return { ok: false, reason: 'not_allowed' };
  }
  if (actor.role === 'technician' && !input.technicianId) {
    return { ok: false, reason: 'not_allowed' };
  }
  if (input.technicianId) {
    const tech = await feedTechnician(db, actor, input.technicianId);
    if ('error' in tech) return { ok: false, reason: tech.error };
  }

  const result = await runTest(db, input, now);
  await db.transaction((tx) =>
    writeAudit(tx, {
      organizationId: actor.organizationId,
      locationId: actor.locationId,
      actorUserId: actor.userId,
      entityType: 'calendar_feeds',
      entityId: null,
      action: 'feed_tested',
      after: {
        technicianId: input.technicianId ?? null,
        result: result.ok ? 'ok' : result.reason,
        upcoming: result.ok ? result.upcoming : null,
        by: actor.role,
      },
    }),
  );
  return result;
}

async function runTest(
  db: Db,
  input: {
    actor: StaffActor;
    url: string;
    fetchText?: FetchText;
    fetchOptions?: FetchOptions;
    hosts?: string[];
  },
  now: Date,
): Promise<FeedTestResult> {
  const hosts = input.hosts ?? feedHosts();
  const checked = checkFreshaUrl(input.url, hosts);
  if (!checked.ok) return { ok: false, reason: checked.problem };
  // v0.17.1 (review #7): every redirect hop must stay on the host list too.
  const fetched = await (input.fetchText ?? feedFetcher(hosts, input.fetchOptions))(
    checked.url.toString(),
  );
  if (!fetched.ok) return { ok: false, reason: fetched.error };
  const zone = await locationZone(db, input.actor.locationId);
  const from = new Date(now.getTime() - FEED_PAST_HOURS * 3_600_000);
  const to = new Date(now.getTime() + FEED_AHEAD_DAYS * 86_400_000);
  const parsed = parseIcs(fetched.text, zone, { from, to });
  if (!parsed.ok) return { ok: false, reason: parsed.error };
  const upcoming = parsed.events.filter((e) => !e.cancelled && e.endAt > now).length;
  const name = calendarName(fetched.text);
  let suggestedTechnicianId: string | null = null;
  if (input.actor.role === 'owner') {
    const techs = await db
      .select({ id: technicians.id, name: technicians.displayName })
      .from(technicians)
      .where(
        and(
          eq(technicians.locationId, input.actor.locationId),
          eq(technicians.organizationId, input.actor.organizationId),
          eq(technicians.active, true),
        ),
      )
      .orderBy(asc(technicians.displayName));
    suggestedTechnicianId = suggestTechnician(name, techs);
  }
  return { ok: true, upcoming, calendarName: name, suggestedTechnicianId };
}

export type OwnFeedState = {
  connected: boolean;
  /** v0.17.1: her link waits for the owner or a manager; nothing is fetched. */
  pending: boolean;
  lastSyncedAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  /** Open appointments still to come that this calendar brought in. */
  upcoming: number | null;
  stale: boolean;
};

/** One technician's calendar state, for their own screen. Never the URL or
 *  even the hint: a technician sees "connected" and when it last synced. */
export async function feedStateFor(
  db: Db,
  technicianId: string,
  now = new Date(),
): Promise<OwnFeedState> {
  const [f] = await db
    .select({
      id: calendarFeeds.id,
      lastSyncedAt: calendarFeeds.lastSyncedAt,
      lastAttemptAt: calendarFeeds.lastAttemptAt,
      lastError: calendarFeeds.lastError,
      needsApproval: calendarFeeds.needsApproval,
    })
    .from(calendarFeeds)
    .where(and(eq(calendarFeeds.technicianId, technicianId), isNull(calendarFeeds.archivedAt)));
  if (!f) {
    return {
      connected: false,
      pending: false,
      lastSyncedAt: null,
      lastAttemptAt: null,
      lastError: null,
      upcoming: null,
      stale: false,
    };
  }
  const [open] = await db
    .select({ n: count() })
    .from(appointments)
    .where(
      and(
        eq(appointments.feedId, f.id),
        isNull(appointments.cancelledAt),
        isNull(appointments.arrivedAt),
        gt(appointments.endAt, now),
      ),
    );
  const staleBefore = now.getTime() - FEED_STALE_MIN * 60_000;
  return {
    connected: true,
    pending: f.needsApproval,
    lastSyncedAt: f.lastSyncedAt,
    lastAttemptAt: f.lastAttemptAt,
    lastError: f.lastError,
    upcoming: f.lastSyncedAt ? Number(open?.n ?? 0) : null,
    stale: !f.needsApproval && (!f.lastSyncedAt || f.lastSyncedAt.getTime() < staleBefore),
  };
}

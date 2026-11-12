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
  checkFreshaUrl,
  feedHosts,
  feedTechnician,
  locationZone,
  parseIcs,
  safeFetchText,
  type FetchText,
} from './feeds';
import { appointments, calendarFeeds, technicians } from './schema';
import type { Db } from './server';
import type { StaffActor } from './staff';
import { writeAudit } from './status';

const MAX_CAL_NAME = 120;

/** X-WR-CALNAME, unfolded and unescaped, or null. Fresha names it
 *  "Fresha - <TEAM MEMBER>  <Business>". */
export function calendarName(text: string): string | null {
  const unfolded = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
  const m = /^X-WR-CALNAME(?:;[^:\n]*)?:(.*)$/im.exec(unfolded);
  if (!m) return null;
  const value = m[1]!
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .trim()
    .slice(0, MAX_CAL_NAME);
  return value || null;
}

/** Lower case, no accents (đ as d), letters and digits only, single spaces. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The technician a calendar most likely belongs to, or null. Every word of
 * the technician's name must appear in the calendar's name; a longer match
 * wins; a tie is no answer, because a wrong suggestion is worse than none.
 * Only a suggestion: the owner confirms before anything is saved.
 */
export function suggestTechnician(
  calName: string | null,
  techs: { id: string; name: string }[],
): string | null {
  if (!calName) return null;
  const words = new Set(
    normalizeName(calName)
      .split(' ')
      .filter((w) => w && w !== 'fresha'),
  );
  let best: string | null = null;
  let bestScore = 0;
  let tie = false;
  for (const t of techs) {
    const parts = normalizeName(t.name).split(' ').filter(Boolean);
    if (!parts.length || !parts.every((p) => words.has(p))) continue;
    const score = parts.length;
    if (score > bestScore) {
      best = t.id;
      bestScore = score;
      tie = false;
    } else if (score === bestScore) {
      tie = true;
    }
  }
  return tie ? null : best;
}

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
  input: { actor: StaffActor; url: string; fetchText?: FetchText; hosts?: string[] },
  now: Date,
): Promise<FeedTestResult> {
  const checked = checkFreshaUrl(input.url, input.hosts ?? feedHosts());
  if (!checked.ok) return { ok: false, reason: checked.problem };
  const fetched = await (input.fetchText ?? safeFetchText())(checked.url.toString());
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
    })
    .from(calendarFeeds)
    .where(and(eq(calendarFeeds.technicianId, technicianId), isNull(calendarFeeds.archivedAt)));
  if (!f) {
    return {
      connected: false,
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
    lastSyncedAt: f.lastSyncedAt,
    lastAttemptAt: f.lastAttemptAt,
    lastError: f.lastError,
    upcoming: f.lastSyncedAt ? Number(open?.n ?? 0) : null,
    stale: !f.lastSyncedAt || f.lastSyncedAt.getTime() < staleBefore,
  };
}

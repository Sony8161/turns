// Calendar feeds (Part 7): Fresha's per-team-member calendar link, polled on
// the server. Server only. Threat model T13 (the fetch can be pointed at
// internal addresses, a huge file can stall the poll, the text is untrusted),
// T14 (the URL is a secret) and T15 (a missed sync changes pay).
//
// The URL never leaves the server: not to a screen, not to the audit log, not
// to an error message. Screens get `url_hint` and the sync state.
import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { appointments, calendarFeeds, locations, technicians } from './schema';
import type { Db } from './server';
import type { StaffActor } from './staff';
import { writeAudit } from './status';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Limits. Fresha's own sync lags up to 15 minutes (threat model Q5), so a
// faster poll gains nothing.
export const FEED_POLL_MIN = 15;
export const FEED_STALE_MIN = 45;
export const FEED_MAX_BYTES = 2 * 1024 * 1024;
export const FEED_TIMEOUT_MS = 10_000;
export const FEED_MAX_REDIRECTS = 3;
export const FEED_MAX_EVENTS = 2000;
/** The window a poll keeps in step with the feed: recent past to a month ahead. */
export const FEED_PAST_HOURS = 12;
export const FEED_AHEAD_DAYS = 31;
const MAX_URL = 2048;
const MAX_NAME = 120;
const MAX_EVENT_HOURS = 12;

// URL checks ------------------------------------------------------------------

export type UrlProblem =
  | 'not_a_url'
  | 'not_https'
  | 'has_credentials'
  | 'bad_port'
  | 'too_long'
  | 'private_address'
  | 'dns_failed';

/** Syntax only: https (webcal is an alias for it), no user:pass, port 443. */
export function checkFeedUrl(
  raw: string,
): { ok: true; url: URL } | { ok: false; problem: UrlProblem } {
  const text = raw.trim();
  if (text.length > MAX_URL) return { ok: false, problem: 'too_long' };
  let url: URL;
  try {
    url = new URL(text.replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    return { ok: false, problem: 'not_a_url' };
  }
  if (url.protocol !== 'https:') return { ok: false, problem: 'not_https' };
  if (url.username || url.password) return { ok: false, problem: 'has_credentials' };
  if (url.port && url.port !== '443') return { ok: false, problem: 'bad_port' };
  if (!url.hostname) return { ok: false, problem: 'not_a_url' };
  return { ok: true, url };
}

function v4Parts(ip: string): number[] | null {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}

function v4Public(ip: string): boolean {
  const p = v4Parts(ip);
  if (!p) return false;
  const [a, b, c] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false; // this host, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF, documentation
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Eight 16-bit groups, or null. Handles "::" and a dotted IPv4 tail. */
function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0]!;
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const p = v4Parts(tail[1]!);
    if (!p) return null;
    const hex = `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
    text = text.slice(0, -tail[1]!.length) + hex;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'),
    ...rest,
  ];
  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

function v6Public(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (g.every((x) => x === 0)) return false; // unspecified
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 1
  ) {
    return false; // loopback
  }
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return v4Public(`${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`);
  }
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x64 && g1 === 0xff9b) return false; // NAT64 (embeds an IPv4)
  if (g0 === 0x2002) return false; // 6to4 (embeds an IPv4)
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2001 && g1 === 0) return false; // Teredo (embeds an IPv4)
  return true;
}

/** True only for an address on the public internet (T13). */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Public(ip);
  if (kind === 6) return v6Public(ip);
  return false;
}

export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;

const systemResolve: Resolve = async (host) => dnsLookup(host, { all: true, verbatim: true });

/** Resolves the host and refuses it when any address is not public (a host
 *  with one private address is refused, so a mixed answer cannot slip by). */
export async function resolvePublic(
  url: URL,
  resolve: Resolve = systemResolve,
): Promise<{ ok: true; address: string; family: number } | { ok: false; problem: UrlProblem }> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let answers: { address: string; family: number }[];
  if (isIP(host)) {
    answers = [{ address: host, family: isIP(host) }];
  } else {
    try {
      answers = await resolve(host);
    } catch {
      return { ok: false, problem: 'dns_failed' };
    }
  }
  if (answers.length === 0) return { ok: false, problem: 'dns_failed' };
  if (!answers.every((a) => isPublicAddress(a.address))) {
    return { ok: false, problem: 'private_address' };
  }
  return { ok: true, address: answers[0]!.address, family: answers[0]!.family };
}

/** What the screens show instead of the URL: host and the last four characters. */
export function urlHint(url: URL): string {
  const whole = url.toString();
  return `${url.hostname} …${whole.slice(-4)}`;
}

// Fetch ------------------------------------------------------------------------

export type FetchResult = { ok: true; text: string } | { ok: false; error: string };
export type FetchText = (url: string) => Promise<FetchResult>;

/** One GET, pinned to the address that was checked, so a second DNS answer
 *  cannot swap in a private address after the check (DNS rebinding). */
function getOnce(
  url: URL,
  pinned: { address: string; family: number },
): Promise<{ status: number; location?: string; body?: string; error?: string }> {
  return new Promise((done) => {
    const lookup: LookupFunction = (_host, options, cb) => {
      if (options && typeof options === 'object' && options.all) {
        (cb as (e: null, a: { address: string; family: number }[]) => void)(null, [pinned]);
      } else {
        (cb as (e: null, a: string, f: number) => void)(null, pinned.address, pinned.family);
      }
    };
    let settled = false;
    const finish = (r: { status: number; location?: string; body?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    const req = request(
      url,
      {
        method: 'GET',
        lookup,
        headers: { accept: 'text/calendar, */*;q=0.1', 'accept-encoding': 'identity' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          finish({ status, location: res.headers.location });
          return;
        }
        if (status !== 200) {
          res.resume();
          finish({ status, error: `http_${status}` });
          return;
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > FEED_MAX_BYTES) {
          res.destroy();
          finish({ status, error: 'too_large' });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > FEED_MAX_BYTES) {
            res.destroy();
            finish({ status, error: 'too_large' });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => finish({ status, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => finish({ status, error: 'read_failed' }));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish({ status: 0, error: 'timeout' });
    }, FEED_TIMEOUT_MS);
    req.on('error', () => finish({ status: 0, error: 'connect_failed' }));
    req.end();
  });
}

/** The real fetch: every hop (redirects included) is re-checked. */
export function safeFetchText(resolve: Resolve = systemResolve): FetchText {
  return async (raw) => {
    let current = raw;
    for (let hop = 0; hop <= FEED_MAX_REDIRECTS; hop++) {
      const checked = checkFeedUrl(current);
      if (!checked.ok) return { ok: false, error: checked.problem };
      const pinned = await resolvePublic(checked.url, resolve);
      if (!pinned.ok) return { ok: false, error: pinned.problem };
      const r = await getOnce(checked.url, pinned);
      if (r.location !== undefined) {
        if (!r.location) return { ok: false, error: 'bad_redirect' };
        current = new URL(r.location, checked.url).toString();
        continue;
      }
      if (r.error) return { ok: false, error: r.error };
      return { ok: true, text: r.body ?? '' };
    }
    return { ok: false, error: 'too_many_redirects' };
  };
}

// ICS parsing --------------------------------------------------------------------

export type FeedEvent = {
  uid: string;
  startAt: Date;
  endAt: Date;
  /** SUMMARY, cleaned. Untrusted text: React escapes it on screen. */
  summary: string | null;
  cancelled: boolean;
};

/** Minutes east of UTC that `zone` is at `utcMs`. */
function zoneOffsetMs(utcMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - utcMs;
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A wall-clock time in a zone, as a UTC instant. */
export function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  zone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let at = guess - zoneOffsetMs(guess, zone);
  at = guess - zoneOffsetMs(at, zone);
  return new Date(at);
}

/** DTSTART/DTEND value to an instant; null for all-day dates and junk. */
function parseIcsDate(value: string, tzid: string | undefined, fallbackZone: string): Date | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null; // VALUE=DATE (all-day) or not a time: not an appointment
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  if (m[7] === 'Z') return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const zone = tzid && validZone(tzid) ? tzid : fallbackZone;
  return zonedToUtc(y, mo, d, h, mi, s, zone);
}

function parseDuration(value: string): number | null {
  const m = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [d, h, mi, s] = m.slice(1, 5).map((x) => Number(x ?? 0)) as [
    number,
    number,
    number,
    number,
  ];
  return ((d * 24 + h) * 60 + mi) * 60_000 + s * 1000;
}

function unescapeText(v: string): string {
  return v
    .replace(/\\[nN]/g, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Prop = { name: string; params: Record<string, string>; value: string };

function parseLine(line: string): Prop | null {
  // The value starts at the first colon that is not inside a quoted parameter.
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name!.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** Parses VEVENTs. Recurring rules are not expanded (an appointment feed has
 *  single events); all-day events are dropped. Never throws. */
export function parseIcs(
  text: string,
  fallbackZone: string,
): { ok: true; events: FeedEvent[] } | { ok: false; error: string } {
  if (!/BEGIN:VCALENDAR/i.test(text)) return { ok: false, error: 'not_a_calendar' };
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
  const events: FeedEvent[] = [];
  let current: Prop[] | null = null;
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      current = [];
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (current) {
        const e = toEvent(current, fallbackZone);
        if (e) events.push(e);
        if (events.length > FEED_MAX_EVENTS) return { ok: false, error: 'too_many_events' };
      }
      current = null;
      continue;
    }
    if (current) {
      const p = parseLine(line);
      if (p) current.push(p);
    }
  }
  return { ok: true, events };
}

function toEvent(props: Prop[], zone: string): FeedEvent | null {
  const get = (n: string) => props.find((p) => p.name === n);
  const uid = get('UID')?.value.trim();
  const dtstart = get('DTSTART');
  if (!uid || !dtstart || uid.length > 255) return null;
  const startAt = parseIcsDate(dtstart.value.trim(), dtstart.params.TZID, zone);
  if (!startAt) return null;
  const dtend = get('DTEND');
  let endAt = dtend ? parseIcsDate(dtend.value.trim(), dtend.params.TZID, zone) : null;
  if (!endAt) {
    const dur = get('DURATION');
    const ms = dur ? parseDuration(dur.value.trim()) : null;
    endAt = new Date(startAt.getTime() + (ms ?? 60 * 60_000));
  }
  const length = endAt.getTime() - startAt.getTime();
  if (length <= 0 || length > MAX_EVENT_HOURS * 3_600_000) return null;
  const summaryRaw = get('SUMMARY')?.value;
  const summary = summaryRaw ? unescapeText(summaryRaw).slice(0, MAX_NAME) || null : null;
  const cancelled = (get('STATUS')?.value.trim().toUpperCase() ?? '') === 'CANCELLED';
  return { uid, startAt, endAt, summary, cancelled };
}

// Owner settings -----------------------------------------------------------------

export type FeedError = { ok: false; reason: string };

/** The owner pastes a technician's calendar link (T13: owner only). Checked
 *  for syntax and for a public address before it is kept. */
export async function setFeed(
  db: Db,
  input: { actor: StaffActor; technicianId: string; url: string; resolve?: Resolve },
): Promise<{ ok: true; feedId: string; urlHint: string } | FeedError> {
  if (input.actor.role !== 'owner') return { ok: false, reason: 'not_allowed' };
  const checked = checkFeedUrl(input.url);
  if (!checked.ok) return { ok: false, reason: checked.problem };
  const addr = await resolvePublic(checked.url, input.resolve);
  if (!addr.ok) return { ok: false, reason: addr.problem };
  const hint = urlHint(checked.url);
  return db.transaction(async (tx) => {
    const [tech] = await tx
      .select({ id: technicians.id })
      .from(technicians)
      .where(
        and(
          eq(technicians.id, input.technicianId),
          eq(technicians.locationId, input.actor.locationId),
          eq(technicians.organizationId, input.actor.organizationId),
        ),
      );
    if (!tech) return { ok: false, reason: 'unknown_technician' };
    const now = new Date();
    const [row] = await tx
      .insert(calendarFeeds)
      .values({
        organizationId: input.actor.organizationId,
        locationId: input.actor.locationId,
        technicianId: tech.id,
        url: checked.url.toString(),
        urlHint: hint,
        createdBy: input.actor.userId,
      })
      .onConflictDoUpdate({
        target: calendarFeeds.technicianId,
        set: {
          url: checked.url.toString(),
          urlHint: hint,
          archivedAt: null,
          lastError: null,
          lastAttemptAt: null,
          updatedAt: now,
        },
      })
      .returning({ id: calendarFeeds.id });
    if (!row) throw new Error('feed upsert returned nothing');
    await writeAudit(tx, {
      organizationId: input.actor.organizationId,
      locationId: input.actor.locationId,
      actorUserId: input.actor.userId,
      entityType: 'calendar_feeds',
      entityId: row.id,
      action: 'feed_set',
      // The hint only: the URL is a secret (T14).
      after: { technicianId: tech.id, urlHint: hint },
    });
    return { ok: true, feedId: row.id, urlHint: hint };
  });
}

/** The owner removes a feed: the URL is blanked, its appointments stay. */
export async function removeFeed(
  db: Db,
  input: { actor: StaffActor; technicianId: string },
): Promise<{ ok: true } | FeedError> {
  if (input.actor.role !== 'owner') return { ok: false, reason: 'not_allowed' };
  return db.transaction(async (tx) => {
    const [feed] = await tx
      .select()
      .from(calendarFeeds)
      .where(
        and(
          eq(calendarFeeds.technicianId, input.technicianId),
          eq(calendarFeeds.locationId, input.actor.locationId),
          isNull(calendarFeeds.archivedAt),
        ),
      )
      .for('update');
    if (!feed) return { ok: false, reason: 'no_feed' };
    const now = new Date();
    await tx
      .update(calendarFeeds)
      .set({ url: '', archivedAt: now, updatedAt: now })
      .where(eq(calendarFeeds.id, feed.id));
    await writeAudit(tx, {
      organizationId: feed.organizationId,
      locationId: feed.locationId,
      actorUserId: input.actor.userId,
      entityType: 'calendar_feeds',
      entityId: feed.id,
      action: 'feed_removed',
      before: { technicianId: feed.technicianId, urlHint: feed.urlHint },
    });
    return { ok: true };
  });
}

// Sync ---------------------------------------------------------------------------

export type SyncResult =
  | { ok: true; added: number; changed: number; cancelled: number; events: number }
  | { ok: false; error: string };

async function recordFailure(
  db: Db,
  feed: typeof calendarFeeds.$inferSelect,
  error: string,
  actorUserId: string | null,
  now: Date,
): Promise<SyncResult> {
  await db.transaction(async (tx) => {
    await tx
      .update(calendarFeeds)
      .set({ lastAttemptAt: now, lastError: error, updatedAt: now })
      .where(eq(calendarFeeds.id, feed.id));
    await writeAudit(tx, {
      organizationId: feed.organizationId,
      locationId: feed.locationId,
      actorUserId,
      entityType: 'calendar_feeds',
      entityId: feed.id,
      action: 'feed_sync_failed',
      after: { technicianId: feed.technicianId, urlHint: feed.urlHint, error },
    });
  });
  return { ok: false, error };
}

/**
 * One poll of one feed. The fetch runs outside any transaction; the write
 * holds the feed row, so two polls of the same feed cannot interleave. Rows
 * already arrived (a visit exists) are never moved or cancelled by the feed.
 */
export async function syncFeed(
  db: Db,
  input: { feedId: string; fetchText?: FetchText; actorUserId?: string | null; now?: Date },
): Promise<SyncResult> {
  const now = input.now ?? new Date();
  const actorUserId = input.actorUserId ?? null;
  const [feed] = await db.select().from(calendarFeeds).where(eq(calendarFeeds.id, input.feedId));
  if (!feed || feed.archivedAt || !feed.url) return { ok: false, error: 'no_feed' };
  const zone = await locationZone(db, feed.locationId);

  const fetched = await (input.fetchText ?? safeFetchText())(feed.url);
  if (!fetched.ok) return recordFailure(db, feed, fetched.error, actorUserId, now);
  const parsed = parseIcs(fetched.text, zone);
  if (!parsed.ok) return recordFailure(db, feed, parsed.error, actorUserId, now);

  const from = new Date(now.getTime() - FEED_PAST_HOURS * 3_600_000);
  const to = new Date(now.getTime() + FEED_AHEAD_DAYS * 86_400_000);
  const inWindow = parsed.events.filter((e) => e.startAt >= from && e.startAt <= to);
  // One row per UID; the last one in the file wins.
  const byKey = new Map(inWindow.map((e) => [`${feed.id}:${e.uid}`, e]));

  return db.transaction(async (tx) => {
    const [held] = await tx
      .select({ id: calendarFeeds.id, archivedAt: calendarFeeds.archivedAt })
      .from(calendarFeeds)
      .where(eq(calendarFeeds.id, feed.id))
      .for('update');
    if (!held || held.archivedAt) return { ok: false as const, error: 'no_feed' };
    const existing = await tx
      .select()
      .from(appointments)
      // External ids carry the feed id, so this feed's rows are all it can match.
      .where(and(eq(appointments.locationId, feed.locationId), eq(appointments.feedId, feed.id)))
      .for('update');
    const byExternal = new Map(existing.map((a) => [a.externalId, a]));
    let added = 0;
    let changed = 0;
    let cancelled = 0;
    const audit = (entityId: string, action: string, before: unknown, after: unknown) =>
      writeAudit(tx, {
        organizationId: feed.organizationId,
        locationId: feed.locationId,
        actorUserId,
        entityType: 'appointments',
        entityId,
        action,
        before,
        after,
      });

    for (const [key, e] of byKey) {
      const row = byExternal.get(key);
      if (!row) {
        if (e.cancelled) continue;
        const [ins] = await tx
          .insert(appointments)
          .values({
            organizationId: feed.organizationId,
            locationId: feed.locationId,
            technicianId: feed.technicianId,
            externalId: key,
            clientName: e.summary,
            startAt: e.startAt,
            endAt: e.endAt,
            source: 'ics',
            feedId: feed.id,
            syncedAt: now,
          })
          .returning({ id: appointments.id });
        if (!ins) throw new Error('appointment insert returned nothing');
        added++;
        // Times and technician only, never the client's name (T11).
        await audit(ins.id, 'appointment_synced', null, {
          technicianId: feed.technicianId,
          startAt: e.startAt,
          endAt: e.endAt,
        });
        continue;
      }
      if (row.arrivedAt) continue; // already a visit: the feed no longer moves it
      const wantCancelled = e.cancelled;
      const moved =
        row.startAt.getTime() !== e.startAt.getTime() || row.endAt.getTime() !== e.endAt.getTime();
      const flip = wantCancelled !== (row.cancelledAt !== null);
      const renamed = (row.clientName ?? null) !== e.summary;
      if (!moved && !flip && !renamed) continue;
      await tx
        .update(appointments)
        .set({
          startAt: e.startAt,
          endAt: e.endAt,
          clientName: e.summary,
          cancelledAt: wantCancelled ? (row.cancelledAt ?? now) : null,
          syncedAt: now,
          updatedAt: now,
        })
        .where(eq(appointments.id, row.id));
      if (wantCancelled && !row.cancelledAt) cancelled++;
      else if (moved || flip) changed++;
      if (moved || flip) {
        await audit(
          row.id,
          wantCancelled && !row.cancelledAt ? 'appointment_cancelled' : 'appointment_synced',
          { startAt: row.startAt, endAt: row.endAt, cancelled: row.cancelledAt !== null },
          { startAt: e.startAt, endAt: e.endAt, cancelled: wantCancelled },
        );
      }
    }

    // Rows this feed made earlier, still open and in the window, but gone from
    // the file: cancelled in the calendar.
    for (const row of existing) {
      if (row.cancelledAt || row.arrivedAt) continue;
      if (byKey.has(row.externalId ?? '')) continue;
      if (row.startAt < from || row.startAt > to) continue;
      await tx
        .update(appointments)
        .set({ cancelledAt: now, syncedAt: now, updatedAt: now })
        .where(eq(appointments.id, row.id));
      cancelled++;
      await audit(
        row.id,
        'appointment_cancelled',
        { startAt: row.startAt, endAt: row.endAt },
        { removedFromCalendar: true },
      );
    }

    await tx
      .update(calendarFeeds)
      .set({
        lastAttemptAt: now,
        lastSyncedAt: now,
        lastError: null,
        lastEventCount: byKey.size,
        updatedAt: now,
      })
      .where(eq(calendarFeeds.id, feed.id));
    return { ok: true as const, added, changed, cancelled, events: byKey.size };
  });
}

async function locationZone(db: Db | Tx, locationId: string): Promise<string> {
  const [l] = await db
    .select({ timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, locationId));
  return l?.timezone ?? 'America/New_York';
}

/**
 * The scheduled poll: every open feed not tried in the last FEED_POLL_MIN
 * minutes, one at a time. With `locationId` and `force` (the desk's "Sync
 * now"), that location's feeds regardless of the interval, but never twice in
 * one minute.
 */
export async function pollFeeds(
  db: Db,
  input: {
    locationId?: string;
    force?: boolean;
    fetchText?: FetchText;
    actorUserId?: string | null;
    now?: Date;
  } = {},
): Promise<{ polled: number; failed: number }> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - (input.force ? 60_000 : FEED_POLL_MIN * 60_000));
  const due = await db
    .select({ id: calendarFeeds.id })
    .from(calendarFeeds)
    .where(
      and(
        isNull(calendarFeeds.archivedAt),
        input.locationId ? eq(calendarFeeds.locationId, input.locationId) : undefined,
        or(isNull(calendarFeeds.lastAttemptAt), lt(calendarFeeds.lastAttemptAt, since)),
      ),
    );
  let failed = 0;
  for (const f of due) {
    const r = await syncFeed(db, {
      feedId: f.id,
      fetchText: input.fetchText,
      actorUserId: input.actorUserId ?? null,
      now,
    });
    if (!r.ok) failed++;
  }
  return { polled: due.length, failed };
}

// What the screens may see ----------------------------------------------------

export type FeedState = {
  technicianId: string;
  technicianName: string;
  urlHint: string;
  lastSyncedAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  lastEventCount: number | null;
  stale: boolean;
};

/** Every open feed at a location, without the URL. */
export async function feedStates(
  db: Db,
  locationId: string,
  now = new Date(),
): Promise<FeedState[]> {
  const rows = await db
    .select({
      technicianId: calendarFeeds.technicianId,
      technicianName: technicians.displayName,
      urlHint: calendarFeeds.urlHint,
      lastSyncedAt: calendarFeeds.lastSyncedAt,
      lastAttemptAt: calendarFeeds.lastAttemptAt,
      lastError: calendarFeeds.lastError,
      lastEventCount: calendarFeeds.lastEventCount,
    })
    .from(calendarFeeds)
    .innerJoin(technicians, eq(technicians.id, calendarFeeds.technicianId))
    .where(and(eq(calendarFeeds.locationId, locationId), isNull(calendarFeeds.archivedAt)))
    .orderBy(technicians.displayName);
  const staleBefore = now.getTime() - FEED_STALE_MIN * 60_000;
  return rows.map((r) => ({
    ...r,
    stale: !r.lastSyncedAt || r.lastSyncedAt.getTime() < staleBefore,
  }));
}

/** For the board: when the calendar was last in step, and what is wrong. */
export async function feedSummary(
  db: Db,
  locationId: string,
  now = new Date(),
): Promise<{
  feeds: number;
  lastSyncedAt: Date | null;
  failing: { technicianName: string; error: string; since: Date | null }[];
  stale: string[];
}> {
  const states = await feedStates(db, locationId, now);
  const synced = states.map((s) => s.lastSyncedAt).filter((d): d is Date => d !== null);
  return {
    feeds: states.length,
    // The oldest of the feeds: the board promises no more than its weakest feed.
    lastSyncedAt:
      synced.length === states.length && synced.length
        ? new Date(Math.min(...synced.map((d) => d.getTime())))
        : null,
    failing: states
      .filter((s) => s.lastError)
      .map((s) => ({
        technicianName: s.technicianName,
        error: s.lastError!,
        since: s.lastAttemptAt,
      })),
    stale: states.filter((s) => s.stale && !s.lastError).map((s) => s.technicianName),
  };
}

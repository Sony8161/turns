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
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { sameSlot } from './appointments';
import { allowedAt } from './permissions';
import { appointments, calendarFeeds, locations, memberships, technicians } from './schema';
import type { Db } from './server';
import type { StaffActor } from './staff';
import { writeAudit } from './status';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Limits. Fresha's own sync lags up to 15 minutes (threat model Q5), so a
// faster poll gains nothing.
export const FEED_POLL_MIN = 15;
export const FEED_STALE_MIN = 45;
// The byte ceiling is for the whole file, history included (a year of a busy
// technician's book is about 1.5 MB); the event cap counts the window only.
export const FEED_MAX_BYTES = 8 * 1024 * 1024;
/** One request, DNS lookup included. */
export const FEED_TIMEOUT_MS = 10_000;
/** Every hop of one feed together, redirects included. */
export const FEED_TOTAL_MS = 20_000;
export const FEED_MAX_REDIRECTS = 3;
export const FEED_MAX_EVENTS = 2000;
/** Events read from one file at all, inside the window or not (CPU guard). */
export const FEED_MAX_SCANNED = 50_000;
/** Feeds polled at once by the scheduled poll. */
export const FEED_POLL_CONCURRENCY = 4;
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
  | 'dns_failed'
  | 'not_fresha';

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

/** The calendar hosts the onboarding screens accept (v0.11.0). Fresha's
 *  export host always; more by config (FEED_ALLOWED_HOSTS, comma separated,
 *  plain host names only: no wildcards, ports or paths). */
export const FRESHA_HOST = 'calendar-export.fresha.com';
const HOST_NAME =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function feedHosts(env: string | undefined = process.env.FEED_ALLOWED_HOSTS): string[] {
  const extra = (env ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => HOST_NAME.test(h) && h !== FRESHA_HOST);
  return [FRESHA_HOST, ...new Set(extra)];
}

/** checkFeedUrl, plus the host must be on the list exactly (no suffix match). */
export function checkFreshaUrl(
  raw: string,
  hosts: string[] = feedHosts(),
): { ok: true; url: URL } | { ok: false; problem: UrlProblem } {
  const checked = checkFeedUrl(raw);
  if (!checked.ok) return checked;
  const host = checked.url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hosts.includes(host)) return { ok: false, problem: 'not_fresha' };
  return checked;
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
  // IPv4-translated (::ffff:0:a.b.c.d): never a public calendar host.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return false;
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return false; // discard-only
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local
  if ((g0 & 0xffc0) === 0xfec0) return false; // site-local (deprecated, still routed inside)
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

// Calendar names (v0.11.0; here since v0.17.1) ------------------------------------

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

// Fetch ------------------------------------------------------------------------

export type FetchResult = { ok: true; text: string } | { ok: false; error: string };
export type FetchText = (url: string) => Promise<FetchResult>;

/** One GET, pinned to the address that was checked, so a second DNS answer
 *  cannot swap in a private address after the check (DNS rebinding). */
export type GetResult = { status: number; location?: string; body?: string; error?: string };
export type GetOnce = (
  url: URL,
  pinned: { address: string; family: number },
  timeoutMs: number,
) => Promise<GetResult>;

const getOnce: GetOnce = (url, pinned, timeoutMs) => {
  return new Promise((done) => {
    const lookup: LookupFunction = (_host, options, cb) => {
      if (options && typeof options === 'object' && options.all) {
        (cb as (e: null, a: { address: string; family: number }[]) => void)(null, [pinned]);
      } else {
        (cb as (e: null, a: string, f: number) => void)(null, pinned.address, pinned.family);
      }
    };
    let settled = false;
    const finish = (r: GetResult) => {
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
    }, timeoutMs);
    req.on('error', () => finish({ status: 0, error: 'connect_failed' }));
    req.end();
  });
};

const TIMED_OUT = Symbol('timeout');

/** The promise, or TIMED_OUT after `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<typeof TIMED_OUT>((done) => {
    timer = setTimeout(() => done(TIMED_OUT), Math.max(0, ms));
  });
  try {
    return await Promise.race([p, clock]);
  } finally {
    clearTimeout(timer);
  }
}

/** The real fetch: every hop (redirects included) is re-checked. Each hop has
 *  FEED_TIMEOUT_MS for its DNS lookup and request together, and all hops share
 *  FEED_TOTAL_MS. Never throws. With `hosts` (v0.17.1, review #7) every hop,
 *  the first and each redirect, must also be on that list. The other options
 *  are for tests. */
export function safeFetchText(
  resolve: Resolve = systemResolve,
  options: { timeoutMs?: number; totalMs?: number; get?: GetOnce; hosts?: string[] } = {},
): FetchText {
  const hopMs = options.timeoutMs ?? FEED_TIMEOUT_MS;
  const totalMs = options.totalMs ?? FEED_TOTAL_MS;
  const get = options.get ?? getOnce;
  const hosts = options.hosts;
  return async (raw) => {
    const deadline = Date.now() + totalMs;
    let current = raw;
    for (let hop = 0; hop <= FEED_MAX_REDIRECTS; hop++) {
      const hopEnd = Math.min(deadline, Date.now() + hopMs);
      if (hopEnd <= Date.now()) return { ok: false, error: 'timeout' };
      const checked = hosts ? checkFreshaUrl(current, hosts) : checkFeedUrl(current);
      if (!checked.ok) return { ok: false, error: checked.problem };
      const pinned = await within(resolvePublic(checked.url, resolve), hopEnd - Date.now());
      if (pinned === TIMED_OUT) return { ok: false, error: 'timeout' };
      if (!pinned.ok) return { ok: false, error: pinned.problem };
      const left = hopEnd - Date.now();
      if (left <= 0) return { ok: false, error: 'timeout' };
      const r = await get(checked.url, pinned, left);
      if (r.location !== undefined) {
        if (!r.location) return { ok: false, error: 'bad_redirect' };
        try {
          current = new URL(r.location, checked.url).toString();
        } catch {
          return { ok: false, error: 'bad_redirect' };
        }
        continue;
      }
      if (r.error) return { ok: false, error: r.error };
      return { ok: true, text: r.body ?? '' };
    }
    return { ok: false, error: 'too_many_redirects' };
  };
}

/** Test hooks for the fetch (a fake DNS answer, a fake request). */
export type FetchOptions = { resolve?: Resolve; get?: GetOnce };

/** The fetch the test and the poll use (v0.17.1): every hop on `hosts`. */
export function feedFetcher(hosts: string[] = feedHosts(), options: FetchOptions = {}): FetchText {
  return safeFetchText(options.resolve ?? systemResolve, {
    hosts,
    ...(options.get ? { get: options.get } : {}),
  });
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

export type ParsedIcs =
  | {
      ok: true;
      events: FeedEvent[];
      /** UIDs of events that could not be read (or are all-day): a sync leaves
       *  their appointments as they are rather than cancel them. */
      droppedUids: string[];
    }
  | { ok: false; error: string };

/** Parses VEVENTs. Recurring rules are not expanded (an appointment feed has
 *  single events); all-day events are dropped. With `window`, only events
 *  starting in it are kept and counted against FEED_MAX_EVENTS. A file without
 *  END:VCALENDAR was cut off and is refused whole. Never throws. */
export function parseIcs(
  text: string,
  fallbackZone: string,
  window?: { from: Date; to: Date },
): ParsedIcs {
  if (!/BEGIN:VCALENDAR/i.test(text)) return { ok: false, error: 'not_a_calendar' };
  if (!/^[ \t]*END:VCALENDAR[ \t]*\r?$/im.test(text)) return { ok: false, error: 'truncated' };
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
  const events: FeedEvent[] = [];
  const droppedUids: string[] = [];
  let scanned = 0;
  let current: Prop[] | null = null;
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      current = [];
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (current) {
        if (++scanned > FEED_MAX_SCANNED) return { ok: false, error: 'too_many_events' };
        const e = toEvent(current, fallbackZone);
        if (!e) {
          const uid = current.find((p) => p.name === 'UID')?.value.trim();
          if (uid && uid.length <= 255) droppedUids.push(uid);
        } else if (!window || (e.startAt >= window.from && e.startAt <= window.to)) {
          events.push(e);
          if (events.length > FEED_MAX_EVENTS) return { ok: false, error: 'too_many_events' };
        }
      }
      current = null;
      continue;
    }
    if (current) {
      const p = parseLine(line);
      if (p) current.push(p);
    }
  }
  return { ok: true, events, droppedUids };
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

/** Whether `actor` may change `technicianId`'s calendar: the owner for any
 *  technician at the location; a technician for their own row only, while
 *  their technician membership there is active (v0.11.0). */
export async function feedTechnician(
  tx: Db | Tx,
  actor: StaffActor,
  technicianId: string,
): Promise<{ id: string } | { error: string }> {
  const self = actor.role === 'technician';
  if (actor.role !== 'owner' && !self) return { error: 'not_allowed' };
  const [tech] = await tx
    .select({ id: technicians.id, userId: technicians.userId, active: technicians.active })
    .from(technicians)
    .where(
      and(
        eq(technicians.id, technicianId),
        eq(technicians.locationId, actor.locationId),
        eq(technicians.organizationId, actor.organizationId),
      ),
    );
  if (!self) return tech ? { id: tech.id } : { error: 'unknown_technician' };
  if (!tech || tech.userId !== actor.userId || !tech.active) return { error: 'not_allowed' };
  const [member] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, actor.userId),
        eq(memberships.locationId, actor.locationId),
        eq(memberships.role, 'technician'),
        eq(memberships.active, true),
      ),
    );
  return member ? { id: tech.id } : { error: 'not_allowed' };
}

// A technician's own link (v0.17.1, review #6) -----------------------------------

/** The owner's choice for a technician's own Fresha link (locations column). */
export const TECH_CALENDAR_LINKS = ['owner_approves', 'name_must_match', 'open'] as const;
export type TechCalendarLinks = (typeof TECH_CALENDAR_LINKS)[number];

export function isTechCalendarLinks(v: unknown): v is TechCalendarLinks {
  return typeof v === 'string' && (TECH_CALENDAR_LINKS as readonly string[]).includes(v);
}

export async function techCalendarLinksAt(
  db: Db | Tx,
  locationId: string,
): Promise<TechCalendarLinks> {
  const [row] = await db
    .select({ v: locations.techCalendarLinks })
    .from(locations)
    .where(eq(locations.id, locationId));
  const v = row?.v as TechCalendarLinks | undefined;
  return v && TECH_CALENDAR_LINKS.includes(v) ? v : 'owner_approves';
}

/** The owner sets it (audited, before and after; there is no URL in it). */
export async function setTechCalendarLinks(
  db: Db,
  input: { actor: StaffActor; value: TechCalendarLinks },
): Promise<{ ok: true } | { ok: false; reason: 'not_allowed' | 'bad_value' }> {
  if (input.actor.role !== 'owner') return { ok: false, reason: 'not_allowed' };
  if (!TECH_CALENDAR_LINKS.includes(input.value)) return { ok: false, reason: 'bad_value' };
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ v: locations.techCalendarLinks })
      .from(locations)
      .where(
        and(
          eq(locations.id, input.actor.locationId),
          eq(locations.organizationId, input.actor.organizationId),
        ),
      )
      .for('update');
    if (!before) return { ok: false as const, reason: 'not_allowed' as const };
    if (before.v === input.value) return { ok: true as const };
    await tx
      .update(locations)
      .set({ techCalendarLinks: input.value, updatedAt: new Date() })
      .where(eq(locations.id, input.actor.locationId));
    await writeAudit(tx, {
      organizationId: input.actor.organizationId,
      locationId: input.actor.locationId,
      actorUserId: input.actor.userId,
      entityType: 'locations',
      entityId: input.actor.locationId,
      action: 'tech_calendar_links_setting',
      before: { techCalendarLinks: before.v },
      after: { techCalendarLinks: input.value },
    });
    return { ok: true as const };
  });
}

/** The owner pastes a technician's calendar link (T13), or a technician
 *  their own (v0.11.0). Checked for syntax and for a public address before it
 *  is kept. A technician, and any caller passing `hosts`, may only use an
 *  allowed calendar host (Fresha).
 *
 *  v0.17.1 (review #6): a technician's own link follows the owner's choice
 *  (locations.tech_calendar_links). 'owner_approves' (Heavenly): it is kept
 *  but waits (`pending`), is never fetched and so brings in nothing and holds
 *  nobody, until the owner or a manager approves it (reviewFeed).
 *  'name_must_match': the calendar is fetched now (every hop on the host
 *  list) and its name must point at her and nobody else. 'open': as v0.11.0.
 *  A link the owner pastes never waits. */
export async function setFeed(
  db: Db,
  input: {
    actor: StaffActor;
    technicianId: string;
    url: string;
    resolve?: Resolve;
    hosts?: string[];
    /** For name_must_match: reads the calendar (tests pass their own). */
    fetchText?: FetchText;
  },
): Promise<{ ok: true; feedId: string; urlHint: string; pending: boolean } | FeedError> {
  if (input.actor.role !== 'owner' && input.actor.role !== 'technician') {
    return { ok: false, reason: 'not_allowed' };
  }
  const self = input.actor.role === 'technician';
  const freshaOnly = self || input.hosts !== undefined;
  const hosts = input.hosts ?? feedHosts();
  const checked = freshaOnly ? checkFreshaUrl(input.url, hosts) : checkFeedUrl(input.url);
  if (!checked.ok) return { ok: false, reason: checked.problem };
  const addr = await resolvePublic(checked.url, input.resolve);
  if (!addr.ok) return { ok: false, reason: addr.problem };
  const hint = urlHint(checked.url);
  const mode = self ? await techCalendarLinksAt(db, input.actor.locationId) : 'open';
  if (self && mode === 'name_must_match') {
    // Her own row first, so nobody learns another technician's calendar name.
    const mine = await feedTechnician(db, input.actor, input.technicianId);
    if ('error' in mine) return { ok: false, reason: mine.error };
    const fetched = await (
      input.fetchText ?? feedFetcher(hosts, input.resolve ? { resolve: input.resolve } : {})
    )(checked.url.toString());
    if (!fetched.ok) return { ok: false, reason: fetched.error };
    const techs = await db
      .select({ id: technicians.id, name: technicians.displayName })
      .from(technicians)
      .where(
        and(
          eq(technicians.locationId, input.actor.locationId),
          eq(technicians.organizationId, input.actor.organizationId),
          eq(technicians.active, true),
        ),
      );
    if (suggestTechnician(calendarName(fetched.text), techs) !== mine.id) {
      return { ok: false, reason: 'calendar_name' };
    }
  }
  const pending = self && mode === 'owner_approves';
  return db.transaction(async (tx) => {
    const tech = await feedTechnician(tx, input.actor, input.technicianId);
    if ('error' in tech) return { ok: false, reason: tech.error };
    const now = new Date();
    const approval = pending
      ? { needsApproval: true, approvedBy: null, approvedAt: null }
      : { needsApproval: false };
    const [row] = await tx
      .insert(calendarFeeds)
      .values({
        organizationId: input.actor.organizationId,
        locationId: input.actor.locationId,
        technicianId: tech.id,
        url: checked.url.toString(),
        urlHint: hint,
        createdBy: input.actor.userId,
        ...approval,
      })
      .onConflictDoUpdate({
        target: calendarFeeds.technicianId,
        set: {
          url: checked.url.toString(),
          urlHint: hint,
          archivedAt: null,
          lastError: null,
          lastAttemptAt: null,
          ...approval,
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
      after: {
        technicianId: tech.id,
        urlHint: hint,
        by: input.actor.role,
        ...(pending ? { pending: true } : {}),
        ...(self && mode === 'name_must_match' ? { nameMatched: true } : {}),
      },
    });
    return { ok: true, feedId: row.id, urlHint: hint, pending };
  });
}

/**
 * The owner or a manager approves a technician's waiting link (it is then
 * fetched like any other) or declines it (removed, as by the owner). The
 * audit row names the technician only: no URL, not even its hint.
 */
export async function reviewFeed(
  db: Db,
  input: { actor: StaffActor; technicianId: string; decision: 'approve' | 'decline' },
): Promise<
  | { ok: true; feedId: string }
  | { ok: false; reason: 'not_allowed' | 'not_pending' | 'unknown_technician' }
> {
  if (!(await allowedAt(db, input.actor, 'approve_calendar_links'))) {
    return { ok: false, reason: 'not_allowed' };
  }
  return db.transaction(async (tx) => {
    const [feed] = await tx
      .select({
        id: calendarFeeds.id,
        needsApproval: calendarFeeds.needsApproval,
        archivedAt: calendarFeeds.archivedAt,
      })
      .from(calendarFeeds)
      .where(
        and(
          eq(calendarFeeds.technicianId, input.technicianId),
          eq(calendarFeeds.locationId, input.actor.locationId),
          eq(calendarFeeds.organizationId, input.actor.organizationId),
        ),
      )
      .for('update');
    if (!feed) return { ok: false as const, reason: 'unknown_technician' as const };
    if (!feed.needsApproval || feed.archivedAt) {
      return { ok: false as const, reason: 'not_pending' as const };
    }
    const now = new Date();
    if (input.decision === 'approve') {
      await tx
        .update(calendarFeeds)
        .set({
          needsApproval: false,
          approvedBy: input.actor.userId,
          approvedAt: now,
          updatedAt: now,
        })
        .where(eq(calendarFeeds.id, feed.id));
    } else {
      await tx
        .update(calendarFeeds)
        .set({ needsApproval: false, url: '', archivedAt: now, updatedAt: now })
        .where(eq(calendarFeeds.id, feed.id));
    }
    await writeAudit(tx, {
      organizationId: input.actor.organizationId,
      locationId: input.actor.locationId,
      actorUserId: input.actor.userId,
      entityType: 'calendar_feeds',
      entityId: feed.id,
      action: input.decision === 'approve' ? 'feed_approved' : 'feed_declined',
      after: { technicianId: input.technicianId },
    });
    return { ok: true as const, feedId: feed.id };
  });
}

/** Links waiting for the owner or a manager, oldest first (names, never URLs). */
export async function pendingFeeds(
  db: Db,
  locationId: string,
): Promise<{ technicianId: string; technicianName: string; since: Date }[]> {
  return db
    .select({
      technicianId: calendarFeeds.technicianId,
      technicianName: technicians.displayName,
      since: calendarFeeds.updatedAt,
    })
    .from(calendarFeeds)
    .innerJoin(technicians, eq(technicians.id, calendarFeeds.technicianId))
    .where(
      and(
        eq(calendarFeeds.locationId, locationId),
        eq(calendarFeeds.needsApproval, true),
        isNull(calendarFeeds.archivedAt),
      ),
    )
    .orderBy(asc(calendarFeeds.updatedAt));
}

/** The owner removes a feed, or a technician their own: the URL is blanked,
 *  its appointments stay. */
export async function removeFeed(
  db: Db,
  input: { actor: StaffActor; technicianId: string },
): Promise<{ ok: true } | FeedError> {
  if (input.actor.role !== 'owner' && input.actor.role !== 'technician') {
    return { ok: false, reason: 'not_allowed' };
  }
  return db.transaction(async (tx) => {
    const tech = await feedTechnician(tx, input.actor, input.technicianId);
    if ('error' in tech) {
      return { ok: false, reason: tech.error === 'unknown_technician' ? 'no_feed' : tech.error };
    }
    const [feed] = await tx
      .select()
      .from(calendarFeeds)
      .where(
        and(
          eq(calendarFeeds.technicianId, tech.id),
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
      before: { technicianId: feed.technicianId, urlHint: feed.urlHint, by: input.actor.role },
    });
    return { ok: true };
  });
}

// Sync ---------------------------------------------------------------------------

/** A link under the reserved .invalid top-level name (RFC 2606): the demo
 *  seed's placeholder. No request is ever made for one. */
export function isPlaceholderFeedUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith('.invalid');
  } catch {
    return false;
  }
}

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
  input: {
    feedId: string;
    fetchText?: FetchText;
    /** v0.17.1: test hooks for the real fetch (every hop on the host list). */
    fetchOptions?: FetchOptions;
    actorUserId?: string | null;
    now?: Date;
  },
): Promise<SyncResult> {
  const now = input.now ?? new Date();
  const actorUserId = input.actorUserId ?? null;
  const [feed] = await db.select().from(calendarFeeds).where(eq(calendarFeeds.id, input.feedId));
  if (!feed || feed.archivedAt || !feed.url) return { ok: false, error: 'no_feed' };
  // v0.17.1 (review #6): a technician's link waiting for approval is never
  // fetched, so it brings in nothing and holds nobody out of the line.
  if (feed.needsApproval) return { ok: false, error: 'pending' };
  const zone = await locationZone(db, feed.locationId);

  // The demo seed's calendar rows (v0.12.0) carry a reserved .invalid name:
  // never fetched, in any environment. Locally they read as synced so the
  // demo board stays green; anywhere else such a row is a broken link.
  if (isPlaceholderFeedUrl(feed.url)) {
    if (process.env.NODE_ENV === 'production') {
      return recordFailure(db, feed, 'not_allowed', actorUserId, now);
    }
    await db
      .update(calendarFeeds)
      .set({ lastAttemptAt: now, lastSyncedAt: now, lastError: null, updatedAt: now })
      .where(eq(calendarFeeds.id, feed.id));
    return { ok: true, added: 0, changed: 0, cancelled: 0, events: feed.lastEventCount ?? 0 };
  }

  // v0.17.1 (review #7): a Fresha link (every link a technician saves, and
  // the Connect Fresha card's) must stay on the host list on every hop, the
  // saved link and each redirect, as the screens' test does. A link the owner
  // pasted under "Other calendar link" (Part 7) is not on the list; it keeps
  // the public-address check on every hop, as before.
  const hosts = feedHosts();
  const onList = checkFreshaUrl(feed.url, hosts).ok;
  const fetcher =
    input.fetchText ??
    (onList
      ? feedFetcher(hosts, input.fetchOptions)
      : safeFetchText(
          input.fetchOptions?.resolve ?? systemResolve,
          input.fetchOptions?.get ? { get: input.fetchOptions.get } : {},
        ));
  const fetched = await fetcher(feed.url);
  if (!fetched.ok) return recordFailure(db, feed, fetched.error, actorUserId, now);
  const from = new Date(now.getTime() - FEED_PAST_HOURS * 3_600_000);
  const to = new Date(now.getTime() + FEED_AHEAD_DAYS * 86_400_000);
  const parsed = parseIcs(fetched.text, zone, { from, to });
  if (!parsed.ok) return recordFailure(db, feed, parsed.error, actorUserId, now);

  // One row per UID; the last one in the file wins.
  const byKey = new Map(parsed.events.map((e) => [`${feed.id}:${e.uid}`, e]));
  // Events the parser could not read: their rows are left as they are.
  const unreadable = new Set(parsed.droppedUids.map((uid) => `${feed.id}:${uid}`));

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
        // The desk may have entered this one by hand already (v0.7.1): an open
        // hand entry gives way to the calendar's row; one that already arrived
        // stays the visit, and the calendar's row arrives with it.
        const handEntered = (await sameSlot(tx, feed.technicianId, e.startAt)).filter(
          (a) => a.source === 'manual',
        );
        const arrivedCopy = handEntered.find((a) => a.arrivedAt);
        for (const m of handEntered) {
          if (m.arrivedAt) continue;
          await tx
            .update(appointments)
            .set({ cancelledAt: now, updatedAt: now })
            .where(eq(appointments.id, m.id));
          await audit(
            m.id,
            'appointment_replaced',
            { technicianId: m.technicianId, startAt: m.startAt, endAt: m.endAt },
            { byCalendar: true },
          );
        }
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
            arrivedAt: arrivedCopy?.arrivedAt ?? null,
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
      if (unreadable.has(row.externalId ?? '')) continue;
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

export async function locationZone(db: Db | Tx, locationId: string): Promise<string> {
  const [l] = await db
    .select({ timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, locationId));
  const zone = l?.timezone;
  return zone && validZone(zone) ? zone : 'America/New_York';
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
    fetchOptions?: FetchOptions;
    actorUserId?: string | null;
    now?: Date;
    concurrency?: number;
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
        // v0.17.1: a link waiting for approval is never polled.
        eq(calendarFeeds.needsApproval, false),
        input.locationId ? eq(calendarFeeds.locationId, input.locationId) : undefined,
        or(isNull(calendarFeeds.lastAttemptAt), lt(calendarFeeds.lastAttemptAt, since)),
      ),
    )
    // The feed tried longest ago first, so a slow run cannot starve the same feeds.
    .orderBy(sql`${calendarFeeds.lastAttemptAt} asc nulls first`, asc(calendarFeeds.id));
  let failed = 0;
  let next = 0;
  const actorUserId = input.actorUserId ?? null;
  const worker = async () => {
    while (next < due.length) {
      const f = due[next++]!;
      // One feed's surprise (a DB error, a bug) never stops the others, and
      // the feed shows as failed rather than quietly going stale.
      try {
        const r = await syncFeed(db, {
          feedId: f.id,
          fetchText: input.fetchText,
          fetchOptions: input.fetchOptions,
          actorUserId,
          now,
        });
        if (!r.ok) failed++;
      } catch {
        failed++;
        await markFailed(db, f.id, actorUserId, now).catch(() => undefined);
      }
    }
  };
  const lanes = Math.max(1, Math.min(input.concurrency ?? FEED_POLL_CONCURRENCY, due.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  return { polled: due.length, failed };
}

/** After an unexpected error: the feed is marked failed. The error's own text
 *  is never kept or logged, as it can carry the URL (T14). */
async function markFailed(db: Db, feedId: string, actorUserId: string | null, now: Date) {
  const [feed] = await db.select().from(calendarFeeds).where(eq(calendarFeeds.id, feedId));
  if (feed) await recordFailure(db, feed, 'sync_failed', actorUserId, now);
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
  /** v0.17.1: a technician's link waiting for the owner or a manager. */
  pending: boolean;
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
      pending: calendarFeeds.needsApproval,
    })
    .from(calendarFeeds)
    .innerJoin(technicians, eq(technicians.id, calendarFeeds.technicianId))
    .where(and(eq(calendarFeeds.locationId, locationId), isNull(calendarFeeds.archivedAt)))
    .orderBy(technicians.displayName);
  const staleBefore = now.getTime() - FEED_STALE_MIN * 60_000;
  return rows.map((r) => ({
    ...r,
    // Waiting for approval is not stale: it is not meant to sync yet.
    stale: !r.pending && (!r.lastSyncedAt || r.lastSyncedAt.getTime() < staleBefore),
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
  /** v0.17.1: technicians whose own link waits for approval. */
  pending: string[];
}> {
  const all = await feedStates(db, locationId, now);
  // Only links that are meant to sync count for the board's line.
  const states = all.filter((s) => !s.pending);
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
    pending: all.filter((s) => s.pending).map((s) => s.technicianName),
  };
}

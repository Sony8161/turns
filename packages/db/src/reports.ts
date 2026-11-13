// Audit log viewer and reports (Part 8). Server only. Design doc "Audit log";
// threat model T4 (insiders gaming turns: the snapshot and the weekly summary
// are how the owner sees it) and T17 (the log is append-only; nothing here
// writes to it).
//
// Every reader here takes a location id that the caller has already checked
// against the verified session (owner: the location they picked; manager:
// their own location). None of it is ever handed a location from a request.
//
// What never leaves this module: client names and phone numbers, the calendar
// feed address, raw check-in coordinates, the free-text visit note, and a rule
// version's full config. The audit log itself holds none of the first three
// (Parts 6, 7); `redact` below is the second line in case a later part slips.
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DAY_END_ACTIONS } from './day-end';
import {
  appointments,
  auditLog,
  dailySummaries,
  locations,
  profiles,
  services,
  shifts,
  technicians,
  turnCalls,
  turnLedger,
  visits,
} from './schema';
import type { Db } from './server';
import { sweepFloor } from './status';

// ---------------------------------------------------------------------------
// Dates

/** A location's local calendar date as YYYY-MM-DD. Pure. */
export function localDate(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The day before a YYYY-MM-DD date. Pure. */
export function previousDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD string that is a real calendar date, or null. Pure. */
export function parseDate(input: unknown): string | null {
  if (typeof input !== 'string' || !DATE_RE.test(input)) return null;
  const d = new Date(`${input}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input ? null : input;
}

/** Local time of day for a timestamp, HH:MM:SS (24 h). Pure. */
export function localTime(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(at);
}

async function timezoneOf(db: Db, locationId: string): Promise<string> {
  const [loc] = await db
    .select({ timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, locationId));
  return loc?.timezone ?? 'UTC';
}

/** Start of `from` to the end of `to`, both local dates, as a SQL range test. */
const inLocalDays = (col: unknown, from: string, to: string, tz: string) =>
  sql`${col} >= (${from}::date::timestamp at time zone ${tz})
      and ${col} < ((${to}::date + 1)::timestamp at time zone ${tz})`;

// ---------------------------------------------------------------------------
// Redaction

const SENSITIVE_KEY = /(client|phone|email|url|feed|address|note|position|lat|lng|config)/i;

/** Drops keys that may carry personal data or secrets, at any depth. Pure. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) continue;
      out[k] = redact(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Audit viewer

/** Every action the app writes, so the filter can offer them. */
export const AUDIT_ACTIONS = [
  'check_in',
  'checked_in',
  'available',
  'in_service',
  'break',
  'out',
  'off',
  'auto_check_out',
  'call_sent',
  'call_accepted',
  'call_denied',
  'call_expired',
  'points_posted',
  'points_adjusted',
  'deny_excused',
  'penalty_excused',
  'visit_created',
  'visit_note_changed',
  'visit_reassigned',
  'visit_completed',
  'visit_split',
  'client_left',
  // v0.17.0
  'client_left_claimed',
  'client_left_rejected',
  'left_without_service',
  'appointment_no_show',
  'visit_closed_day_end',
  'visit_auto_finished',
  'call_closed_day_end',
  'help_closed_day_end',
  'act_for_setting',
  'fix_entered',
  'fix_approved',
  'fix_declined',
  'help_requested',
  'help_acknowledged',
  'request_keep_waiting',
  'request_booked_later',
  'request_sent_by_turn',
  'offer_sent',
  'offer_accepted',
  'offer_declined',
  'desk_pick_sent',
  'desk_pick_declined',
  'technician_level_changed',
  'service_levels_changed',
  'appointment_added',
  'appointment_changed',
  'appointment_cancelled',
  'appointment_arrived',
  'appointment_merged',
  'appointment_replaced',
  'appointment_synced',
  'feed_set',
  'feed_removed',
  'feed_sync_failed',
  'feed_tested',
  'long_wait_notice',
  'kiosk_check_in',
  'kiosk_confirmed',
  'kiosk_declined',
  'kiosk_created',
  'kiosk_pairing_code',
  'kiosk_paired',
  'kiosk_revoked',
  'kiosk_unlocked',
  'kiosk_pin_failed',
  'kiosk_pair_failed',
  'rule_config_changed',
  'technician_profile_changed',
  'technician_edits_setting',
  'client_updated',
  'role_changed',
  'member_archived',
  'member_restored',
  'invite_created',
  'joined_by_invite',
  'location_created',
  'salon_created',
] as const;

/** Changes a person made to the floor or the staff: what the weekly summary counts (T4). */
export const OVERRIDE_ACTIONS = [
  'visit_reassigned',
  'fix_approved',
  'points_adjusted',
  'deny_excused',
  'penalty_excused',
  'call_expired',
  'rule_config_changed',
  'role_changed',
  'member_archived',
  'member_restored',
  'technician_profile_changed',
  'technician_edits_setting',
  'act_for_setting',
] as const;

/** Desk entries a receptionist makes that steer a call (T4: edits per receptionist). */
export const DESK_ACTIONS = [
  'visit_created',
  'fix_entered',
  'client_left',
  'visit_note_changed',
  'appointment_added',
  'appointment_changed',
  'appointment_cancelled',
  'appointment_arrived',
  'long_wait_notice',
  'kiosk_confirmed',
  'kiosk_declined',
  'client_updated',
  // v0.17.0
  'left_without_service',
  'client_left_rejected',
  'appointment_no_show',
] as const;

export type QueueEntry = {
  name: string;
  points: number;
  status: string;
  eligible: boolean;
  why: string;
  /** What the reason is about: the services, or the minutes (v0.14.0). */
  detail: string;
  hadAppointmentLast: boolean;
};

export type AuditRow = {
  id: string;
  at: Date;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  technicianId: string | null;
  technicianName: string | null;
  /** The fields the design doc's audit table lists for this event, as label → value. */
  fields: [string, string][];
  /** The same entry for people to read (v0.16.1): names, not ids. The CSV keeps `fields`. */
  readable: ReadablePart[];
  reason: string | null;
  /** On a call: everyone on shift at that second, in queue order. */
  queue: QueueEntry[] | null;
};

export type AuditFilter = {
  locationId: string;
  from: string; // local date YYYY-MM-DD
  to: string; // local date YYYY-MM-DD, inclusive
  technicianId?: string | null;
  action?: string | null;
  limit?: number;
};

export const AUDIT_MAX_ROWS = 2000;
export const AUDIT_MAX_DAYS = 31;

const UUID_RE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

// The technician an entry is about, whichever way the writer recorded it.
const TECHNICIAN_OF = sql<string | null>`coalesce(
  case when ${auditLog.entityType} = 'technician_status' then ${auditLog.entityId} end,
  case when ${auditLog.entityType} = 'technicians' then ${auditLog.entityId} end,
  case when ${auditLog.entityType} = 'turn_calls'
    then (select c.technician_id from turn_calls c where c.id = ${auditLog.entityId}) end,
  case when ${auditLog.entityType} = 'turn_ledger'
    then (select l.technician_id from turn_ledger l where l.id = ${auditLog.entityId}) end,
  case when (${auditLog.after} ->> 'technicianId') ~ ${UUID_RE}
    then (${auditLog.after} ->> 'technicianId')::uuid end,
  case when (${auditLog.before} ->> 'technicianId') ~ ${UUID_RE}
    then (${auditLog.before} ->> 'technicianId')::uuid end
)`;

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Signed points as the board writes them: +1, −0.5, 0. Pure. */
export function signed(n: number): string {
  if (n === 0) return '0';
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

/**
 * The design doc's fields for one entry (Audit log table), as label → value.
 * Pure: the caller resolves names and response times first. Unknown actions
 * fall back to the entry's own scalar values, redacted.
 */
export function auditFields(e: {
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  responseSeconds: number | null;
  names: Map<string, string>;
}): [string, string][] {
  const before = obj(e.before);
  const after = obj(e.after);
  const nameOf = (id: unknown) => (typeof id === 'string' ? (e.names.get(id) ?? id) : '');
  const out: [string, string][] = [];
  const add = (k: string, v: unknown) => {
    const s = str(v);
    if (s !== null && s !== '') out.push([k, s]);
  };

  if (e.entityType === 'technician_status') {
    add('from', before['status']);
    add('to', after['status']);
    if (e.action === 'check_in') {
      const g = obj(after['geofence']);
      add(
        'geofence',
        g['passed'] === true ? 'passed' : g['passed'] === false ? 'failed' : g['reason'],
      );
      const d = num(g['distanceM']);
      if (d !== null) add('distance_m', Math.round(d));
      add('late_min', num(after['lateMinutes']));
    }
    if (e.action === 'out') add('expected_back', after['expectedBackAt']);
    return out;
  }

  switch (e.action) {
    case 'call_sent':
    case 'offer_sent':
    case 'desk_pick_sent':
      add('visit', after['visitId']);
      add('called', nameOf(after['technicianId']));
      return out;
    case 'call_accepted':
    case 'call_denied':
    case 'offer_accepted':
    case 'offer_declined':
    case 'desk_pick_declined':
      add('visit', after['visitId']);
      if (e.responseSeconds !== null) add('response_s', Math.round(e.responseSeconds));
      add('deny_reason', after['denyReason']);
      return out;
    case 'call_expired':
      add('visit', after['visitId']);
      return out;
    case 'client_left':
      add('visit', e.entityId);
      add('called', nameOf(after['technicianId']));
      add('by', after['by']);
      return out;
    case 'fix_entered':
    case 'fix_approved':
    case 'fix_declined':
      add('visit', e.entityId);
      add('fix_of', after['fixOfVisitId']);
      add('in_window', after['inWindow']);
      if (e.action === 'fix_entered') add('needs_approval', after['needsApproval']);
      return out;
    case 'help_requested':
    case 'help_acknowledged':
      add('technician', nameOf(after['technicianId']));
      if (e.action === 'help_acknowledged') add('waited_s', num(after['waitedSeconds']));
      return out;
    case 'points_posted': {
      add('ledger', e.entityId);
      const d = num(after['delta']);
      if (d !== null) add('delta', signed(d));
      add('reason_type', after['reasonType']);
      add('visit', after['visitId']);
      return out;
    }
    case 'points_adjusted': {
      add('ledger', e.entityId);
      const d = num(after['delta']);
      if (d !== null) add('delta', signed(d));
      add('before', num(before['points']));
      add('after', num(after['points']));
      return out;
    }
    case 'deny_excused':
    case 'penalty_excused': {
      add('original_ledger', before['ledgerId']);
      add('original_type', before['reasonType']);
      const d = num(after['delta']);
      if (d !== null) add('delta', signed(d));
      return out;
    }
    case 'visit_reassigned':
      add('from', nameOf(before['technicianId']));
      add('to', nameOf(after['technicianId']));
      return out;
    case 'visit_completed': {
      const p = num(after['points']);
      if (p !== null) add('points', p);
      return out;
    }
    case 'rule_config_changed':
      add('version_before', num(before['version']));
      add('version_after', num(after['version']));
      return out;
    case 'role_changed':
      add('user', nameOf(before['userId'] ?? after['userId']));
      add('from', before['role']);
      add('to', after['role']);
      return out;
    default: {
      // Scalar values only, redacted; nested objects are left out of the table.
      const flat = (src: Record<string, unknown>, prefix: string) => {
        for (const [k, v] of Object.entries(obj(redact(src)))) {
          if (v === null || typeof v === 'object') continue;
          add(
            `${prefix}${k}`,
            typeof v === 'string' && v.length > 120 ? `${v.slice(0, 117)}...` : v,
          );
        }
      };
      flat(before, 'before.');
      flat(after, '');
      return out;
    }
  }
}

/** The queue snapshot of a call, for display. Pure; drops anything personal. */
export function snapshotOf(after: unknown): QueueEntry[] | null {
  const q = obj(after)['queue'];
  if (!Array.isArray(q)) return null;
  return q.map((c) => {
    const r = obj(c);
    return {
      name: str(r['displayName']) ?? '',
      points: num(r['points']) ?? 0,
      status: str(r['status']) ?? '',
      eligible: r['eligible'] === true,
      why: str(r['why']) ?? '',
      detail: str(r['detail']) ?? '',
      hadAppointmentLast: r['hadAppointmentLast'] === true,
    };
  });
}

// ---------------------------------------------------------------------------
// Readable details (v0.16.1). The viewer shows these instead of `fields`,
// which keep the raw ids for the CSV. Staff names and service names are
// resolved here; a visit stays an id (`kind: 'visit'`) and only the viewer
// page turns it into "First L. · services" through clients.visitLabels, so no
// client name ever sits in an AuditRow (module header). Unresolved ids are
// dropped, never shown.

export type ReadableCode =
  | 'status'
  | 'reason'
  | 'deny'
  | 'source'
  | 'level'
  | 'choice'
  | 'by'
  | 'role'
  | 'geofence'
  | 'call_kind';

export type ReadableValue =
  | { kind: 'text'; text: string }
  | { kind: 'visit'; id: string }
  | { kind: 'services'; names: string[] }
  | { kind: 'points'; n: number; signed?: boolean }
  | { kind: 'bool'; value: boolean }
  | { kind: 'seconds'; n: number }
  | { kind: 'minutes'; n: number }
  | { kind: 'meters'; n: number }
  | { kind: 'time'; at: string }
  | { kind: 'number'; n: number }
  | { kind: 'code'; group: ReadableCode; code: string }
  | { kind: 'list'; items: string[] };

/** One readable detail: what it is, its value, and what it was before when it changed. */
export type ReadablePart = { key: string; value: ReadableValue; was?: ReadableValue };

export type ReadableRefs = {
  /** Technician and user ids at this location → display name. */
  people: Map<string, string>;
  /** Service ids at this location → service name. */
  services: Map<string, string>;
};

const UUID_TEST = new RegExp(UUID_RE);
const isId = (v: unknown): v is string => typeof v === 'string' && UUID_TEST.test(v);

// Keys that are plumbing, already shown in another column, or personal.
const SKIP_KEYS = new Set([
  'queue',
  'shiftId',
  'callId',
  'groupId',
  'kioskDeviceId',
  'demo',
  'owners',
  'kind',
  'age',
  'gender',
  'hasName',
  'hasReason',
  'id',
  'locationId',
  'organizationId',
  'skillCategoryIds',
  'restrictions',
  'ledgerId',
]);

const CODE_KEYS: Record<string, [string, ReadableCode]> = {
  status: ['status', 'status'],
  reasonType: ['reason_type', 'reason'],
  denyReason: ['deny_reason', 'deny'],
  source: ['source', 'source'],
  level: ['level', 'level'],
  choice: ['choice', 'choice'],
  by: ['by', 'by'],
  role: ['role', 'role'],
};
const SERVICE_KEYS: Record<string, string> = {
  serviceIds: 'services',
  keptServiceIds: 'kept',
  sentBackServiceIds: 'sent_back',
  takesOnly: 'takes_only',
};
const VISIT_KEYS: Record<string, string> = {
  visitId: 'visit',
  newVisitId: 'rest_of_visit',
  fixOfVisitId: 'fix_of',
};
const PERSON_KEYS: Record<string, string> = {
  technicianId: 'technician',
  // v0.17.0: the desk acted for this technician.
  actedFor: 'acted_for',
  requestedTechnicianId: 'asked_for',
  userId: 'person',
};
const BOOL_KEYS: Record<string, string> = {
  excused: 'excused',
  inWindow: 'in_window',
  needsApproval: 'needs_approval',
  isKid: 'kid',
};
const TIME_KEYS: Record<string, string> = {
  startAt: 'start',
  endAt: 'end',
  expectedBackAt: 'expected_back',
};

/** One raw key and value as a readable detail, or null to leave it out. Pure. */
function readableValue(
  k: string,
  v: unknown,
  refs: ReadableRefs,
): { key: string; value: ReadableValue } | null {
  if (v === null || v === undefined || v === '' || SKIP_KEYS.has(k)) return null;
  if (k in VISIT_KEYS)
    return isId(v) ? { key: VISIT_KEYS[k]!, value: { kind: 'visit', id: v } } : null;
  if (k in PERSON_KEYS) {
    const name = isId(v) ? refs.people.get(v) : undefined;
    return name ? { key: PERSON_KEYS[k]!, value: { kind: 'text', text: name } } : null;
  }
  if (k in SERVICE_KEYS) {
    if (!Array.isArray(v)) return null;
    const names = v
      .filter(isId)
      .map((id) => refs.services.get(id))
      .filter((n): n is string => !!n);
    return names.length ? { key: SERVICE_KEYS[k]!, value: { kind: 'services', names } } : null;
  }
  if (k in CODE_KEYS) {
    const [key, group] = CODE_KEYS[k]!;
    return typeof v === 'string' ? { key, value: { kind: 'code', group, code: v } } : null;
  }
  if (k in BOOL_KEYS) {
    return typeof v === 'boolean'
      ? { key: BOOL_KEYS[k]!, value: { kind: 'bool', value: v } }
      : null;
  }
  if (k in TIME_KEYS) {
    const at = typeof v === 'string' ? new Date(v) : null;
    return at && !Number.isNaN(at.getTime())
      ? { key: TIME_KEYS[k]!, value: { kind: 'time', at: at.toISOString() } }
      : null;
  }
  if (k === 'partyId')
    return isId(v) ? { key: 'group', value: { kind: 'bool', value: true } } : null;
  if (k === 'delta') {
    const n = num(v);
    return n === null ? null : { key: 'change', value: { kind: 'points', n, signed: true } };
  }
  if (k === 'points') {
    const n = num(v);
    return n === null ? null : { key: 'points', value: { kind: 'points', n } };
  }
  if (k === 'lateMinutes') {
    const n = num(v);
    return n === null ? null : { key: 'late', value: { kind: 'minutes', n } };
  }
  if (k === 'waitedSeconds') {
    const n = num(v);
    return n === null ? null : { key: 'waited', value: { kind: 'seconds', n: Math.round(n) } };
  }
  if (k === 'version') {
    const n = num(v);
    return n === null ? null : { key: 'rules_version', value: { kind: 'number', n } };
  }
  if (k === 'geofence') {
    const g = obj(v);
    const code =
      g['passed'] === true ? 'passed' : g['passed'] === false ? 'failed' : str(g['reason']);
    return code ? { key: 'geofence', value: { kind: 'code', group: 'geofence', code } } : null;
  }
  if (k === 'tags') {
    if (!Array.isArray(v)) return null;
    const items = v.filter((x): x is string => typeof x === 'string' && !isId(x));
    return { key: 'tags', value: { kind: 'list', items } };
  }
  // Anything else: a short plain value, never an id, never a nested object.
  if (isId(v) || (typeof v === 'object' && v !== null)) return null;
  const s = str(v);
  if (s === null) return null;
  if (typeof v === 'boolean') return { key: k, value: { kind: 'bool', value: v } };
  return { key: k, value: { kind: 'text', text: s.length > 80 ? `${s.slice(0, 77)}...` : s } };
}

const sameValue = (a: ReadableValue, b: ReadableValue) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The details of one entry as the owner reads them: names instead of ids,
 * before → after where something changed, nothing personal and no raw ids.
 * Pure: the caller resolves staff and service names first.
 */
export function readableParts(
  e: {
    action: string;
    entityType: string;
    entityId: string | null;
    before: unknown;
    after: unknown;
    responseSeconds: number | null;
  },
  refs: ReadableRefs,
): ReadablePart[] {
  const before = obj(redact(e.before));
  const after = obj(redact(e.after));
  const out: ReadablePart[] = [];

  // The visit the entry is about, when it is written on the visit itself.
  if (e.entityType === 'visits' && isId(e.entityId) && !('visitId' in after)) {
    out.push({ key: 'visit', value: { kind: 'visit', id: e.entityId } });
  }
  if (e.responseSeconds !== null && Number.isFinite(e.responseSeconds)) {
    out.push({ key: 'response', value: { kind: 'seconds', n: Math.round(e.responseSeconds) } });
  }

  const keys = [...Object.keys(after), ...Object.keys(before).filter((k) => !(k in after))];
  for (const k of keys) {
    const now = k in after ? readableValue(k, after[k], refs) : null;
    const was = k in before ? readableValue(k, before[k], refs) : null;
    // The technician an entry is about is already in its own column; only a
    // change of technician (a reassign) is a detail.
    if (k === 'technicianId' && !(was && now)) continue;
    if (now && was) {
      if (sameValue(now.value, was.value)) out.push(now);
      else out.push({ key: now.key, value: now.value, was: was.value });
    } else if (now) out.push(now);
    else if (was) out.push(was);
  }
  return out;
}

/** Audit entries for one location, newest first, within at most AUDIT_MAX_DAYS. */
export async function auditEntries(db: Db, filter: AuditFilter): Promise<AuditRow[]> {
  const from = parseDate(filter.from);
  const to = parseDate(filter.to);
  if (!from || !to || from > to) return [];
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (span >= AUDIT_MAX_DAYS) return [];
  const tz = await timezoneOf(db, filter.locationId);
  const limit = Math.min(Math.max(1, filter.limit ?? AUDIT_MAX_ROWS), AUDIT_MAX_ROWS);

  const conds = [
    eq(auditLog.locationId, filter.locationId),
    inLocalDays(auditLog.at, from, to, tz),
  ];
  if (filter.action) conds.push(eq(auditLog.action, filter.action));
  if (filter.technicianId) conds.push(sql`${TECHNICIAN_OF} = ${filter.technicianId}::uuid`);

  const rows = await db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      before: auditLog.before,
      after: auditLog.after,
      reason: auditLog.reason,
      actorName: profiles.displayName,
      actorRole: sql<string | null>`(select m.role::text from memberships m
        where m.user_id = ${auditLog.actorUserId} and m.location_id = ${auditLog.locationId}
        order by m.active desc, m.created_at desc limit 1)`,
      technicianId: TECHNICIAN_OF,
      responseSeconds: sql<string | null>`case when ${auditLog.entityType} = 'turn_calls'
        and ${auditLog.action} in ('call_accepted', 'call_denied', 'offer_accepted', 'offer_declined', 'desk_pick_declined')
        then (select extract(epoch from (c.responded_at - c.called_at))
              from turn_calls c where c.id = ${auditLog.entityId}) end`,
    })
    .from(auditLog)
    .leftJoin(profiles, eq(profiles.id, auditLog.actorUserId))
    .where(and(...conds))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit);

  // Names for every technician and user an entry mentions, in two queries.
  const techIds = new Set<string>();
  const userIds = new Set<string>();
  const serviceIds = new Set<string>();
  const isUuid = (v: unknown): v is string => typeof v === 'string' && new RegExp(UUID_RE).test(v);
  for (const r of rows) {
    if (r.technicianId) techIds.add(r.technicianId);
    for (const side of [obj(r.before), obj(r.after)]) {
      if (isUuid(side['technicianId'])) techIds.add(side['technicianId']);
      if (isUuid(side['requestedTechnicianId'])) techIds.add(side['requestedTechnicianId']);
      if (isUuid(side['userId'])) userIds.add(side['userId']);
      for (const k of ['serviceIds', 'keptServiceIds', 'sentBackServiceIds', 'takesOnly']) {
        const list = side[k];
        if (Array.isArray(list)) for (const id of list) if (isUuid(id)) serviceIds.add(id);
      }
    }
  }
  const names = new Map<string, string>();
  if (techIds.size) {
    for (const t of await db
      .select({ id: technicians.id, name: technicians.displayName })
      .from(technicians)
      .where(
        and(inArray(technicians.id, [...techIds]), eq(technicians.locationId, filter.locationId)),
      )) {
      names.set(t.id, t.name);
    }
  }
  if (userIds.size) {
    for (const p of await db
      .select({ id: profiles.id, name: profiles.displayName })
      .from(profiles)
      .where(inArray(profiles.id, [...userIds]))) {
      names.set(p.id, p.name);
    }
  }
  const serviceNames = new Map<string, string>();
  if (serviceIds.size) {
    for (const x of await db
      .select({ id: services.id, name: services.name })
      .from(services)
      .where(
        and(inArray(services.id, [...serviceIds]), eq(services.locationId, filter.locationId)),
      )) {
      serviceNames.set(x.id, x.name);
    }
  }
  const refs: ReadableRefs = { people: names, services: serviceNames };

  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    actorName: r.actorName ?? null,
    actorRole: r.actorRole ?? null,
    action: r.action,
    entityType: r.entityType,
    technicianId: r.technicianId ?? null,
    technicianName: r.technicianId ? (names.get(r.technicianId) ?? null) : null,
    fields: auditFields({
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      before: r.before,
      after: r.after,
      responseSeconds: r.responseSeconds === null ? null : Number(r.responseSeconds),
      names,
    }),
    readable: readableParts(
      {
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        before: r.before,
        after: r.after,
        responseSeconds: r.responseSeconds === null ? null : Number(r.responseSeconds),
      },
      refs,
    ),
    reason: r.reason,
    queue: r.action === 'call_sent' ? snapshotOf(r.after) : null,
  }));
}

// ---------------------------------------------------------------------------
// The table the viewer shows and the CSV carries: one builder, so they match
// row for row (Done-when, REQ-4114d3aa).

export type AuditLabels = {
  actions: Partial<Record<string, string>>;
  roles: Partial<Record<string, string>>;
  system: string;
  headers: {
    date: string;
    time: string;
    actor: string;
    role: string;
    action: string;
    technician: string;
    details: string;
    reason: string;
    queue: string;
  };
};

/** Queue snapshot as one line: "1. Thảo 0 available; 2. Linh ½ break (on_break)". Pure. */
export function queueLine(q: QueueEntry[] | null): string {
  if (!q) return '';
  return q
    .map(
      (c, i) =>
        `${i + 1}. ${c.name} ${c.points}${c.hadAppointmentLast && c.points === 0 ? '(00)' : ''} ${c.status}${c.eligible ? '' : ` (${c.why})`}`,
    )
    .join('; ');
}

export function auditTable(
  rows: AuditRow[],
  timezone: string,
  labels: AuditLabels,
): { header: string[]; body: string[][] } {
  const h = labels.headers;
  return {
    header: [h.date, h.time, h.actor, h.role, h.action, h.technician, h.details, h.reason, h.queue],
    body: rows.map((r) => [
      localDate(r.at, timezone),
      localTime(r.at, timezone),
      r.actorName ?? labels.system,
      r.actorRole ? (labels.roles[r.actorRole] ?? r.actorRole) : '',
      labels.actions[r.action] ?? r.action,
      r.technicianName ?? '',
      r.fields.map(([k, v]) => `${k}=${v}`).join('; '),
      r.reason ?? '',
      queueLine(r.queue),
    ]),
  };
}

// ---------------------------------------------------------------------------
// CSV

/**
 * One CSV cell. Quoted always; a cell that a spreadsheet would read as a
 * formula (starts with = + - @, tab or carriage return, after any leading
 * spaces) gets a leading apostrophe so it stays text. Pure.
 */
export function csvCell(value: string): string {
  const v = /^\s*[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${v.replace(/"/g, '""')}"`;
}

/** CSV text with CRLF line ends and a UTF-8 BOM so Excel reads Vietnamese. Pure. */
export function toCsv(header: string[], body: string[][]): string {
  const lines = [header, ...body].map((row) => row.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** The cells of a CSV line, undoing csvCell (for tests and imports). Pure. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '"') throw new Error('unquoted cell');
    let j = i + 1;
    let cell = '';
    for (;;) {
      if (j >= line.length) throw new Error('unterminated cell');
      if (line[j] === '"') {
        if (line[j + 1] === '"') {
          cell += '"';
          j += 2;
          continue;
        }
        break;
      }
      cell += line[j];
      j++;
    }
    out.push(cell);
    i = j + 1;
    if (line[i] === ',') i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Daily turn report

export type DailyTechRow = {
  technicianId: string;
  name: string;
  checkedInAt: Date | null;
  checkedOutAt: Date | null;
  lateMinutes: number;
  calls: number;
  accepted: number;
  denied: number;
  avgResponseSeconds: number | null;
  visitsCompleted: number;
  appointments: number;
  points: number;
  byReason: {
    visit: number;
    deny: number;
    late: number;
    out_over: number;
    manual: number;
    excuse: number;
  };
};

export type DailyReport = {
  date: string;
  timezone: string;
  technicians: DailyTechRow[];
  totals: {
    visits: number;
    completed: number;
    cancelled: number;
    walkIns: number;
    appointments: number;
    calls: number;
    denies: number;
    overrides: number;
    feedFailures: number;
    /** v0.17.0 (WALK-001): clients who left without service: while waiting
     *  (walkedOut) and after the call, before the start (clientLeft). */
    walkedOut: number;
    clientLeft: number;
    /** v0.17.0: booked clients the desk marked a no-show. */
    noShows: number;
    /** v0.17.0 (DAY-001): what the day-end close-out closed for this day. */
    closedAtDayEnd: DayEndCounts;
  };
};

export type DayEndCounts = {
  /** Waiting, called, unconfirmed and pending visits closed with no points. */
  visits: number;
  /** In service at day end: finished, points posted, marked auto-finished. */
  autoFinished: number;
  /** Open calls closed as expired, no penalty. */
  calls: number;
  help: number;
  /** Shifts left open, checked out. */
  shifts: number;
};

/** One location's day, per technician, from the ledger and the calls. */
export async function dailyTurnReport(
  db: Db,
  locationId: string,
  date: string,
): Promise<DailyReport | null> {
  const day = parseDate(date);
  if (!day) return null;
  const tz = await timezoneOf(db, locationId);

  const shiftRows = await db
    .select({
      shiftId: shifts.id,
      technicianId: shifts.technicianId,
      name: technicians.displayName,
      checkedInAt: shifts.checkedInAt,
      checkedOutAt: shifts.checkedOutAt,
      lateMinutes: shifts.lateMinutes,
    })
    .from(shifts)
    .innerJoin(technicians, eq(technicians.id, shifts.technicianId))
    .where(and(eq(shifts.locationId, locationId), eq(shifts.date, day)))
    .orderBy(asc(shifts.checkedInAt));

  const ledger = await db
    .select({
      technicianId: turnLedger.technicianId,
      reasonType: turnLedger.reasonType,
      total: sql<string>`sum(${turnLedger.delta})`,
    })
    .from(turnLedger)
    .innerJoin(shifts, eq(shifts.id, turnLedger.shiftId))
    .where(and(eq(turnLedger.locationId, locationId), eq(shifts.date, day)))
    .groupBy(turnLedger.technicianId, turnLedger.reasonType);

  const calls = await db
    .select({
      technicianId: turnCalls.technicianId,
      calls: sql<string>`count(*)`,
      accepted: sql<string>`count(*) filter (where ${turnCalls.response} = 'accepted')`,
      denied: sql<string>`count(*) filter (where ${turnCalls.response} = 'denied' and ${turnCalls.kind} = 'turn')`,
      avg: sql<
        string | null
      >`avg(extract(epoch from (${turnCalls.respondedAt} - ${turnCalls.calledAt})))
        filter (where ${turnCalls.respondedAt} is not null)`,
    })
    .from(turnCalls)
    .where(and(eq(turnCalls.locationId, locationId), inLocalDays(turnCalls.calledAt, day, day, tz)))
    .groupBy(turnCalls.technicianId);

  const done = await db
    .select({
      technicianId: visits.assignedTechnicianId,
      completed: sql<string>`count(*) filter (where ${visits.status} = 'completed')`,
      appointments: sql<string>`count(*) filter (where ${visits.status} = 'completed' and ${visits.source} = 'appointment')`,
    })
    .from(visits)
    .where(and(eq(visits.locationId, locationId), inLocalDays(visits.arrivedAt, day, day, tz)))
    .groupBy(visits.assignedTechnicianId);

  const [vt] = await db
    .select({
      visits: sql<string>`count(*)`,
      completed: sql<string>`count(*) filter (where ${visits.status} = 'completed')`,
      cancelled: sql<string>`count(*) filter (where ${visits.status} = 'cancelled')`,
      walkIns: sql<string>`count(*) filter (where ${visits.source} <> 'appointment')`,
      appointments: sql<string>`count(*) filter (where ${visits.source} = 'appointment')`,
      walkedOut: sql<string>`count(*) filter (where ${visits.status} = 'left' and ${visits.closeReason} = 'walked_out')`,
      clientLeft: sql<string>`count(*) filter (where ${visits.status} = 'left' and ${visits.closeReason} is distinct from 'walked_out')`,
    })
    .from(visits)
    .where(and(eq(visits.locationId, locationId), inLocalDays(visits.arrivedAt, day, day, tz)));

  const [ns] = await db
    .select({ n: sql<string>`count(*)` })
    .from(appointments)
    .where(
      and(
        eq(appointments.locationId, locationId),
        sql`${appointments.noShowAt} is not null`,
        inLocalDays(appointments.startAt, day, day, tz),
      ),
    );

  // The close-out runs on a later day; its rows name the day they closed.
  const dayEnd = await db
    .select({ action: auditLog.action, n: sql<string>`count(*)` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.locationId, locationId),
        inArray(auditLog.action, [...DAY_END_ACTIONS]),
        sql`${auditLog.after}->>'forDay' = ${day}`,
      ),
    )
    .groupBy(auditLog.action);
  const dayEndOf = (a: string) => Number(dayEnd.find((r) => r.action === a)?.n ?? 0);

  const [at] = await db
    .select({
      overrides: sql<string>`count(*) filter (where ${auditLog.action} in ('visit_reassigned', 'points_adjusted', 'deny_excused', 'penalty_excused', 'call_expired'))`,
      feedFailures: sql<string>`count(*) filter (where ${auditLog.action} = 'feed_sync_failed')`,
    })
    .from(auditLog)
    .where(and(eq(auditLog.locationId, locationId), inLocalDays(auditLog.at, day, day, tz)));

  // A technician may have more than one shift row only if a check-out was
  // re-joined; the report shows one row per technician.
  const byTech = new Map<string, DailyTechRow>();
  for (const s of shiftRows) {
    const prev = byTech.get(s.technicianId);
    if (prev) {
      prev.checkedOutAt = s.checkedOutAt ?? prev.checkedOutAt;
      continue;
    }
    byTech.set(s.technicianId, {
      technicianId: s.technicianId,
      name: s.name,
      checkedInAt: s.checkedInAt,
      checkedOutAt: s.checkedOutAt,
      lateMinutes: s.lateMinutes,
      calls: 0,
      accepted: 0,
      denied: 0,
      avgResponseSeconds: null,
      visitsCompleted: 0,
      appointments: 0,
      points: 0,
      byReason: { visit: 0, deny: 0, late: 0, out_over: 0, manual: 0, excuse: 0 },
    });
  }
  for (const l of ledger) {
    const row = byTech.get(l.technicianId);
    if (!row) continue;
    const n = Number(l.total);
    row.points += n;
    const k = l.reasonType as keyof DailyTechRow['byReason'];
    if (k in row.byReason) row.byReason[k] += n;
  }
  for (const c of calls) {
    const row = byTech.get(c.technicianId);
    if (!row) continue;
    row.calls = Number(c.calls);
    row.accepted = Number(c.accepted);
    row.denied = Number(c.denied);
    row.avgResponseSeconds = c.avg === null ? null : Math.round(Number(c.avg));
  }
  for (const d of done) {
    const row = d.technicianId ? byTech.get(d.technicianId) : undefined;
    if (!row) continue;
    row.visitsCompleted = Number(d.completed);
    row.appointments = Number(d.appointments);
  }
  const techRows = [...byTech.values()].map((r) => ({
    ...r,
    points: Math.round(r.points * 10) / 10,
  }));

  return {
    date: day,
    timezone: tz,
    technicians: techRows,
    totals: {
      visits: Number(vt?.visits ?? 0),
      completed: Number(vt?.completed ?? 0),
      cancelled: Number(vt?.cancelled ?? 0),
      walkIns: Number(vt?.walkIns ?? 0),
      appointments: Number(vt?.appointments ?? 0),
      calls: techRows.reduce((s, r) => s + r.calls, 0),
      denies: techRows.reduce((s, r) => s + r.denied, 0),
      overrides: Number(at?.overrides ?? 0),
      feedFailures: Number(at?.feedFailures ?? 0),
      walkedOut: Number(vt?.walkedOut ?? 0),
      clientLeft: Number(vt?.clientLeft ?? 0),
      noShows: Number(ns?.n ?? 0),
      closedAtDayEnd: {
        visits: dayEndOf('visit_closed_day_end'),
        autoFinished: dayEndOf('visit_auto_finished'),
        calls: dayEndOf('call_closed_day_end'),
        help: dayEndOf('help_closed_day_end'),
        shifts: dayEndOf('auto_check_out'),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Overrides per person (threat model T4: weekly owner summary of overrides per
// manager and edits per receptionist)

export type OverrideSummaryRow = {
  userId: string | null;
  name: string | null;
  role: string | null;
  counts: Record<string, number>;
  total: number;
};

export async function overrideSummary(
  db: Db,
  locationId: string,
  from: string,
  to: string,
): Promise<OverrideSummaryRow[]> {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b || a > b) return [];
  const tz = await timezoneOf(db, locationId);
  const rows = await db
    .select({
      userId: auditLog.actorUserId,
      name: profiles.displayName,
      role: sql<string | null>`(select m.role::text from memberships m
        where m.user_id = ${auditLog.actorUserId} and m.location_id = ${auditLog.locationId}
        order by m.active desc, m.created_at desc limit 1)`,
      action: auditLog.action,
      n: sql<string>`count(*)`,
    })
    .from(auditLog)
    .leftJoin(profiles, eq(profiles.id, auditLog.actorUserId))
    .where(
      and(
        eq(auditLog.locationId, locationId),
        inLocalDays(auditLog.at, a, b, tz),
        inArray(auditLog.action, [...OVERRIDE_ACTIONS, ...DESK_ACTIONS]),
      ),
    )
    .groupBy(auditLog.actorUserId, profiles.displayName, auditLog.locationId, auditLog.action);

  const byUser = new Map<string, OverrideSummaryRow>();
  for (const r of rows) {
    const key = r.userId ?? 'system';
    let row = byUser.get(key);
    if (!row) {
      row = { userId: r.userId, name: r.name ?? null, role: r.role, counts: {}, total: 0 };
      byUser.set(key, row);
    }
    const n = Number(r.n);
    row.counts[r.action] = (row.counts[r.action] ?? 0) + n;
    row.total += n;
  }
  const rank = (role: string | null) =>
    ({ owner: 0, manager: 1, receptionist: 2, technician: 3 })[role ?? ''] ?? 4;
  return [...byUser.values()].sort((x, y) => rank(x.role) - rank(y.role) || y.total - x.total);
}

// ---------------------------------------------------------------------------
// End-of-day summary for the owner

export type EndOfDaySummary = {
  date: string;
  visits: number;
  completed: number;
  walkIns: number;
  appointments: number;
  denies: number;
  overrides: number;
  feedFailures: number;
  /** v0.17.0; missing in a summary stored before v0.17.0. */
  walkedOut?: number;
  clientLeft?: number;
  noShows?: number;
  closedAtDayEnd?: DayEndCounts;
  technicians: { name: string; points: number; visits: number; denied: number; late: number }[];
  overridesBy: { name: string | null; role: string | null; total: number }[];
};

/** The summary for one location and local date. Pure over a report. */
export function summarize(report: DailyReport, people: OverrideSummaryRow[]): EndOfDaySummary {
  return {
    date: report.date,
    visits: report.totals.visits,
    completed: report.totals.completed,
    walkIns: report.totals.walkIns,
    appointments: report.totals.appointments,
    denies: report.totals.denies,
    overrides: report.totals.overrides,
    feedFailures: report.totals.feedFailures,
    walkedOut: report.totals.walkedOut,
    clientLeft: report.totals.clientLeft,
    noShows: report.totals.noShows,
    closedAtDayEnd: report.totals.closedAtDayEnd,
    technicians: report.technicians.map((t) => ({
      name: t.name,
      points: t.points,
      visits: t.visitsCompleted,
      denied: t.denied,
      late: t.lateMinutes,
    })),
    overridesBy: people
      .map((p) => ({
        name: p.name,
        role: p.role,
        total: OVERRIDE_ACTIONS.reduce((s, k) => s + (p.counts[k] ?? 0), 0),
      }))
      .filter((p) => p.total > 0),
  };
}

/**
 * Writes the summary for a closed day once and returns it; a second call
 * returns the stored row. Refuses today and later: a day is summarised only
 * after it ends, so the stored row is final.
 */
export async function ensureDailySummary(
  db: Db,
  locationId: string,
  date: string,
  now = new Date(),
): Promise<EndOfDaySummary | null> {
  const day = parseDate(date);
  if (!day) return null;
  const [loc] = await db
    .select({ organizationId: locations.organizationId, timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, locationId));
  if (!loc) return null;
  if (day >= localDate(now, loc.timezone)) return null;
  const stored = await storedSummary(db, locationId, day);
  if (stored) return stored;
  // v0.17.0 (DAY-001): close what the day left open first, so the stored
  // summary lists it and never changes afterwards.
  await sweepFloor(db, locationId, now);
  const report = await dailyTurnReport(db, locationId, day);
  if (!report) return null;
  const summary = summarize(report, await overrideSummary(db, locationId, day, day));
  await db
    .insert(dailySummaries)
    .values({ organizationId: loc.organizationId, locationId, date: day, summary })
    .onConflictDoNothing({ target: [dailySummaries.locationId, dailySummaries.date] });
  return (await storedSummary(db, locationId, day)) ?? summary;
}

export async function storedSummary(
  db: Db,
  locationId: string,
  date: string,
): Promise<EndOfDaySummary | null> {
  const [row] = await db
    .select({ summary: dailySummaries.summary })
    .from(dailySummaries)
    .where(and(eq(dailySummaries.locationId, locationId), eq(dailySummaries.date, date)));
  return (row?.summary as EndOfDaySummary | undefined) ?? null;
}

/** For the scheduled job: yesterday's summary at every location. Counts only. */
export async function summarizeYesterdayEverywhere(
  db: Db,
  now = new Date(),
): Promise<{ locations: number; written: number }> {
  const locs = await db.select({ id: locations.id, timezone: locations.timezone }).from(locations);
  let written = 0;
  for (const l of locs) {
    // v0.17.0 (DAY-001): the nightly close-out, even where the summary exists.
    await sweepFloor(db, l.id, now);
    const day = previousDate(localDate(now, l.timezone));
    const had = await storedSummary(db, l.id, day);
    if (had) continue;
    if (await ensureDailySummary(db, l.id, day, now)) written++;
  }
  return { locations: locs.length, written };
}

/** Technicians at a location, for the viewer's filter. */
export async function techniciansAt(db: Db, locationId: string) {
  return db
    .select({ id: technicians.id, name: technicians.displayName, active: technicians.active })
    .from(technicians)
    .where(eq(technicians.locationId, locationId))
    .orderBy(asc(technicians.displayName));
}

// ---------------------------------------------------------------------------
// v0.17.0 (FAIR-001): the fairness table, owner and manager. One row per
// technician over a range of local days (default the last 7). Counts only:
// no client names or phones, nothing a technician typed.

export type FairnessRow = {
  technicianId: string;
  name: string;
  visitsDone: number;
  points: number;
  /** Turn denies that cost points (not excused by the rules or a manager). */
  deniesPenalty: number;
  /** Denies the rules excused (Heavenly: break, personal). */
  deniesFree: number;
  /** Offers to a higher level and desk picks she said no to (never a penalty). */
  declined: number;
  /** Visits she took part of, sending the rest back to the line. */
  splits: number;
  /** "Client left" marks from her phone, and how many of those closed the visit. */
  clientLeftMarked: number;
  clientLeftConfirmed: number;
  /** Fixes of work she did. */
  fixesOnHerWork: number;
  /** Times she was ahead in the line and passed over, by reason. */
  skipped: Record<string, number>;
};

export function lastDays(today: string, days: number): { from: string; to: string } {
  let from = today;
  for (let i = 1; i < days; i++) from = previousDate(from);
  return { from, to: today };
}

export async function fairnessReport(
  db: Db,
  locationId: string,
  from: string,
  to: string,
): Promise<FairnessRow[]> {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b || a > b) return [];
  const tz = await timezoneOf(db, locationId);
  const techs = await db
    .select({ id: technicians.id, name: technicians.displayName, active: technicians.active })
    .from(technicians)
    .where(eq(technicians.locationId, locationId))
    .orderBy(asc(technicians.displayName));
  const rows = new Map<string, FairnessRow>();
  const row = (id: string): FairnessRow | undefined => rows.get(id);
  for (const t of techs) {
    rows.set(t.id, {
      technicianId: t.id,
      name: t.name,
      visitsDone: 0,
      points: 0,
      deniesPenalty: 0,
      deniesFree: 0,
      declined: 0,
      splits: 0,
      clientLeftMarked: 0,
      clientLeftConfirmed: 0,
      fixesOnHerWork: 0,
      skipped: {},
    });
  }
  const callRange = inLocalDays(turnCalls.calledAt, a, b, tz);
  const [done, pts, calls, splits, fixes, marks, skips] = await Promise.all([
    db
      .select({ id: visits.assignedTechnicianId, n: sql<string>`count(*)` })
      .from(visits)
      .where(
        and(
          eq(visits.locationId, locationId),
          eq(visits.status, 'completed'),
          inLocalDays(visits.arrivedAt, a, b, tz),
        ),
      )
      .groupBy(visits.assignedTechnicianId),
    db
      .select({ id: turnLedger.technicianId, n: sql<string>`sum(${turnLedger.delta})` })
      .from(turnLedger)
      .innerJoin(shifts, eq(shifts.id, turnLedger.shiftId))
      .where(
        and(
          eq(turnLedger.locationId, locationId),
          sql`${shifts.date} between ${a}::date and ${b}::date`,
        ),
      )
      .groupBy(turnLedger.technicianId),
    db
      .select({
        id: turnCalls.technicianId,
        penalty: sql<string>`count(*) filter (where ${turnCalls.kind} = 'turn' and ${turnCalls.response} = 'denied' and not ${turnCalls.autoExcused} and ${turnCalls.excusedAt} is null)`,
        free: sql<string>`count(*) filter (where ${turnCalls.autoExcused})`,
        declined: sql<string>`count(*) filter (where ${turnCalls.kind} <> 'turn' and ${turnCalls.response} = 'denied')`,
      })
      .from(turnCalls)
      .where(and(eq(turnCalls.locationId, locationId), callRange))
      .groupBy(turnCalls.technicianId),
    db.execute(sql`select first.assigned_technician_id as id, count(*) as n
      from visits rest join visits first on first.id = rest.split_from_visit_id
      where rest.location_id = ${locationId}
        and ${inLocalDays(sql`rest.arrived_at`, a, b, tz)}
      group by first.assigned_technician_id`),
    db.execute(sql`select orig.assigned_technician_id as id, count(*) as n
      from visits fix join visits orig on orig.id = fix.fix_of_visit_id
      where fix.location_id = ${locationId} and fix.is_fix
        and ${inLocalDays(sql`fix.arrived_at`, a, b, tz)}
      group by orig.assigned_technician_id`),
    db
      .select({
        id: sql<string>`${auditLog.after}->>'technicianId'`,
        marked: sql<string>`count(*) filter (where ${auditLog.action} = 'client_left_claimed' or (${auditLog.action} = 'client_left' and ${auditLog.after}->>'by' = 'technician'))`,
        confirmed: sql<string>`count(*) filter (where ${auditLog.action} = 'client_left' and ${auditLog.after}->>'by' in ('technician', 'technician_confirmed'))`,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.locationId, locationId),
          inArray(auditLog.action, ['client_left_claimed', 'client_left']),
          inLocalDays(auditLog.at, a, b, tz),
        ),
      )
      .groupBy(sql`${auditLog.after}->>'technicianId'`),
    // Everyone ahead of the one called, who was not eligible, and why.
    db.execute(sql`select q.e->>'technicianId' as id, q.e->>'why' as why, count(*) as n
      from turn_calls c
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(c.queue_snapshot) = 'array' then c.queue_snapshot else '[]'::jsonb end
      ) with ordinality as q(e, i)
      where c.location_id = ${locationId} and c.kind = 'turn'
        and ${inLocalDays(sql`c.called_at`, a, b, tz)}
        and coalesce((q.e->>'eligible')::boolean, false) = false
        and q.i < (select min(p.i) from jsonb_array_elements(
          case when jsonb_typeof(c.queue_snapshot) = 'array' then c.queue_snapshot else '[]'::jsonb end
        ) with ordinality as p(e, i) where p.e->>'technicianId' = c.technician_id::text)
      group by 1, 2`),
  ]);
  for (const d of done) {
    const r = d.id ? row(d.id) : undefined;
    if (r) r.visitsDone = Number(d.n);
  }
  for (const p of pts) if (row(p.id)) row(p.id)!.points = Math.round(Number(p.n) * 10) / 10;
  for (const c of calls) {
    const r = row(c.id);
    if (!r) continue;
    r.deniesPenalty = Number(c.penalty);
    r.deniesFree = Number(c.free);
    r.declined = Number(c.declined);
  }
  for (const s of splits as unknown as { id: string | null; n: string }[]) {
    if (s.id && row(s.id)) row(s.id)!.splits = Number(s.n);
  }
  for (const f of fixes as unknown as { id: string | null; n: string }[]) {
    if (f.id && row(f.id)) row(f.id)!.fixesOnHerWork = Number(f.n);
  }
  for (const m of marks) {
    const r = m.id ? row(m.id) : undefined;
    if (!r) continue;
    r.clientLeftMarked = Number(m.marked);
    r.clientLeftConfirmed = Number(m.confirmed);
  }
  for (const k of skips as unknown as { id: string | null; why: string | null; n: string }[]) {
    const r = k.id ? row(k.id) : undefined;
    if (!r || !k.why) continue;
    r.skipped[k.why] = (r.skipped[k.why] ?? 0) + Number(k.n);
  }
  // Archived technicians appear only when they did something in the range.
  const active = new Set(techs.filter((t) => t.active).map((t) => t.id));
  return [...rows.values()].filter(
    (r) =>
      active.has(r.technicianId) ||
      r.visitsDone + r.deniesPenalty + r.deniesFree + r.declined + r.clientLeftMarked > 0,
  );
}

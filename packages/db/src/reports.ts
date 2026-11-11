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
import {
  auditLog,
  dailySummaries,
  locations,
  profiles,
  shifts,
  technicians,
  turnCalls,
  turnLedger,
  visits,
} from './schema';
import type { Db } from './server';

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
  'visit_reassigned',
  'visit_completed',
  'appointment_added',
  'appointment_changed',
  'appointment_cancelled',
  'appointment_arrived',
  'feed_set',
  'feed_removed',
  'feed_sync_failed',
  'long_wait_notice',
  'rule_config_changed',
  'technician_profile_changed',
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
  'points_adjusted',
  'deny_excused',
  'penalty_excused',
  'call_expired',
  'rule_config_changed',
  'role_changed',
  'member_archived',
  'member_restored',
  'technician_profile_changed',
] as const;

/** Desk entries a receptionist makes that steer a call (T4: edits per receptionist). */
export const DESK_ACTIONS = [
  'visit_created',
  'appointment_added',
  'appointment_changed',
  'appointment_cancelled',
  'appointment_arrived',
  'long_wait_notice',
] as const;

export type QueueEntry = {
  name: string;
  points: number;
  status: string;
  eligible: boolean;
  why: string;
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
      add('visit', after['visitId']);
      add('called', nameOf(after['technicianId']));
      return out;
    case 'call_accepted':
    case 'call_denied':
      add('visit', after['visitId']);
      if (e.responseSeconds !== null) add('response_s', Math.round(e.responseSeconds));
      add('deny_reason', after['denyReason']);
      return out;
    case 'call_expired':
      add('visit', after['visitId']);
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
      hadAppointmentLast: r['hadAppointmentLast'] === true,
    };
  });
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
        and ${auditLog.action} in ('call_accepted', 'call_denied')
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
  const isUuid = (v: unknown): v is string => typeof v === 'string' && new RegExp(UUID_RE).test(v);
  for (const r of rows) {
    if (r.technicianId) techIds.add(r.technicianId);
    for (const side of [obj(r.before), obj(r.after)]) {
      if (isUuid(side['technicianId'])) techIds.add(side['technicianId']);
      if (isUuid(side['userId'])) userIds.add(side['userId']);
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
  };
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
      denied: sql<string>`count(*) filter (where ${turnCalls.response} = 'denied')`,
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
    })
    .from(visits)
    .where(and(eq(visits.locationId, locationId), inLocalDays(visits.arrivedAt, day, day, tz)));

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

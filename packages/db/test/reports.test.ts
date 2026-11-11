// Done-when (REQ-4114d3aa): every event in the doc audit table appears with the
// listed fields; the CSV matches the viewer row for row; the queue snapshot on
// a call shows every tech with points and status at that second; a
// receptionist cannot open the log (test). Threat model T4, T17.
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adjustPoints,
  callNext,
  createWalkIn,
  excusePenalty,
  finishVisit,
  openCallFor,
  reassignVisit,
  respondToCall,
} from '../src/engine';
import {
  auditEntries,
  auditTable,
  csvCell,
  dailyTurnReport,
  ensureDailySummary,
  localDate,
  overrideSummary,
  parseCsvLine,
  parseDate,
  redact,
  storedSummary,
  toCsv,
  type AuditLabels,
  type AuditRow,
} from '../src/reports';
import { activeRules, saveRuleConfig } from '../src/rules';
import { HEAVENLY, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import { changeRole } from '../src/staff';
import { checkIn, transition } from '../src/status';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
const TZ = 'America/New_York';
const desk = { userId: null };
let manicure: string;
type Person = { userId: string; membershipId: string };
type Tech = Person & { id: string; name: string };
let a: Tech;
let b: Tech;
let c: Tech;
let owner: Person;
let manager: Person;
let reception: Person;
let today: string;

async function person(name: string, role: string): Promise<Person> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${name}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  const [m] = await sql<
    { id: string }[]
  >`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${LOC}, ${role}) returning id`;
  return { userId, membershipId: m!.id };
}

async function tech(name: string): Promise<Tech> {
  const p = await person(name, 'technician');
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${p.userId}, ${ORG}, ${LOC}, ${name}) returning id`;
  return { ...p, id: t!.id, name };
}

async function onFloor(t: Tech) {
  await checkIn(db, { technicianId: t.id, actor: { userId: t.userId }, position: null });
  await transition(db, { technicianId: t.id, to: 'available', actor: { userId: t.userId } });
}

/** Run `fn` as an app role with the given user, as PostgREST would. */
async function asUser<T>(userId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`;
    await tx.unsafe('set local role authenticated');
    return fn(tx);
  })) as T;
}

const LABELS: AuditLabels = {
  actions: {},
  roles: {},
  system: 'System',
  headers: {
    date: 'Date',
    time: 'Time',
    actor: 'By',
    role: 'Role',
    action: 'Event',
    technician: 'Technician',
    details: 'Details',
    reason: 'Reason',
    queue: 'Queue',
  },
};

let rows: AuditRow[];
const find = (action: string, pred: (r: AuditRow) => boolean = () => true) =>
  rows.find((r) => r.action === action && pred(r));
const field = (r: AuditRow | undefined, k: string) => r?.fields.find(([kk]) => kk === k)?.[1];

beforeAll(async () => {
  await resetAndMigrate();
  await seedHeavenly(TEST_URL);
  db = createDb(TEST_URL);
  const [m] = await sql<
    { id: string }[]
  >`select id from services where location_id = ${LOC} and name = 'Basic manicure'`;
  manicure = m!.id;
  owner = await person('Phú', 'owner');
  manager = await person('Mai', 'manager');
  reception = await person('Kim', 'receptionist');
  a = await tech('Thảo');
  b = await tech('Linh');
  c = await tech('Vy');
  await onFloor(a);
  await onFloor(b);
  await onFloor(c);
  today = localDate(new Date(), TZ);

  // A day with every kind of event in the design doc's audit table.
  await transition(db, { technicianId: c.id, to: 'break', actor: { userId: c.userId } });
  const mgr = { userId: manager.userId, organizationId: ORG, locationId: LOC };
  // Linh gets +½ so the snapshot shows different points.
  await adjustPoints(db, { technicianId: b.id, delta: 0.5, actor: mgr, reason: 'late from lunch' });

  const v1 = await createWalkIn(db, {
    organizationId: ORG,
    locationId: LOC,
    serviceIds: [manicure],
    actor: { userId: reception.userId },
    client: { name: 'Jane Client', phone: '+18135550199' },
  });
  if (!v1.ok) throw new Error('walk-in');
  await callNext(db, { visitId: v1.visitId, actor: { userId: reception.userId }, locationId: LOC });
  const call1 = await openCallFor(db, a.id);
  await respondToCall(db, {
    callId: call1!.callId,
    technicianId: a.id,
    response: 'denied',
    denyReason: 'client_issue',
    actor: { userId: a.userId },
  });
  await callNext(db, { visitId: v1.visitId, actor: desk, locationId: LOC });
  const call2 = await openCallFor(db, b.id);
  await respondToCall(db, {
    callId: call2!.callId,
    technicianId: b.id,
    response: 'accepted',
    actor: { userId: b.userId },
  });
  await finishVisit(db, { technicianId: b.id, actor: { userId: b.userId } });

  // Excuse Thảo's deny.
  const [deny] = await sql<
    { id: string }[]
  >`select id from turn_ledger where technician_id = ${a.id} and reason_type = 'deny'`;
  await excusePenalty(db, { ledgerId: deny!.id, actor: mgr, reason: 'client left' });

  // A second walk-in, reassigned by the manager.
  const v2 = await createWalkIn(db, {
    organizationId: ORG,
    locationId: LOC,
    serviceIds: [manicure],
    actor: desk,
  });
  if (!v2.ok) throw new Error('walk-in 2');
  await callNext(db, { visitId: v2.visitId, actor: desk, locationId: LOC });
  await reassignVisit(db, {
    visitId: v2.visitId,
    toTechnicianId: b.id,
    actor: mgr,
    reason: 'client asked for Linh',
  });

  // Rule change and a role change.
  const cfg = structuredClone(await activeRules(db, LOC));
  cfg.penalties.deny = 2;
  const saved = await saveRuleConfig(db, {
    organizationId: ORG,
    locationId: LOC,
    config: cfg,
    actor: { userId: owner.userId },
    note: 'deny costs 2',
  });
  if (!saved.ok) throw new Error(`rules: ${JSON.stringify(saved)}`);
  const extra = await person('Lan', 'receptionist');
  await changeRole(db, {
    actor: { userId: owner.userId, role: 'owner', organizationId: ORG, locationId: LOC },
    membershipId: extra.membershipId,
    toRole: 'manager',
    reason: 'promoted',
  });
  await transition(db, { technicianId: c.id, to: 'available', actor: { userId: c.userId } });

  rows = await auditEntries(db, { locationId: LOC, from: today, to: today });
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

describe('every event in the design doc audit table, with its fields', () => {
  it('check-in: technician, time, geofence result, late minutes', () => {
    const r = find('check_in', (x) => x.technicianId === a.id);
    expect(r?.technicianName).toBe('Thảo');
    expect(r?.at).toBeInstanceOf(Date);
    expect(field(r, 'geofence')).toBeDefined();
    expect(field(r, 'late_min')).toBe('0');
  });

  it('ready, break, back: technician and the move', () => {
    expect(
      field(
        find('break', (x) => x.technicianId === c.id),
        'to',
      ),
    ).toBe('break');
    const back = find('available', (x) => x.technicianId === c.id && field(x, 'from') === 'break');
    expect(back?.technicianName).toBe('Vy');
  });

  it('call sent: visit, technician, and the queue snapshot', () => {
    const r = find('call_sent');
    expect(field(r, 'visit')).toBeDefined();
    expect(r?.technicianName).toBeTruthy();
    expect(r?.queue?.length).toBeGreaterThan(0);
  });

  it('accept and deny: technician, response time, deny reason', () => {
    const d = find('call_denied');
    expect(d?.technicianName).toBe('Thảo');
    expect(field(d, 'deny_reason')).toBe('client_issue');
    expect(Number(field(d, 'response_s'))).toBeGreaterThanOrEqual(0);
    const acc = find('call_accepted');
    expect(acc?.technicianName).toBe('Linh');
    expect(field(acc, 'response_s')).toBeDefined();
  });

  it('points posted: ledger row, delta, reason type, visit', () => {
    const r = find('points_posted', (x) => field(x, 'reason_type') === 'visit');
    expect(field(r, 'ledger')).toMatch(/^[0-9a-f-]{36}$/);
    expect(field(r, 'delta')).toBe('+1');
    expect(field(r, 'visit')).toBeDefined();
    expect(r?.technicianName).toBe('Linh');
  });

  it('manual adjustment: manager, target, before, after, reason', () => {
    const r = find('points_adjusted');
    expect(r?.actorName).toBe('Mai');
    expect(r?.actorRole).toBe('manager');
    expect(r?.technicianName).toBe('Linh');
    expect(field(r, 'before')).toBe('0');
    expect(field(r, 'after')).toBe('0.5');
    expect(r?.reason).toBe('late from lunch');
  });

  it('excused deny: manager, original deny, reason', () => {
    const r = find('deny_excused');
    expect(r?.actorName).toBe('Mai');
    expect(field(r, 'original_ledger')).toMatch(/^[0-9a-f-]{36}$/);
    expect(r?.reason).toBe('client left');
    expect(r?.technicianName).toBe('Thảo');
  });

  it('reassign: manager, from, to, reason', () => {
    const r = find('visit_reassigned');
    expect(field(r, 'to')).toBe('Linh');
    expect(r?.reason).toBe('client asked for Linh');
  });

  it('rule config change: owner, version before and after, and no config dump', () => {
    const r = find('rule_config_changed');
    expect(r?.actorName).toBe('Phú');
    expect(Number(field(r, 'version_after'))).toBe(Number(field(r, 'version_before')) + 1);
    expect(JSON.stringify(r?.fields)).not.toContain('penalties');
  });

  it('role change: actor, target user, before, after', () => {
    const r = find('role_changed');
    expect(field(r, 'user')).toBe('Lan');
    expect(field(r, 'from')).toBe('receptionist');
    expect(field(r, 'to')).toBe('manager');
  });

  it('no client name or phone anywhere in the viewer rows', () => {
    const text = JSON.stringify(rows);
    expect(text).not.toContain('Jane Client');
    expect(text).not.toContain('5550199');
  });
});

describe('the queue snapshot', () => {
  it('shows every technician on shift with points and status at that second', () => {
    // The first call: Thảo 0, Vy on break, Linh ½.
    const first = rows.filter((r) => r.action === 'call_sent').at(-1);
    const q = first!.queue!;
    expect(q.map((e) => e.name).sort()).toEqual(['Linh', 'Thảo', 'Vy']);
    expect(q.find((e) => e.name === 'Linh')).toMatchObject({ points: 0.5, status: 'available' });
    expect(q.find((e) => e.name === 'Vy')).toMatchObject({ status: 'break', eligible: false });
    expect(q[0]).toMatchObject({ name: 'Thảo', points: 0, eligible: true });
  });
});

describe('filters', () => {
  it('by technician: only entries about that technician', async () => {
    const vy = await auditEntries(db, {
      locationId: LOC,
      from: today,
      to: today,
      technicianId: c.id,
    });
    expect(vy.length).toBeGreaterThan(0);
    expect(vy.every((r) => r.technicianId === c.id)).toBe(true);
  });

  it('by action', async () => {
    const denies = await auditEntries(db, {
      locationId: LOC,
      from: today,
      to: today,
      action: 'call_denied',
    });
    expect(denies.map((r) => r.action)).toEqual(['call_denied']);
  });

  it('a range over 31 days or a bad date returns nothing', async () => {
    expect(
      await auditEntries(db, { locationId: LOC, from: '2026-01-01', to: '2026-03-01' }),
    ).toEqual([]);
    expect(await auditEntries(db, { locationId: LOC, from: 'x', to: today })).toEqual([]);
    expect(parseDate('2026-02-30')).toBeNull();
  });

  it('another location sees none of these rows', async () => {
    const other = randomUUID();
    expect(await auditEntries(db, { locationId: other, from: today, to: today })).toEqual([]);
  });
});

describe('CSV', () => {
  it('matches the viewer table row for row', () => {
    const table = auditTable(rows, TZ, LABELS);
    const csv = toCsv(table.header, table.body);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines).toHaveLength(rows.length + 1);
    expect(parseCsvLine(lines[0]!)).toEqual(table.header);
    table.body.forEach((cells, i) => {
      const parsed = parseCsvLine(lines[i + 1]!).map((v) => (v.startsWith("'") ? v.slice(1) : v));
      expect(parsed).toEqual(cells);
    });
  });

  it('a cell a spreadsheet would run as a formula stays text', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('+1')).toBe('"\'+1"');
    expect(csvCell('-0.5')).toBe('"\'-0.5"');
    expect(csvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(csvCell('\t=1')).toBe('"\'\t=1"');
    expect(csvCell('  =1')).toBe('"\'  =1"');
    expect(csvCell('Thảo')).toBe('"Thảo"');
  });

  it('redact drops personal keys at any depth', () => {
    expect(
      redact({ a: 1, clientName: 'x', inner: { phone: '1', ok: true, url: 'https://x' } }),
    ).toEqual({ a: 1, inner: { ok: true } });
  });
});

describe('daily report, overrides summary, end-of-day summary', () => {
  it('counts the day per technician from the ledger and the calls', async () => {
    const r = await dailyTurnReport(db, LOC, today);
    const linh = r!.technicians.find((t) => t.name === 'Linh')!;
    expect(linh.visitsCompleted).toBe(1);
    expect(linh.byReason.manual).toBe(0.5);
    expect(linh.accepted).toBeGreaterThanOrEqual(1);
    const thao = r!.technicians.find((t) => t.name === 'Thảo')!;
    expect(thao.denied).toBe(1);
    expect(thao.points).toBe(0); // the deny was excused
    expect(r!.totals.denies).toBe(1);
    expect(r!.totals.overrides).toBeGreaterThanOrEqual(3);
  });

  it('overrides per person: the manager and the receptionist each counted', async () => {
    const s = await overrideSummary(db, LOC, today, today);
    const mai = s.find((p) => p.name === 'Mai')!;
    expect(mai.counts['points_adjusted']).toBe(1);
    expect(mai.counts['deny_excused']).toBe(1);
    expect(mai.counts['visit_reassigned']).toBe(1);
    expect(s.find((p) => p.name === 'Kim')?.counts['visit_created']).toBe(1);
  });

  it('end of day: refused for today, written once for a closed day, never changed', async () => {
    expect(await ensureDailySummary(db, LOC, today)).toBeNull();
    const tomorrow = new Date(Date.now() + 86_400_000);
    const s = await ensureDailySummary(db, LOC, today, tomorrow);
    expect(s?.denies).toBe(1);
    expect(s?.overridesBy.find((p) => p.name === 'Mai')?.total).toBe(3);
    expect(JSON.stringify(s)).not.toContain('Jane');
    const again = await ensureDailySummary(db, LOC, today, tomorrow);
    expect(again).toEqual(await storedSummary(db, LOC, today));
    await expect(sql`update daily_summaries set summary = '{}'`).rejects.toThrow(/append-only/);
    await expect(sql`delete from daily_summaries`).rejects.toThrow(/append-only/);
  });
});

describe('who can read the log', () => {
  it('a receptionist cannot read the audit log or the summaries', async () => {
    const n = await asUser(reception.userId, async (tx) => {
      const [x] = await tx<{ n: string }[]>`select count(*) as n from audit_log`;
      const [y] = await tx<{ n: string }[]>`select count(*) as n from daily_summaries`;
      return [Number(x!.n), Number(y!.n)];
    });
    expect(n).toEqual([0, 0]);
  });

  it('a technician cannot read it either', async () => {
    const n = await asUser(a.userId, async (tx) => {
      const [x] = await tx<{ n: string }[]>`select count(*) as n from audit_log`;
      return Number(x!.n);
    });
    expect(n).toBe(0);
  });

  it('the manager and the owner can', async () => {
    for (const p of [manager, owner]) {
      const n = await asUser(p.userId, async (tx) => {
        const [x] = await tx<{ n: string }[]>`select count(*) as n from audit_log`;
        return Number(x!.n);
      });
      expect(n).toBeGreaterThan(0);
    }
  });

  it('no app role can write a summary', async () => {
    await expect(
      asUser(
        owner.userId,
        (tx) =>
          tx`insert into daily_summaries (organization_id, location_id, date, summary) values (${ORG}, ${LOC}, '2026-01-01', '{}')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

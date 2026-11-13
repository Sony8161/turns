// v0.17.0 "First-week gaps" (17-Next-Build-Plan.md, Release 1).
//  1. the desk acts for a technician (accept, deny, finish), audited;
//  2. the day-end close-out, a day-two test and both clock-change days;
//  3. left without service and no-shows, counted, never against a tech;
//  4. fairness: a tech's "client left" waits for the desk, the free-deny
//     flag and limit, the fairness table;
//  5. review findings #1 and #12;
//  6. small leftovers that live in the database layer.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actedForToday,
  deskAnswerCall,
  deskFinishVisit,
  mayActForTechnicians,
  setReceptionistActsFor,
} from '../src/act-for';
import { markNoShow } from '../src/appointments';
import { techBoard } from '../src/board';
import { clientDetail } from '../src/clients';
import {
  callNext,
  clientHere,
  clientLeft,
  createWalkIn,
  deskOptions,
  DENY_REASONS,
  finishVisit,
  freeDeniesToday,
  leftClaims,
  leftWithoutService,
  openCallFor,
  queueFor,
  respondToCall,
  waitingVisits,
} from '../src/engine';
import { askForHelp, myOpenHelp, openHelpRequests } from '../src/help';
import { createKioskDevice, kioskCheckIn, pairKiosk } from '../src/kiosk';
import { setTechnicianLevel, type SkillLevel } from '../src/levels';
import {
  dailyTurnReport,
  ensureDailySummary,
  fairnessReport,
  lastDays,
  localDate,
  previousDate,
} from '../src/reports';
import { activeRules, saveRuleConfig, validateRuleConfig, type RuleConfig } from '../src/rules';
import { HEAVENLY, HEAVENLY_RULE_CONFIG_V1, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import type { StaffActor } from '../src/staff';
import { staffSetStatus } from '../src/tech-settings';
import { checkIn, shiftTotal, sweepFloor, transition } from '../src/status';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
const TZ = HEAVENLY.timezone;
const nobody = { userId: null };
let owner: StaffActor;
let manager: StaffActor;
let reception: StaffActor;
const receptionName = 'Hạnh';
type Tech = { id: string; userId: string; name: string };
const svc: Record<string, string> = {};

async function newUser(name: string, role: string): Promise<string> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${role}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${LOC}, ${role}::role)`;
  return userId;
}

async function newTech(name: string, level: SkillLevel = 'acrylic', not: string[] = []) {
  const userId = await newUser(name, 'technician');
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${userId}, ${ORG}, ${LOC}, ${name}) returning id`;
  const filled = await setTechnicianLevel(db, { actor: owner, technicianId: t!.id, level });
  if (!filled.ok) throw new Error(filled.reason);
  if (not.length) {
    const off = new Set(not.map((n) => svc[n]!));
    const r = await setTechnicianLevel(db, {
      actor: owner,
      technicianId: t!.id,
      level,
      serviceIds: filled.serviceIds.filter((id) => !off.has(id)),
    });
    if (!r.ok) throw new Error(r.reason);
  }
  return { id: t!.id, userId, name } as Tech;
}

async function onFloor(t: Tech, minutesAgo: number) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  const c = await checkIn(db, {
    technicianId: t.id,
    actor: { userId: t.userId },
    position: null,
    now: at,
  });
  if (!c.ok) throw new Error(`check-in ${t.name}: ${c.reason}`);
  await transition(db, { technicianId: t.id, to: 'available', actor: { userId: t.userId } });
}

/** End of a block: everyone off the floor, every open thing closed. */
async function clearFloor() {
  await sql`update turn_calls set responded_at = now(), response = 'overridden' where responded_at is null`;
  await sql`update visits set status = 'cancelled', cancelled_at = now() where status in ('waiting', 'called', 'in_service')`;
  await sql`update help_requests set acknowledged_at = now() where acknowledged_at is null`;
  await sql`update shifts set checked_out_at = now() where checked_out_at is null`;
  await sql`update technician_status set status = 'off', shift_id = null where status <> 'off'`;
}

async function pointsOf(t: Tech): Promise<number> {
  const [s] = await sql<
    { shift_id: string }[]
  >`select shift_id from technician_status where technician_id = ${t.id}`;
  return shiftTotal(db, s!.shift_id);
}

async function walkIn(names: string[], extra: Partial<Parameters<typeof createWalkIn>[1]> = {}) {
  const v = await createWalkIn(db, {
    organizationId: ORG,
    locationId: LOC,
    serviceIds: names.map((n) => svc[n]!),
    actor: nobody,
    ...extra,
  });
  if (!v.ok) throw new Error(v.reason);
  return v.visitId;
}

async function mustCall(visitId: string, who: Tech): Promise<string> {
  const r = await callNext(db, { visitId, actor: nobody, locationId: LOC });
  if (!r.ok) throw new Error(`call: ${r.reason} ${r.detail ?? ''}`);
  if (r.technicianId !== who.id) throw new Error(`expected ${who.name} to be called`);
  return r.callId;
}

const accept = (callId: string, t: Tech, keepServiceIds?: string[]) =>
  respondToCall(db, {
    callId,
    technicianId: t.id,
    response: 'accepted',
    actor: { userId: t.userId },
    ...(keepServiceIds ? { keepServiceIds } : {}),
  });

const deny = (callId: string, t: Tech, denyReason: (typeof DENY_REASONS)[number]) =>
  respondToCall(db, {
    callId,
    technicianId: t.id,
    response: 'denied',
    denyReason,
    actor: { userId: t.userId },
  });

async function saveRules(change: (c: RuleConfig) => void) {
  const c = structuredClone(await activeRules(db, LOC));
  change(c);
  const r = await saveRuleConfig(db, {
    organizationId: ORG,
    locationId: LOC,
    config: c,
    actor: { userId: owner.userId },
  });
  if (!r.ok) throw new Error(JSON.stringify(r));
}

async function statusOf(t: Tech): Promise<string> {
  const [r] = await sql<
    { status: string }[]
  >`select status from technician_status where technician_id = ${t.id}`;
  return r?.status ?? 'off';
}

beforeAll(async () => {
  await resetAndMigrate();
  await seedHeavenly(TEST_URL);
  db = createDb(TEST_URL);
  for (const s of await sql<
    { id: string; name: string }[]
  >`select id, name from services where location_id = ${LOC}`) {
    svc[s.name] = s.id;
  }
  const actor = async (name: string, role: 'owner' | 'manager' | 'receptionist') => ({
    userId: await newUser(name, role),
    role,
    organizationId: ORG,
    locationId: LOC,
  });
  owner = await actor('Phu', 'owner');
  manager = await actor('Vy', 'manager');
  reception = await actor(receptionName, 'receptionist');
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

// ---------------------------------------------------------------------------
describe('rules: the v0.17.0 settings', () => {
  it('Heavenly defaults: ask the desk, flag at 3, no limit, finish at day end', () => {
    expect(HEAVENLY_RULE_CONFIG_V1.fairness).toEqual({
      client_left_by_tech: 'ask_desk',
      free_deny_flag: 3,
      free_deny_daily_limit: null,
    });
    expect(HEAVENLY_RULE_CONFIG_V1.closing).toEqual({
      day_end_in_service: 'finish',
      no_show_after_min: 0,
    });
  });

  it('a config saved before v0.17.0 still validates, with the defaults', () => {
    const old = structuredClone(HEAVENLY_RULE_CONFIG_V1) as Partial<RuleConfig>;
    delete old.fairness;
    delete old.closing;
    const r = validateRuleConfig(old);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.fairness.client_left_by_tech).toBe('ask_desk');
      expect(r.config.closing.day_end_in_service).toBe('finish');
    }
  });

  it('refuses values outside the choices', () => {
    const bad = structuredClone(HEAVENLY_RULE_CONFIG_V1) as unknown as Record<
      string,
      Record<string, unknown>
    >;
    bad['fairness']!['client_left_by_tech'] = 'ignore';
    bad['fairness']!['free_deny_flag'] = -1;
    bad['closing']!['no_show_after_min'] = 1.5;
    const r = validateRuleConfig(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.path).sort()).toEqual([
        'closing.no_show_after_min',
        'fairness.client_left_by_tech',
        'fairness.free_deny_flag',
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
describe('1. the desk acts for a technician', () => {
  let a: Tech;
  let b: Tech;
  beforeAll(async () => {
    a = await newTech('Act A');
    b = await newTech('Act B');
  });

  it('owner and manager always; receptionist by the owner switch (on by default)', async () => {
    expect(await mayActForTechnicians(db, owner)).toBe(true);
    expect(await mayActForTechnicians(db, manager)).toBe(true);
    expect(await mayActForTechnicians(db, reception)).toBe(true);
    expect(await mayActForTechnicians(db, { role: 'technician', locationId: LOC })).toBe(false);
    expect(await setReceptionistActsFor(db, { actor: manager, on: false })).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect(await setReceptionistActsFor(db, { actor: owner, on: false })).toEqual({ ok: true });
    expect(await mayActForTechnicians(db, reception)).toBe(false);
    expect(await mayActForTechnicians(db, manager)).toBe(true);
    const [row] = await sql`select after from audit_log where action = 'act_for_setting'`;
    expect(row!['after']).toEqual({ receptionistActsForTechnicians: false });
    await setReceptionistActsFor(db, { actor: owner, on: true });
  });

  it('accept for her: same move as her phone, and the log says who did it for whom', async () => {
    await onFloor(a, 30);
    await onFloor(b, 20);
    const v = await walkIn(['Spa pedicure']);
    const callId = await mustCall(v, a);
    const r = await deskAnswerCall(db, { actor: reception, callId, response: 'accepted' });
    expect(r).toEqual({ ok: true });
    expect(await statusOf(a)).toBe('in_service');
    const [call] = await sql`select answered_by, response from turn_calls where id = ${callId}`;
    expect(call!['answered_by']).toBe(reception.userId);
    expect(call!['response']).toBe('accepted');
    const [audit] = await sql`select actor_user_id, after from audit_log
      where action = 'call_accepted' and entity_id = ${callId}`;
    expect(audit!['actor_user_id']).toBe(reception.userId);
    expect(audit!['after']).toMatchObject({ actedFor: a.id, by: 'desk' });
  });

  it('finish for her: points post on her shift, the visit records who pressed it', async () => {
    const r = await deskFinishVisit(db, { actor: reception, technicianId: a.id });
    expect(r).toMatchObject({ ok: true, points: 1 });
    expect(await statusOf(a)).toBe('available');
    expect(await pointsOf(a)).toBe(1);
    const [v] = await sql`select finished_by, status from visits
      where assigned_technician_id = ${a.id} order by completed_at desc limit 1`;
    expect(v).toMatchObject({ finished_by: reception.userId, status: 'completed' });
  });

  it('deny for her: the same penalty rules as her phone', async () => {
    const v1 = await walkIn(['Spa pedicure']);
    const c1 = await mustCall(v1, b);
    expect(
      await deskAnswerCall(db, {
        actor: manager,
        callId: c1,
        response: 'denied',
        denyReason: 'client_issue',
      }),
    ).toEqual({ ok: true });
    expect(await pointsOf(b)).toBe(1);
    // A reason the rules excuse stays free when the desk taps it, too.
    const c2 = await mustCall(v1, a);
    expect(
      await deskAnswerCall(db, {
        actor: reception,
        callId: c2,
        response: 'denied',
        denyReason: 'break_needed',
      }),
    ).toEqual({ ok: true });
    expect(await pointsOf(a)).toBe(1);
    // A deny needs a reason the rules know.
    const c3 = await mustCall(v1, b);
    expect(
      await deskAnswerCall(db, {
        actor: reception,
        callId: c3,
        response: 'denied',
        denyReason: 'because' as never,
      }),
    ).toMatchObject({ ok: false });
    await deskAnswerCall(db, { actor: reception, callId: c3, response: 'accepted' });
    await deskFinishVisit(db, { actor: reception, technicianId: b.id });
  });

  it('refused when the switch is off, at another location, or for nothing open', async () => {
    const v = await walkIn(['Spa pedicure']);
    const callId = await mustCall(v, a);
    await setReceptionistActsFor(db, { actor: owner, on: false });
    expect(await deskAnswerCall(db, { actor: reception, callId, response: 'accepted' })).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    await setReceptionistActsFor(db, { actor: owner, on: true });
    expect(
      await deskAnswerCall(db, {
        actor: { ...manager, locationId: randomUUID() },
        callId,
        response: 'accepted',
      }),
    ).toEqual({ ok: false, reason: 'wrong_location' });
    expect(await deskFinishVisit(db, { actor: manager, technicianId: b.id })).toEqual({
      ok: false,
      reason: 'no_visit_in_service',
    });
    await deskAnswerCall(db, { actor: owner, callId, response: 'accepted' });
  });

  it('her phone lists what was done for her today, with who and when', async () => {
    const lines = await actedForToday(db, a.id);
    expect(lines.map((l) => [l.what, l.by])).toEqual([
      ['accepted', receptionName],
      ['finished', receptionName],
      ['denied', receptionName],
      ['accepted', 'Phu'],
    ]);
    expect(lines[2]!.reason).toBe('break_needed');
    expect(lines.every((l) => l.at instanceof Date)).toBe(true);
    // Her own taps are not listed.
    expect((await actedForToday(db, b.id)).map((l) => l.what)).toEqual([
      'denied',
      'accepted',
      'finished',
    ]);
  });

  it('review #1: the desk cannot set a technician in service to another status', async () => {
    expect(await statusOf(a)).toBe('in_service');
    for (const to of ['available', 'break', 'off'] as const) {
      expect(await staffSetStatus(db, { actor: manager, technicianId: a.id, to })).toEqual({
        ok: false,
        reason: 'in_service',
      });
    }
    expect(await statusOf(a)).toBe('in_service');
    await finishVisit(db, { technicianId: a.id, actor: { userId: a.userId } });
    expect(
      await staffSetStatus(db, { actor: manager, technicianId: a.id, to: 'break' }),
    ).toMatchObject({ ok: true });
    await clearFloor();
  });
});

// ---------------------------------------------------------------------------
describe('2. day-end close-out', () => {
  let a: Tech; // in service yesterday (its client has a held second part)
  let b: Tech; // called yesterday, never answers
  let c: Tech; // on break yesterday, asked for help
  let d: Tech; // in service yesterday; a client asked for her while busy
  const today = () => localDate(new Date(), TZ);

  beforeAll(async () => {
    a = await newTech('Day A', 'gel', ['Dip powder']);
    b = await newTech('Day B', 'regular');
    c = await newTech('Day C');
    d = await newTech('Day D');
  });

  it('day two: everything left open yesterday is closed, the board is clean, all can check in', async () => {
    for (const [t, ago] of [
      [a, 40],
      [b, 30],
      [c, 20],
      [d, 10],
    ] as const) {
      await onFloor(t, ago);
    }
    // A in service on the pedicure part; the dip waits as the held second part.
    const mixed = await walkIn(['Dip powder', 'Basic pedicure']);
    expect(await accept(await mustCall(mixed, a), a)).toMatchObject({ ok: true });
    // D in service on a client who asked for her.
    const dv = await walkIn(['Spa pedicure'], { requestedTechnicianId: d.id });
    expect(await accept(await mustCall(dv, d), d)).toMatchObject({ ok: true });
    // Asked for D while she is busy: a request hold.
    await walkIn(['Spa pedicure'], { requestedTechnicianId: d.id });
    // B called, never answers.
    const called = await walkIn(['Basic pedicure']);
    await mustCall(called, b);
    // C asks for help, then goes on break.
    expect(await askForHelp(db, { technicianId: c.id, actor: { userId: c.userId } })).toMatchObject(
      { ok: true },
    );
    await transition(db, { technicianId: c.id, to: 'break', actor: { userId: c.userId } });
    // Plain waiting, an unconfirmed kiosk check-in, a fix waiting for approval.
    await walkIn(['Basic pedicure']);
    const device = await createKioskDevice(db, { actor: owner, name: 'Day kiosk', pin: '4321' });
    if (!device.ok) throw new Error(device.reason);
    const paired = await pairKiosk(db, { code: device.pairingCode });
    if (!paired.ok) throw new Error(paired.reason);
    expect(
      await kioskCheckIn(db, {
        device: paired.device,
        name: 'Late',
        serviceIds: [svc['Basic pedicure']!],
      }),
    ).toMatchObject({ ok: true });
    const fix = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [svc['Nail fix / repair']!],
      actor: { userId: reception.userId },
      fix: { enteredBy: 'receptionist' },
    });
    expect(fix).toMatchObject({ ok: true });

    // Everything above happened yesterday.
    await sql`update visits set arrived_at = arrived_at - interval '1 day',
      started_at = started_at - interval '1 day' where location_id = ${LOC}
      and status in ('waiting', 'called', 'in_service')`;
    await sql`update turn_calls set called_at = called_at - interval '1 day' where responded_at is null`;
    const yesterday = previousDate(today());
    await sql`update shifts set date = ${yesterday}::date, checked_in_at = checked_in_at - interval '1 day'
      where checked_out_at is null`;
    await sql`update help_requests set created_at = created_at - interval '1 day' where acknowledged_at is null`;
    await sql`update technician_status set since = since - interval '1 day' where status <> 'off'`;
    const [stamp] = await sql<{ mark: Date }[]>`select now() as mark`;
    const mark = stamp!.mark;

    const swept = await sweepFloor(db, LOC);
    expect(swept.closed).toEqual({ visits: 6, autoFinished: 2, calls: 1, help: 1 });
    expect(swept.autoCheckedOut.sort()).toEqual([a.id, b.id, c.id, d.id].sort());

    // A clean board.
    expect(
      await sql`select id from visits where location_id = ${LOC}
        and status in ('waiting', 'called', 'in_service')`,
    ).toEqual([]);
    expect(await sql`select id from turn_calls where responded_at is null`).toEqual([]);
    expect(await openHelpRequests(db, LOC)).toEqual([]);
    expect(await myOpenHelp(db, c.id)).toBeNull();
    expect(await waitingVisits(db, LOC)).toEqual([]);
    for (const t of [a, b, c, d]) expect(await statusOf(t)).toBe('off');
    expect(await sql`select id from shifts where checked_out_at is null`).toEqual([]);

    // Waiting, called, unconfirmed, pending, held and request hold: closed, no points.
    const closed = await sql<{ status: string }[]>`
      select status from visits where close_reason = 'day_end'`;
    expect(closed.length).toBe(6);
    expect(closed.every((v) => v.status === 'cancelled')).toBe(true);
    // In service: finished, points on yesterday's shift, marked auto-finished.
    const finished = await sql<{ assigned_technician_id: string }[]>`
      select assigned_technician_id from visits where auto_finished`;
    expect(finished.map((f) => f.assigned_technician_id).sort()).toEqual([a.id, d.id].sort());
    const newLedger = await sql<{ delta: string; reason_type: string; date: string }[]>`
      select l.delta, l.reason_type, to_char(s.date, 'YYYY-MM-DD') as date
      from turn_ledger l join shifts s on s.id = l.shift_id
      where l.created_at >= ${mark}`;
    expect(newLedger.map((l) => [l.reason_type, Number(l.delta), l.date])).toEqual([
      ['visit', 1, yesterday],
      ['visit', 1, yesterday],
    ]);
    // The call closed as expired, no deny.
    const [call] = await sql`select response from turn_calls where technician_id = ${b.id}
      order by called_at desc limit 1`;
    expect(call!['response']).toBe('expired');

    // Every change is in the log with the day it belonged to.
    const rows = await sql<{ action: string; n: number }[]>`
      select action, count(*)::int as n from audit_log
      where after->>'forDay' = ${yesterday} group by action order by action`;
    expect(Object.fromEntries(rows.map((r) => [r.action, r.n]))).toEqual({
      auto_check_out: 4,
      call_closed_day_end: 1,
      help_closed_day_end: 1,
      visit_auto_finished: 2,
      visit_closed_day_end: 6,
    });

    // The end-of-day summary lists it.
    const summary = await ensureDailySummary(db, LOC, yesterday);
    expect(summary?.closedAtDayEnd).toEqual({
      visits: 6,
      autoFinished: 2,
      calls: 1,
      help: 1,
      shifts: 4,
    });

    // A second sweep finds nothing.
    expect((await sweepFloor(db, LOC)).closed).toEqual({
      visits: 0,
      autoFinished: 0,
      calls: 0,
      help: 0,
    });

    // Every technician can check in today, and the line works.
    for (const t of [a, b, c, d]) {
      const r = await checkIn(db, {
        technicianId: t.id,
        actor: { userId: t.userId },
        position: null,
      });
      expect(r).toMatchObject({ ok: true });
      await transition(db, { technicianId: t.id, to: 'available', actor: { userId: t.userId } });
      expect(await pointsOf(t)).toBe(0);
    }
    const fresh = await walkIn(['Basic pedicure']);
    expect(await callNext(db, { visitId: fresh, actor: nobody, locationId: LOC })).toMatchObject({
      ok: true,
    });
    // Help works again today.
    expect(await askForHelp(db, { technicianId: c.id, actor: { userId: c.userId } })).toMatchObject(
      { ok: true, alreadyOpen: false },
    );
    await clearFloor();
  });

  it('closing.day_end_in_service = close: no points for a visit left in service', async () => {
    await saveRules((cfg) => {
      cfg.closing.day_end_in_service = 'close';
    });
    await onFloor(a, 60);
    const v = await walkIn(['Basic pedicure']);
    await accept(await mustCall(v, a), a);
    await sql`update visits set arrived_at = arrived_at - interval '2 days', started_at = started_at - interval '2 days' where id = ${v}`;
    await sql`update shifts set date = ${today()}::date - 3, checked_in_at = checked_in_at - interval '2 days' where checked_out_at is null`;
    const r = await sweepFloor(db, LOC);
    expect(r.closed).toMatchObject({ visits: 1, autoFinished: 0 });
    const [row] = await sql`select status, close_reason, points_posted from visits where id = ${v}`;
    expect(row).toMatchObject({
      status: 'cancelled',
      close_reason: 'day_end',
      points_posted: null,
    });
    expect(await statusOf(a)).toBe('off');
    await saveRules((cfg) => {
      cfg.closing.day_end_in_service = 'finish';
    });
    await clearFloor();
  });

  it('review #12: help needs her on shift', async () => {
    expect(await statusOf(c)).toBe('off');
    expect(await askForHelp(db, { technicianId: c.id, actor: { userId: c.userId } })).toEqual({
      ok: false,
      reason: 'not_on_shift',
    });
  });
});

// ---------------------------------------------------------------------------
describe('2b. both clock-change days in the location zone', () => {
  // 2026 in America/New_York: forward on Sunday March 8 (02:00 EST becomes
  // 03:00 EDT), back on Sunday November 1 (02:00 EDT becomes 01:00 EST).
  let t: Tech;
  beforeAll(async () => {
    await clearFloor();
    t = await newTech('Clock');
  });
  const at = (iso: string) => new Date(iso);

  async function wipe() {
    await sql`update technician_status set status = 'off', shift_id = null where technician_id = ${t.id}`;
    await sql`delete from turn_ledger where technician_id = ${t.id}`;
    await sql`delete from shifts where technician_id = ${t.id}`;
  }

  async function shiftDate(): Promise<string> {
    const [s] = await sql`select to_char(date, 'YYYY-MM-DD') as d from shifts
      where technician_id = ${t.id} order by checked_in_at desc limit 1`;
    return s!['d'] as string;
  }

  for (const day of [
    {
      name: 'spring forward',
      eveBefore: '2026-03-08T01:00:00Z', // Sat Mar 7, 20:00 EST
      afterChange: '2026-03-08T07:30:00Z', // Sun Mar 8, 03:30 EDT
      date: '2026-03-08',
      eve: '2026-03-07',
      lateCheckIn: '2026-03-08T13:20:00Z', // 09:20 EDT
      // Out at 01:30 EST; back at 03:00 EDT is 30 real minutes (the wall says
      // 90); back at 03:35 EDT is 65.
      outAt: '2026-03-08T06:30:00Z',
      backShort: '2026-03-08T07:00:00Z',
      backLong: '2026-03-08T07:35:00Z',
      // An appointment at 03:10 EDT: 20 real minutes after 01:50 EST (held),
      // 40 after 01:30 EST (the wall says 100; free).
      appointment: '2026-03-08T07:10:00Z',
      heldAt: '2026-03-08T06:50:00Z',
      freeAt: '2026-03-08T06:30:00Z',
    },
    {
      name: 'fall back',
      eveBefore: '2026-11-01T00:00:00Z', // Sat Oct 31, 20:00 EDT
      afterChange: '2026-11-01T06:30:00Z', // Sun Nov 1, 01:30 EST
      date: '2026-11-01',
      eve: '2026-10-31',
      lateCheckIn: '2026-11-01T14:20:00Z', // 09:20 EST
      // Out at 01:10 EDT; back at 01:50 EDT is 40 real minutes; back at 01:20
      // EST is 70 (the wall says 10).
      outAt: '2026-11-01T05:10:00Z',
      backShort: '2026-11-01T05:50:00Z',
      backLong: '2026-11-01T06:20:00Z',
      // An appointment at 01:20 EST: 25 real minutes after 01:55 EDT (held,
      // though the wall says it already started), 40 after 01:40 EDT (free).
      appointment: '2026-11-01T06:20:00Z',
      heldAt: '2026-11-01T05:55:00Z',
      freeAt: '2026-11-01T05:40:00Z',
    },
  ]) {
    describe(day.name, () => {
      it('the day resets at local midnight', async () => {
        await wipe();
        expect(
          await checkIn(db, {
            technicianId: t.id,
            actor: { userId: t.userId },
            position: null,
            now: at(day.eveBefore),
          }),
        ).toMatchObject({ ok: true });
        expect(await shiftDate()).toBe(day.eve);
        const swept = await sweepFloor(db, LOC, at(day.afterChange));
        expect(swept.autoCheckedOut).toContain(t.id);
        expect(await statusOf(t)).toBe('off');
        expect(
          await checkIn(db, {
            technicianId: t.id,
            actor: { userId: t.userId },
            position: null,
            now: at(day.afterChange),
          }),
        ).toMatchObject({ ok: true });
        expect(await shiftDate()).toBe(day.date);
      });

      it('the late penalty counts local wall-clock minutes', async () => {
        await wipe();
        await sql`insert into shifts (organization_id, location_id, technician_id, date, scheduled_start, checked_in_at)
          values (${ORG}, ${LOC}, ${t.id}, ${day.date}, '09:00', ${at(day.lateCheckIn)})`;
        expect(
          await checkIn(db, {
            technicianId: t.id,
            actor: { userId: t.userId },
            position: null,
            now: at(day.lateCheckIn),
          }),
        ).toMatchObject({ ok: true });
        const [s] = await sql`select late_minutes from shifts where technician_id = ${t.id}`;
        expect(s!['late_minutes']).toBe(20);
        expect(await pointsOf(t)).toBe(0.5);
      });

      it('the out-over penalty counts real minutes', async () => {
        for (const [back, posts] of [
          [day.backShort, false],
          [day.backLong, true],
        ] as const) {
          await wipe();
          const start = new Date(at(day.outAt).getTime() - 10 * 60_000);
          const me = { userId: t.userId };
          await checkIn(db, { technicianId: t.id, actor: me, position: null, now: start });
          await transition(db, { technicianId: t.id, to: 'available', actor: me, now: start });
          await transition(db, { technicianId: t.id, to: 'out', actor: me, now: at(day.outAt) });
          await transition(db, { technicianId: t.id, to: 'available', actor: me, now: at(back) });
          expect(await pointsOf(t)).toBe(posts ? 1 : 0);
        }
      });

      it('the appointment hold counts real minutes', async () => {
        await sql`delete from appointments where technician_id = ${t.id}`;
        const start = at(day.appointment);
        await sql`insert into appointments (organization_id, location_id, technician_id, start_at, end_at, source)
          values (${ORG}, ${LOC}, ${t.id}, ${start}, ${new Date(start.getTime() + 3_600_000)}, 'manual')`;
        await sql`update technician_status set status = 'available' where technician_id = ${t.id}`;
        const mine = async (now: Date) =>
          (await db.transaction((tx) => queueFor(tx, LOC, undefined, now))).find(
            (q) => q.technicianId === t.id,
          );
        expect(await mine(at(day.heldAt))).toMatchObject({
          eligible: false,
          why: 'appointment_soon',
        });
        expect(await mine(at(day.freeAt))).toMatchObject({ eligible: true });
        await sql`delete from appointments where technician_id = ${t.id}`;
      });
    });
  }

  afterAll(async () => {
    await wipe();
  });
});

// ---------------------------------------------------------------------------
describe('3. left without service and no-shows', () => {
  let a: Tech;
  let b: Tech;
  beforeAll(async () => {
    await clearFloor();
    a = await newTech('Walk A', 'gel', ['Dip powder']);
    b = await newTech('Walk B');
  });

  it('a waiting client who walks out: no points, nobody moves', async () => {
    await onFloor(a, 40);
    await onFloor(b, 30);
    const before = [await pointsOf(a), await pointsOf(b)];
    const v = await walkIn(['Basic pedicure']);
    expect(await leftWithoutService(db, { visitId: v, actor: reception, locationId: LOC })).toEqual(
      { ok: true },
    );
    const [row] = await sql`select status, close_reason from visits where id = ${v}`;
    expect(row).toMatchObject({ status: 'left', close_reason: 'walked_out' });
    expect([await pointsOf(a), await pointsOf(b)]).toEqual(before);
    const [audit] = await sql`select actor_user_id, after from audit_log
      where action = 'left_without_service'`;
    expect(audit!['actor_user_id']).toBe(reception.userId);
    expect(audit!['after']).toMatchObject({ points: 0 });
    // Only a waiting visit; another location's is refused.
    expect(await leftWithoutService(db, { visitId: v, actor: reception, locationId: LOC })).toEqual(
      { ok: false, reason: 'visit_not_waiting' },
    );
    const other = await walkIn(['Basic pedicure']);
    expect(
      await leftWithoutService(db, { visitId: other, actor: reception, locationId: randomUUID() }),
    ).toEqual({ ok: false, reason: 'wrong_location' });
    await leftWithoutService(db, { visitId: other, actor: reception, locationId: LOC });
  });

  it('also on a held second part and a fix waiting for approval', async () => {
    const mixed = await walkIn(['Dip powder', 'Basic pedicure']);
    const split = await accept(await mustCall(mixed, a), a);
    expect(split).toMatchObject({ ok: true });
    const rest = (split as { splitVisitId: string }).splitVisitId;
    expect(
      await leftWithoutService(db, { visitId: rest, actor: reception, locationId: LOC }),
    ).toEqual({ ok: true });
    const fix = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [svc['Nail fix / repair']!],
      actor: { userId: reception.userId },
      fix: { enteredBy: 'receptionist' },
    });
    if (!fix.ok) throw new Error(fix.reason);
    expect(
      await leftWithoutService(db, { visitId: fix.visitId, actor: reception, locationId: LOC }),
    ).toEqual({ ok: true });
    await finishVisit(db, { technicianId: a.id, actor: { userId: a.userId } });
  });

  it('a called visit is not "left without service" (that is Client left)', async () => {
    const v = await walkIn(['Spa pedicure']);
    await mustCall(v, b);
    expect(await leftWithoutService(db, { visitId: v, actor: reception, locationId: LOC })).toEqual(
      { ok: false, reason: 'visit_not_waiting' },
    );
    expect(await clientLeft(db, { visitId: v, actor: reception, locationId: LOC })).toMatchObject({
      ok: true,
    });
  });

  it('the daily report counts walk-outs apart from clients who left after the call', async () => {
    const report = await dailyTurnReport(db, LOC, localDate(new Date(), TZ));
    expect(report?.totals.walkedOut).toBe(4);
    expect(report?.totals.clientLeft).toBe(1);
  });

  it('no-show: only after the start time, frees the hold, counted on the client page', async () => {
    await saveRules((cfg) => {
      cfg.closing.no_show_after_min = 5;
    });
    const [client] = await sql<{ id: string }[]>`insert into clients
      (organization_id, location_id, first_name, phone) values (${ORG}, ${LOC}, 'Nora', '+18135559911') returning id`;
    const now = Date.now();
    const [appt] = await sql<{ id: string }[]>`insert into appointments
      (organization_id, location_id, technician_id, start_at, end_at, source, client_id)
      values (${ORG}, ${LOC}, ${b.id}, ${new Date(now - 3 * 60_000)}, ${new Date(now + 57 * 60_000)}, 'manual', ${client!.id})
      returning id`;
    const held = async () =>
      (await db.transaction((tx) => queueFor(tx, LOC))).find((q) => q.technicianId === b.id);
    expect(await held()).toMatchObject({ why: 'appointment_soon' });
    // Three minutes past the start: too early under a 5-minute rule.
    expect(await markNoShow(db, { actor: reception, appointmentId: appt!.id })).toEqual({
      ok: false,
      reason: 'too_early',
    });
    expect(
      await markNoShow(db, {
        actor: reception,
        appointmentId: appt!.id,
        now: new Date(now + 3 * 60_000),
      }),
    ).toEqual({ ok: true });
    expect(await held()).toMatchObject({ eligible: true });
    expect(
      await markNoShow(db, {
        actor: reception,
        appointmentId: appt!.id,
        now: new Date(now + 4 * 60_000),
      }),
    ).toEqual({ ok: false, reason: 'already_no_show' });
    expect(
      await markNoShow(db, {
        actor: { ...reception, locationId: randomUUID() },
        appointmentId: appt!.id,
      }),
    ).toEqual({ ok: false, reason: 'unknown_appointment' });
    expect((await clientDetail(db, LOC, client!.id))?.noShows).toBe(1);
    const [audit] = await sql`select after from audit_log where action = 'appointment_no_show'`;
    expect(audit!['after']).toMatchObject({ technicianId: b.id });
    expect(JSON.stringify(audit!['after'])).not.toMatch(/Nora|phone|clientName/);
    expect(
      await sql`select id from turn_ledger where technician_id = ${b.id} and reason_type <> 'visit'`,
    ).toEqual([]);
    const report = await dailyTurnReport(db, LOC, localDate(new Date(), TZ));
    expect(report?.totals.noShows).toBe(1);
    await saveRules((cfg) => {
      cfg.closing.no_show_after_min = 0;
    });
    await clearFloor();
  });
});

// ---------------------------------------------------------------------------
describe('4. fairness', () => {
  let a: Tech;
  let b: Tech;
  beforeAll(async () => {
    await clearFloor();
    a = await newTech('Fair A');
    b = await newTech('Fair B');
  });

  it('a: her "Client left" asks the desk; the call stays open until the desk answers', async () => {
    await onFloor(a, 40);
    await onFloor(b, 30);
    const v = await walkIn(['Spa pedicure']);
    await mustCall(v, a);
    const claim = await clientLeft(db, {
      visitId: v,
      actor: { userId: a.userId },
      locationId: LOC,
      technicianId: a.id,
    });
    expect(claim).toEqual({ ok: true, technicianId: a.id, pending: true });
    const [row] = await sql`select status from visits where id = ${v}`;
    expect(row!['status']).toBe('called');
    expect((await leftClaims(db, LOC)).map((c) => c.technician)).toEqual(['Fair A']);
    expect((await openCallFor(db, a.id))?.leftClaim).toBe('pending');
    // "Client is here": she answers as usual.
    expect(await clientHere(db, { visitId: v, actor: reception, locationId: LOC })).toMatchObject({
      ok: true,
    });
    expect(await leftClaims(db, LOC)).toEqual([]);
    const call = await openCallFor(db, a.id);
    expect(call?.leftClaim).toBe('client_here');
    expect(await accept(call!.callId, a)).toMatchObject({ ok: true });
    await finishVisit(db, { technicianId: a.id, actor: { userId: a.userId } });
  });

  it('a: the desk confirms: closed, no points, she keeps her place', async () => {
    const before = await pointsOf(b);
    const v = await walkIn(['Spa pedicure']);
    await mustCall(v, b);
    await clientLeft(db, {
      visitId: v,
      actor: { userId: b.userId },
      locationId: LOC,
      technicianId: b.id,
    });
    expect(await clientLeft(db, { visitId: v, actor: reception, locationId: LOC })).toMatchObject({
      ok: true,
    });
    const [row] = await sql`select status, close_reason from visits where id = ${v}`;
    expect(row).toMatchObject({ status: 'left', close_reason: 'client_left' });
    expect(await pointsOf(b)).toBe(before);
    const [audit] = await sql`select after from audit_log where action = 'client_left'
      order by at desc limit 1`;
    expect(audit!['after']).toMatchObject({ by: 'technician_confirmed' });
  });

  it('a: with the rule set to "direct", her tap closes it at once (as in v0.16.0)', async () => {
    await saveRules((cfg) => {
      cfg.fairness.client_left_by_tech = 'direct';
    });
    const v = await walkIn(['Spa pedicure']);
    await mustCall(v, b);
    expect(
      await clientLeft(db, {
        visitId: v,
        actor: { userId: b.userId },
        locationId: LOC,
        technicianId: b.id,
      }),
    ).toEqual({ ok: true, technicianId: b.id });
    const [row] = await sql`select status from visits where id = ${v}`;
    expect(row!['status']).toBe('left');
    await saveRules((cfg) => {
      cfg.fairness.client_left_by_tech = 'ask_desk';
    });
  });

  it('b: three free denies today flag her card; 0 turns the flag off', async () => {
    for (const reason of ['break_needed', 'personal', 'break_needed'] as const) {
      const v = await walkIn(['Spa pedicure']);
      // B (fewer points) is first each time and says no for free too.
      await deny(await mustCall(v, b), b, 'break_needed');
      await deny(await mustCall(v, a), a, reason);
      await leftWithoutService(db, { visitId: v, actor: reception, locationId: LOC });
    }
    expect(await freeDeniesToday(db, a.id)).toBe(3);
    const card = (await techBoard(db, LOC)).find((c) => c.technicianId === a.id);
    expect(card).toMatchObject({ freeDenies: 3, freeDenyFlag: true });
    await saveRules((cfg) => {
      cfg.fairness.free_deny_flag = 0;
    });
    expect((await techBoard(db, LOC)).find((c) => c.technicianId === a.id)?.freeDenyFlag).toBe(
      false,
    );
    await saveRules((cfg) => {
      cfg.fairness.free_deny_flag = 3;
    });
  });

  it('b: a daily limit (off by default) makes the next free deny cost the penalty', async () => {
    await saveRules((cfg) => {
      cfg.fairness.free_deny_daily_limit = 3;
    });
    const before = await pointsOf(a);
    const v = await walkIn(['Spa pedicure'], { requestedTechnicianId: a.id });
    const call = await mustCall(v, a);
    await deny(call, a, 'personal');
    expect(await pointsOf(a)).toBe(before + 1);
    const [audit] = await sql`select after from audit_log where action = 'call_denied'
      and entity_id = ${call}`;
    expect(audit!['after']).toMatchObject({ overFreeLimit: 3 });
    expect(audit!['after']).not.toHaveProperty('excused');
    await saveRules((cfg) => {
      cfg.fairness.free_deny_daily_limit = null;
    });
    await leftWithoutService(db, { visitId: v, actor: reception, locationId: LOC });
  });

  it('c: the fairness table, one row per tech, counts only', async () => {
    const today = localDate(new Date(), TZ);
    const { from, to } = lastDays(today, 7);
    expect(to).toBe(today);
    const rows = await fairnessReport(db, LOC, from, to);
    const ra = rows.find((r) => r.technicianId === a.id)!;
    const rb = rows.find((r) => r.technicianId === b.id)!;
    expect(ra).toMatchObject({
      name: 'Fair A',
      visitsDone: 1,
      deniesFree: 3,
      deniesPenalty: 1,
      clientLeftMarked: 1,
      clientLeftConfirmed: 0,
    });
    expect(rb).toMatchObject({ deniesFree: 3, clientLeftMarked: 2, clientLeftConfirmed: 2 });
    expect(ra.points).toBe(await pointsOf(a));
    expect(JSON.stringify(rows)).not.toMatch(/phone|client_name/i);
    await clearFloor();
  });
});

// ---------------------------------------------------------------------------
describe('6. leftovers in the database layer', () => {
  let a: Tech;
  let b: Tech;
  beforeAll(async () => {
    await clearFloor();
    a = await newTech('Left A', 'gel', ['Dip powder']);
    b = await newTech('Left B');
  });

  it('Pick a tech says "called" for a tech with an open call', async () => {
    await onFloor(a, 40);
    await onFloor(b, 30);
    const busy = await walkIn(['Spa pedicure']);
    await mustCall(busy, a);
    const art = await walkIn(['Nail art / design']);
    const opts = (await deskOptions(db, LOC)).get(art);
    expect(opts?.technicians.find((o) => o.technicianId === a.id)?.status).toBe('called');
    expect(opts?.technicians.find((o) => o.technicianId === b.id)?.status).toBe('available');
    await clientLeft(db, { visitId: busy, actor: reception, locationId: LOC });
    await leftWithoutService(db, { visitId: art, actor: reception, locationId: LOC });
  });

  it('the slip says she is still doing her part until she finishes', async () => {
    const mixed = await walkIn(['Dip powder', 'Basic pedicure']);
    const r = await accept(await mustCall(mixed, a), a);
    const rest = (r as { splitVisitId: string }).splitVisitId;
    const row = (await waitingVisits(db, LOC)).find((w) => w.id === rest);
    expect(row?.slip).toEqual([
      { technician: 'Left A', services: ['Basic pedicure'], done: false },
    ]);
    await finishVisit(db, { technicianId: a.id, actor: { userId: a.userId } });
    const after = (await waitingVisits(db, LOC)).find((w) => w.id === rest);
    expect(after?.slip?.[0]?.done).toBe(true);
    await clearFloor();
  });
});

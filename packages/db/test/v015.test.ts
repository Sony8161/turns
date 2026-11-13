// v0.15.0 "Rule answers" (Duong, 2026-11-12, 02:00 and 02:05):
//  A. services in one visit add up, no cap with a fill or full set;
//  B. 0 before 00 only at zero; above zero an appointment changes nothing;
//  C. "break" and "personal" denies excuse themselves, per-reason setting;
//  D. a requested or booked technician who is busy: never a fallback, the desk
//     keeps waiting, books for later or sends the visit by turn;
//  E. a visit of several services goes by turn to the first technician who
//     gets at least one of them; the rest waits until she is done;
//  F. the kiosk lists only technicians on shift who do every chosen service.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aheadBecause } from '../src/board';
import {
  callNext,
  createWalkIn,
  DENY_REASONS,
  finishVisit,
  openCallFor,
  respondToCall,
  waitingVisits,
} from '../src/engine';
import {
  createKioskDevice,
  kioskCheckIn,
  kioskMenu,
  pairKiosk,
  techniciansFor,
} from '../src/kiosk';
import { setTechnicianLevel, type SkillLevel } from '../src/levels';
import { bookForLater, keepWaiting, requestHolds, sendByTurn } from '../src/requests';
import {
  activeRules,
  compareQueue,
  saveRuleConfig,
  templateConfig,
  validateRuleConfig,
  visitPointsUnder,
  type RuleConfig,
} from '../src/rules';
import { HEAVENLY, HEAVENLY_RULE_CONFIG_V1, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import type { StaffActor } from '../src/staff';
import { checkIn, shiftTotal, transition } from '../src/status';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
const desk = { userId: null };
let owner: StaffActor;
let deskActor: { userId: string | null; organizationId: string; locationId: string };
type Tech = { id: string; userId: string; name: string };
const svc: Record<string, string> = {};
const cat: Record<string, string> = {};

async function newUser(name: string, role: string, locationId: string = LOC): Promise<string> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${role}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${locationId}, ${role}::role)`;
  return userId;
}

/** A technician with a level (ticks everything at or below it, minus `not`). */
async function newTech(name: string, level: SkillLevel, not: string[] = []): Promise<Tech> {
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
  return { id: t!.id, userId, name };
}

async function onFloor(t: Tech, minutesAgo: number) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await checkIn(db, { technicianId: t.id, actor: { userId: t.userId }, position: null, now: at });
  await transition(db, { technicianId: t.id, to: 'available', actor: { userId: t.userId } });
}

/** End of a block: everyone off the floor, every open visit closed. */
async function clearFloor() {
  await sql`update turn_calls set responded_at = now(), response = 'overridden' where responded_at is null`;
  await sql`update visits set status = 'cancelled', cancelled_at = now() where status in ('waiting', 'called', 'in_service')`;
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
    actor: desk,
    ...extra,
  });
  if (!v.ok) throw new Error(v.reason);
  return v.visitId;
}

const call = (visitId: string) => callNext(db, { visitId, actor: desk, locationId: LOC });

async function mustCall(visitId: string, expect_: Tech): Promise<string> {
  const r = await call(visitId);
  if (!r.ok) throw new Error(`call: ${r.reason} ${r.detail ?? ''}`);
  if (r.technicianId !== expect_.id) throw new Error(`expected ${expect_.name} to be called`);
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

const finish = (t: Tech) => finishVisit(db, { technicianId: t.id, actor: { userId: t.userId } });

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

beforeAll(async () => {
  await resetAndMigrate();
  await seedHeavenly(TEST_URL);
  db = createDb(TEST_URL);
  for (const s of await sql<
    { id: string; name: string }[]
  >`select id, name from services where location_id = ${LOC}`) {
    svc[s.name] = s.id;
  }
  for (const c of await sql<
    { id: string; name: string }[]
  >`select id, name from service_categories where location_id = ${LOC}`) {
    cat[c.name] = c.id;
  }
  owner = {
    userId: await newUser('owner', 'owner'),
    role: 'owner',
    organizationId: ORG,
    locationId: LOC,
  };
  deskActor = {
    userId: await newUser('desk', 'receptionist'),
    organizationId: ORG,
    locationId: LOC,
  };
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

describe('A. services in one visit add up', () => {
  const gelManicure = () => ({ isFillOrFullSet: false, categoryId: cat['manicure']! });
  const acrylicFill = () => ({ isFillOrFullSet: true, categoryId: cat['fill']! });

  it('Heavenly has no cap: a gel manicure and an acrylic fill are 1½', () => {
    expect(HEAVENLY_RULE_CONFIG_V1.points.combined_fill_full_cap).toBeNull();
    expect(
      visitPointsUnder(HEAVENLY_RULE_CONFIG_V1, [gelManicure(), acrylicFill()], 'walk_in'),
    ).toBe(1.5);
    expect(
      templateConfig('standard', HEAVENLY_RULE_CONFIG_V1).points.combined_fill_full_cap,
    ).toBeNull();
  });

  it('the cap is still a setting for a salon that wants one', () => {
    const capped = structuredClone(HEAVENLY_RULE_CONFIG_V1);
    capped.points.combined_fill_full_cap = 1;
    expect(visitPointsUnder(capped, [gelManicure(), acrylicFill()], 'walk_in')).toBe(1);
  });

  it('the engine posts 1½ for the two services, and same-time visits stay one visit per service', async () => {
    const acr = await newTech('A-Acr', 'acrylic');
    await onFloor(acr, 30);
    const visit = await walkIn(['Gel manicure', 'Acrylic fill']);
    expect((await accept(await mustCall(visit, acr), acr)).ok).toBe(true);
    expect(await finish(acr)).toEqual({ ok: true, points: 1.5 });
    expect(await pointsOf(acr)).toBe(1.5);

    const pair = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [svc['Gel manicure']!, svc['Spa pedicure']!],
      actor: desk,
      sameTime: true,
    });
    if (!pair.ok) throw new Error(pair.reason);
    expect(pair.visitIds.length).toBe(2);
    const rows = await sql<
      { n: number }[]
    >`select count(*)::int as n from visit_services where visit_id in ${sql(pair.visitIds)} group by visit_id`;
    expect(rows.map((r) => r.n)).toEqual([1, 1]);
    await clearFloor();
  });
});

describe('B. 0 before 00, at zero only', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 10, 12, 14, min));
  const row = (points: number, hadAppointmentLast: boolean, min: number) => ({
    points,
    hadAppointmentLast,
    checkedInAt: at(min),
  });
  const rules = HEAVENLY_RULE_CONFIG_V1;

  it('Heavenly sorts by points, then 0 before 00, then check-in', () => {
    expect(rules.queue.sort).toEqual(['points_asc', 'double_zero_last', 'check_in_asc']);
    expect(validateRuleConfig(rules).ok).toBe(true);
  });

  it('at zero, a true 0 goes before a 00 even when the 00 checked in first', () => {
    expect(compareQueue(rules, row(0, false, 30), row(0, true, 0))).toBeLessThan(0);
    expect(compareQueue(rules, row(0, true, 0), row(0, false, 30))).toBeGreaterThan(0);
  });

  it('a 00 is still ahead of everyone above zero', () => {
    expect(compareQueue(rules, row(0, true, 50), row(0.5, false, 0))).toBeLessThan(0);
  });

  it('above zero the appointment makes no difference: the earlier check-in goes first', () => {
    expect(compareQueue(rules, row(0.5, true, 0), row(0.5, false, 30))).toBeLessThan(0);
    expect(compareQueue(rules, row(1, true, 0), row(1, false, 30))).toBeLessThan(0);
  });

  it('the every-score rule is still a setting', () => {
    const every = structuredClone(rules);
    every.queue.sort = ['points_asc', 'had_appointment_last', 'check_in_asc'];
    expect(validateRuleConfig(every).ok).toBe(true);
    expect(compareQueue(every, row(0.5, true, 0), row(0.5, false, 30))).toBeGreaterThan(0);
  });

  it('"why this order" names the appointment only at zero', () => {
    const card = (points: number, hadAppointmentLast: boolean, checkInRank: number) => ({
      points,
      hadAppointmentLast,
      checkInRank,
    });
    expect(aheadBecause(card(0, false, 2), card(0, true, 1), rules.queue.sort)).toBe(
      'appointment_last',
    );
    expect(aheadBecause(card(0.5, true, 1), card(0.5, false, 2), rules.queue.sort)).toBe(
      'earlier_check_in',
    );
  });

  it('the engine orders the floor that way', async () => {
    const x = await newTech('B-X', 'gel'); // ½, last visit an appointment, first in
    const y = await newTech('B-Y', 'gel'); // ½, a walk-in
    const w = await newTech('B-W', 'gel'); // 00
    const z = await newTech('B-Z', 'gel'); // 0, last in
    await onFloor(x, 60);
    await onFloor(y, 50);
    await onFloor(w, 45);
    await onFloor(z, 40);
    const booked = async (t: Tech, service: string) => {
      const v = await walkIn([service], { source: 'appointment', requestedTechnicianId: t.id });
      await accept(await mustCall(v, t), t);
      return finish(t);
    };
    expect(await booked(x, 'Gel manicure')).toEqual({ ok: true, points: 0.5 });
    expect(await booked(w, 'Gel fill')).toEqual({ ok: true, points: 0 });
    const asked = await walkIn(['Gel fill'], { requestedTechnicianId: y.id });
    await accept(await mustCall(asked, y), y);
    expect(await finish(y)).toEqual({ ok: true, points: 0.5 });

    // 0 (B-Z, last in) before 00 (B-W).
    const first = await walkIn(['Gel manicure']);
    await accept(await mustCall(first, z), z);
    await finish(z); // 1
    const second = await walkIn(['Gel manicure']);
    await accept(await mustCall(second, w), w);
    await finish(w); // 1, last visit a walk-in
    // At ½ the appointment makes no difference: B-X checked in before B-Y.
    const third = await walkIn(['Gel manicure']);
    const r = await call(third);
    expect(r.ok && r.technicianId).toBe(x.id);
    await clearFloor();
  });
});

describe('C. deny reasons that excuse themselves', () => {
  it('"personal" is a reason, and Heavenly excuses break and personal', () => {
    expect(DENY_REASONS).toContain('personal');
    expect(HEAVENLY_RULE_CONFIG_V1.penalties.deny_excused_reasons).toEqual([
      'break_needed',
      'personal',
    ]);
  });

  it('validates the list: known reasons only; missing means none', () => {
    const bad = structuredClone(HEAVENLY_RULE_CONFIG_V1) as unknown as {
      penalties: { deny_excused_reasons?: unknown };
    };
    bad.penalties.deny_excused_reasons = ['break_needed', 'felt_like_it'];
    const r = validateRuleConfig(bad);
    expect(!r.ok && r.errors).toContainEqual({
      path: 'penalties.deny_excused_reasons',
      problem: 'not_allowed',
    });
    delete bad.penalties.deny_excused_reasons;
    const old = validateRuleConfig(bad);
    expect(old.ok && old.config.penalties.deny_excused_reasons).toEqual([]);
  });

  it('a break or personal deny posts nothing; any other reason is +1', async () => {
    const first = await newTech('C-First', 'gel');
    const second = await newTech('C-Second', 'gel');
    await onFloor(first, 30);
    await onFloor(second, 20);

    const v1 = await walkIn(['Gel manicure']);
    const c1 = await mustCall(v1, first);
    expect((await deny(c1, first, 'break_needed')).ok).toBe(true);
    expect(await pointsOf(first)).toBe(0);
    const [callRow] = await sql<
      { auto_excused: boolean; deny_reason: string }[]
    >`select auto_excused, deny_reason from turn_calls where id = ${c1}`;
    expect(callRow).toEqual({ auto_excused: true, deny_reason: 'break_needed' });
    const [ledger] = await sql<
      { n: number }[]
    >`select count(*)::int as n from turn_ledger where technician_id = ${first.id}`;
    expect(ledger!.n).toBe(0);
    const [audit] = await sql<
      { after: { denyReason: string; excused: string } }[]
    >`select after from audit_log where action = 'call_denied' and entity_id = ${c1}`;
    expect(audit!.after).toMatchObject({ denyReason: 'break_needed', excused: 'by_rule' });

    // She said no to this client: the next call for it passes her over, with
    // the reason on the record, and goes to the next technician.
    const again = await call(v1);
    expect(again.ok && again.technicianId).toBe(second.id);
    expect(again.ok && again.skipped).toEqual([
      expect.objectContaining({ technicianId: first.id, why: 'said_no' }),
    ]);
    if (again.ok) await accept(again.callId, second);
    await finish(second); // second: 1

    // Another client: she is first again (0), and "personal" is free too.
    const v2 = await walkIn(['Gel manicure']);
    const c2 = await mustCall(v2, first);
    expect((await deny(c2, first, 'personal')).ok).toBe(true);
    expect(await pointsOf(first)).toBe(0);

    // "other" costs the deny penalty.
    const v3 = await walkIn(['Gel manicure']);
    const c3 = await mustCall(v3, first);
    expect((await deny(c3, first, 'other')).ok).toBe(true);
    expect(await pointsOf(first)).toBe(1);
    const [a3] = await sql<
      { after: { excused?: string } }[]
    >`select after from audit_log where action = 'call_denied' and entity_id = ${c3}`;
    expect(a3!.after.excused).toBeUndefined();
    await clearFloor();
  });

  it('a salon can switch a reason off: then a break deny costs the penalty', async () => {
    await saveRules((c) => {
      c.penalties.deny_excused_reasons = ['personal'];
    });
    const t = await newTech('C-Strict', 'gel');
    await onFloor(t, 30);
    const v = await walkIn(['Gel manicure']);
    await deny(await mustCall(v, t), t, 'break_needed');
    expect(await pointsOf(t)).toBe(1);
    await saveRules((c) => {
      c.penalties.deny_excused_reasons = ['break_needed', 'personal'];
    });
    await clearFloor();
  });
});

describe('D. the requested or booked technician is busy', () => {
  let wanted: Tech;
  let other: Tech;
  let visit: string;

  it('the visit waits for her, and the desk sees her status and next appointment', async () => {
    wanted = await newTech('D-Wanted', 'gel');
    other = await newTech('D-Other', 'gel');
    await onFloor(wanted, 30);
    await onFloor(other, 20);
    const busy = await walkIn(['Gel manicure'], { requestedTechnicianId: wanted.id });
    await accept(await mustCall(busy, wanted), wanted);
    const apptStart = new Date(Date.now() + 3 * 3_600_000);
    await sql`insert into appointments (organization_id, location_id, technician_id, start_at, end_at) values (${ORG}, ${LOC}, ${wanted.id}, ${apptStart}, ${new Date(apptStart.getTime() + 3_600_000)})`;

    visit = await walkIn(['Gel manicure'], {
      requestedTechnicianId: wanted.id,
      client: { name: 'Thu Pham', phone: '813-555-0303' },
    });
    const r = await call(visit);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('nobody_eligible'); // never falls back to D-Other

    expect(HEAVENLY_RULE_CONFIG_V1.attention.request_wait_min).toBe(10);
    const holds = await requestHolds(db, LOC);
    const hold = holds.get(visit)!;
    expect(hold).toMatchObject({
      technicianId: wanted.id,
      technicianName: 'D-Wanted',
      status: 'in_service',
      attention: false,
    });
    expect(hold.since).toBeInstanceOf(Date);
    expect(hold.nextAppointmentAt?.getTime()).toBe(apptStart.getTime());
    // Ten minutes on, the desk is flagged.
    const later = await requestHolds(db, LOC, new Date(Date.now() + 11 * 60_000));
    expect(later.get(visit)).toMatchObject({ attention: true, waitedMin: 11 });
    // The busy visit itself is not a hold: she has it.
    expect(holds.has(busy)).toBe(false);
  });

  it('"Keep waiting" clears the flag for another ten minutes, and is audited', async () => {
    const at = new Date(Date.now() + 11 * 60_000);
    expect(await keepWaiting(db, { actor: deskActor, visitId: visit, now: at })).toEqual({
      ok: true,
    });
    expect((await requestHolds(db, LOC, at)).get(visit)).toMatchObject({ attention: false });
    expect(
      (await requestHolds(db, LOC, new Date(at.getTime() + 10 * 60_000))).get(visit),
    ).toMatchObject({ attention: true });
    const [a] = await sql<
      { actor_user_id: string }[]
    >`select actor_user_id from audit_log where action = 'request_keep_waiting' and entity_id = ${visit}`;
    expect(a!.actor_user_id).toBe(deskActor.userId);
  });

  it('refuses a visit at another location and a visit nobody was asked for', async () => {
    const elsewhere = { ...deskActor, locationId: randomUUID() };
    expect(await keepWaiting(db, { actor: elsewhere, visitId: visit })).toEqual({
      ok: false,
      reason: 'unknown_visit',
    });
    expect(await sendByTurn(db, { actor: elsewhere, visitId: visit })).toEqual({
      ok: false,
      reason: 'unknown_visit',
    });
    const plain = await walkIn(['Gel manicure']);
    expect(await sendByTurn(db, { actor: deskActor, visitId: plain })).toEqual({
      ok: false,
      reason: 'no_request',
    });
    await sql`update visits set status = 'cancelled', cancelled_at = now() where id = ${plain}`;
  });

  it('"Send by turn" drops the request: the line decides, at a walk-in\'s points', async () => {
    expect(await sendByTurn(db, { actor: deskActor, visitId: visit })).toEqual({ ok: true });
    const [row] = await sql<
      { source: string; requested_technician_id: string | null }[]
    >`select source, requested_technician_id from visits where id = ${visit}`;
    expect(row).toEqual({ source: 'walk_in', requested_technician_id: null });
    const [a] = await sql<
      { before: { source: string; requestedTechnicianId: string }; after: { source: string } }[]
    >`select before, after from audit_log where action = 'request_sent_by_turn' and entity_id = ${visit}`;
    expect(a!.before).toEqual({ source: 'request', requestedTechnicianId: wanted.id });
    expect(a!.after).toEqual({ source: 'walk_in', requestedTechnicianId: null });
    expect((await requestHolds(db, LOC)).has(visit)).toBe(false);
    const r = await call(visit);
    expect(r.ok && r.technicianId).toBe(other.id);
  });

  it('"Book for later" makes an appointment with her and takes the visit out of the line', async () => {
    const v = await walkIn(['Gel manicure', 'Spa pedicure'], {
      requestedTechnicianId: wanted.id,
      client: { name: 'Kim Le', phone: '813-555-0304' },
    });
    const startAt = new Date(Date.now() + 90 * 60_000);
    const r = await bookForLater(db, { actor: deskActor, visitId: v, startAt });
    expect(r.ok).toBe(true);
    const [row] = await sql<
      { status: string; cancelled_at: Date | null }[]
    >`select status, cancelled_at from visits where id = ${v}`;
    expect(row!.status).toBe('cancelled');
    expect(row!.cancelled_at).not.toBeNull();
    const [appt] = await sql<
      { technician_id: string; start_at: Date; end_at: Date; client_name: string; source: string }[]
    >`select technician_id, start_at, end_at, client_name, source from appointments where id = ${r.ok ? r.appointmentId : ''}`;
    expect(appt!.technician_id).toBe(wanted.id);
    expect(appt!.start_at.getTime()).toBe(startAt.getTime());
    // 45 + 60 minutes: the services' own lengths.
    expect(appt!.end_at.getTime() - appt!.start_at.getTime()).toBe(105 * 60_000);
    expect(appt!.client_name).toBe('Kim Le');
    expect(appt!.source).toBe('manual');
    expect((await waitingVisits(db, LOC)).some((w) => w.id === v)).toBe(false);
    const [a] = await sql<
      { after: Record<string, unknown> }[]
    >`select after from audit_log where action = 'request_booked_later' and entity_id = ${v}`;
    expect(a!.after).toMatchObject({ technicianId: wanted.id });
    expect(JSON.stringify(a!.after)).not.toContain('Kim');

    // A time in the past is refused and nothing changes.
    const v2 = await walkIn(['Gel manicure'], { requestedTechnicianId: wanted.id });
    const past = await bookForLater(db, {
      actor: deskActor,
      visitId: v2,
      startAt: new Date(Date.now() - 3 * 86_400_000),
    });
    expect(past.ok).toBe(false);
    const [still] = await sql<{ status: string }[]>`select status from visits where id = ${v2}`;
    expect(still!.status).toBe('waiting');
    await clearFloor();
  });

  it('an older config without the setting falls back to the long-wait minutes', () => {
    const old = structuredClone(HEAVENLY_RULE_CONFIG_V1) as unknown as {
      attention: { request_wait_min?: number };
    };
    delete old.attention.request_wait_min;
    const r = validateRuleConfig(old);
    expect(r.ok && r.config.attention.request_wait_min).toBe(
      HEAVENLY_RULE_CONFIG_V1.attention.long_wait_min,
    );
  });
});

describe('E. a visit of several services goes by turn', () => {
  let reg: Tech;
  let dip: Tech;
  let acr: Tech;

  it('the first technician who gets one of the services is called, and takes what she does', async () => {
    reg = await newTech('E-Reg', 'regular');
    dip = await newTech('E-Dip', 'dip');
    acr = await newTech('E-Acr', 'acrylic');
    await onFloor(reg, 60);
    await onFloor(acr, 50);
    await onFloor(dip, 40);

    const visit = await walkIn(['Dip powder', 'Basic pedicure'], {
      client: { name: 'Ngoc Vo', phone: '813-555-0404' },
      note: 'French tip on the dip',
    });
    const [before] = await sql<
      { arrived_at: Date }[]
    >`select arrived_at from visits where id = ${visit}`;
    // v0.14.0 would have skipped E-Reg (she does not do dip). Now she is
    // first by turn for the pedicure.
    const callId = await mustCall(visit, reg);
    const open = await openCallFor(db, reg.id);
    expect(open!.serviceItems.map((i) => [i.name, i.canDo])).toEqual([
      ['Basic pedicure', true],
      ['Dip powder', false],
    ]);
    const [snap] = await sql<
      { queue_snapshot: { technicianId: string; takes?: string[] }[] }[]
    >`select queue_snapshot from turn_calls where id = ${callId}`;
    expect(snap!.queue_snapshot.find((c) => c.technicianId === reg.id)!.takes).toEqual([
      'Basic pedicure',
    ]);

    // She cannot keep a service she does not do.
    expect(await accept(callId, reg, [svc['Dip powder']!])).toMatchObject({
      ok: false,
      reason: 'bad_split',
    });
    // Accept: she keeps the pedicure, the dip goes on as a linked visit.
    const r = await accept(callId, reg);
    expect(r.ok && typeof r.splitVisitId).toBe('string');
    const rest = r.ok ? r.splitVisitId! : '';
    const [restRow] = await sql<
      { arrived_at: Date; status: string; split_from_visit_id: string; note: string }[]
    >`select arrived_at, status, split_from_visit_id, note from visits where id = ${rest}`;
    expect(restRow!.status).toBe('waiting');
    expect(restRow!.split_from_visit_id).toBe(visit);
    expect(restRow!.arrived_at.getTime()).toBe(before!.arrived_at.getTime());

    // The rest waits until her part is finished: nobody can be called for it yet.
    expect(await call(rest)).toMatchObject({ ok: false, reason: 'waits_for_first_part' });
    const row = (await waitingVisits(db, LOC)).find((w) => w.id === rest)!;
    expect(row.held).toEqual({ technician: 'E-Reg' });
    // v0.17.0: her part is not finished yet, so the slip says she is doing it.
    expect(row.slip).toEqual([{ technician: 'E-Reg', services: ['Basic pedicure'], done: false }]);

    // She finishes: 1 point for the pedicure only.
    expect(await finish(reg)).toEqual({ ok: true, points: 1 });
    // Now the dip goes by turn: E-Acr (0, checked in before E-Dip).
    const second = await mustCall(rest, acr);
    const card = await openCallFor(db, acr.id);
    expect(card!.slip).toEqual([{ technician: 'E-Reg', services: ['Basic pedicure'], done: true }]);
    expect(card!.services).toEqual(['Dip powder']);
    expect(card!.note).toBe('French tip on the dip');
    await accept(second, acr);
    expect(await finish(acr)).toEqual({ ok: true, points: 1 });
    expect((await waitingVisits(db, LOC)).find((w) => w.id === rest)).toBeUndefined();
  });

  it('a technician who does everything still chooses: do all, or split and the rest waits for her', async () => {
    // dip is lowest now (0); E-Reg and E-Acr have 1.
    const visit = await walkIn(['Dip powder', 'Spa pedicure']);
    const callId = await mustCall(visit, dip);
    const open = await openCallFor(db, dip.id);
    expect(open!.serviceItems.every((i) => i.canDo)).toBe(true);
    expect(open!.slip).toBeNull();
    const r = await accept(callId, dip, [svc['Dip powder']!]);
    const rest = r.ok ? r.splitVisitId! : '';
    expect(rest).not.toBe('');
    expect(await call(rest)).toMatchObject({ ok: false, reason: 'waits_for_first_part' });
    expect(await finish(dip)).toEqual({ ok: true, points: 1 });
    // The pedicure goes to whoever is next by turn; all three are at 1,
    // E-Reg checked in first.
    const next = await call(rest);
    expect(next.ok && next.technicianId).toBe(reg.id);
    await clearFloor();
  });

  it('a technician who does none of it is skipped; one whose level gets none of it by turn keeps her place', async () => {
    const r2 = await newTech('E-Reg2', 'regular');
    const a2 = await newTech('E-Acr2', 'acrylic');
    await onFloor(r2, 30);
    await onFloor(a2, 20);
    // Acrylic fill + Dip powder: nothing a regular technician does.
    const none = await walkIn(['Acrylic fill', 'Dip powder']);
    const c = await call(none);
    expect(c.ok && c.technicianId).toBe(a2.id);
    expect(c.ok && c.skipped).toEqual([
      expect.objectContaining({ technicianId: r2.id, why: 'no_skill' }),
    ]);
    await clearFloor();

    const a3 = await newTech('E-Acr3', 'acrylic');
    await onFloor(a3, 20);
    // A basic manicure and a basic pedicure... the pedicure is everyone's by
    // turn, so she is called for it. Two regular manicure-only services would
    // not be: use the manicure alone to show the level rule still holds.
    const reg1 = await walkIn(['Basic manicure']);
    expect(await call(reg1)).toMatchObject({ ok: false, reason: 'nobody_eligible' });
    const mixed = await walkIn(['Basic manicure', 'Basic pedicure']);
    const m = await call(mixed);
    expect(m.ok && m.technicianId).toBe(a3.id);
    await clearFloor();
  });
});

describe('F. the kiosk technician step', () => {
  it('lists only technicians on shift who do every chosen service, names only', async () => {
    const onGel = await newTech('F-Gel', 'gel');
    const onReg = await newTech('F-Reg', 'regular');
    const offAcr = await newTech('F-Off', 'acrylic');
    const noGelMani = await newTech('F-Pedi', 'gel', ['Gel manicure']);
    await onFloor(onGel, 30);
    await onFloor(onReg, 20);
    await onFloor(noGelMani, 10);

    const device = await createKioskDevice(db, { actor: owner, name: 'F kiosk', pin: '4321' });
    if (!device.ok) throw new Error(device.reason);
    const paired = await pairKiosk(db, { code: device.pairingCode });
    if (!paired.ok) throw new Error(paired.reason);

    const menu = await kioskMenu(db, paired.device);
    const names = menu.technicians.map((t) => t.name);
    expect(names).toEqual(['F-Gel', 'F-Pedi', 'F-Reg']); // not F-Off: she is not in today
    for (const t of menu.technicians) {
      expect(Object.keys(t).sort()).toEqual(['id', 'name', 'serviceIds']);
    }
    const pick = (services: string[]) =>
      techniciansFor(
        menu.technicians,
        services.map((s) => svc[s]!),
      ).map((t) => t.name);
    expect(pick(['Basic pedicure'])).toEqual(['F-Gel', 'F-Pedi', 'F-Reg']);
    expect(pick(['Gel manicure'])).toEqual(['F-Gel']);
    expect(pick(['Gel pedicure', 'Basic manicure'])).toEqual(['F-Gel', 'F-Pedi']);
    expect(pick(['Acrylic fill'])).toEqual([]); // only "Anyone" is shown
    expect(pick([])).toEqual([]);

    // The server holds the same line: a technician who is off, or who does
    // not do every chosen service, cannot be asked for from the kiosk.
    const ask = (technicianId: string, services: string[]) =>
      kioskCheckIn(db, {
        device: paired.device,
        name: 'Bich',
        serviceIds: services.map((s) => svc[s]!),
        requestedTechnicianId: technicianId,
      });
    expect(await ask(offAcr.id, ['Basic pedicure'])).toEqual({
      ok: false,
      reason: 'unknown_technician',
    });
    expect(await ask(noGelMani.id, ['Gel manicure'])).toEqual({
      ok: false,
      reason: 'unknown_technician',
    });
    expect((await ask(onGel.id, ['Gel manicure'])).ok).toBe(true);
    await clearFloor();
  });
});

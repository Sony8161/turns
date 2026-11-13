// v0.16.0 "Fixes, groups, client left, need help" (Duong, 2026-11-12).
//  A. a request counts as a full normal turn (multiplier 1);
//  B. points per service: polish change 0, gel polish change 1;
//  C. nail fix / repair: free, desk only, the fix window, approval;
//  D. groups: one visit and one client per person, linked by a party id;
//  E. "Client left" on a called visit: no points, she keeps her place;
//  F. "Need help" from the technician's phone to the desk board;
//  G. owners and managers do not do nails: not in the rotation.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callNext,
  clientLeft,
  createWalkIn,
  deskCall,
  deskOptions,
  DENY_REASONS,
  finishVisit,
  respondToCall,
  waitingVisits,
} from '../src/engine';
import { fixCandidates, fixesByOriginalTech, reviewFix } from '../src/fixes';
import {
  acknowledgeHelp,
  askForHelp,
  HELP_PER_HOUR,
  myOpenHelp,
  openHelpRequests,
} from '../src/help';
import {
  createKioskDevice,
  kioskCheckIn,
  kioskGroupCheckIn,
  kioskMenu,
  pairKiosk,
  reviewKioskVisit,
} from '../src/kiosk';
import { setTechnicianLevel, type SkillLevel } from '../src/levels';
import { createParty } from '../src/party';
import { localDate } from '../src/reports';
import {
  activeRules,
  saveRuleConfig,
  templateConfig,
  validateRuleConfig,
  visitPointsUnder,
  type RuleConfig,
} from '../src/rules';
import { HEAVENLY, HEAVENLY_RULE_CONFIG_V1, HEAVENLY_SERVICES, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import type { StaffActor } from '../src/staff';
import { checkIn, locationStatus, shiftTotal, transition } from '../src/status';
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

let manager: { userId: string | null; organizationId: string; locationId: string };

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
  manager = {
    userId: await newUser('manager', 'manager'),
    organizationId: ORG,
    locationId: LOC,
  };
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

/** A completed visit for a client, done by `t`, `daysAgo` days back. */
async function pastVisit(t: Tech, service: string, phone: string, first: string, daysAgo: number) {
  await onFloor(t, 5);
  const visit = await walkIn([service], {
    client: { firstName: first, lastName: 'Fixer', phone },
  });
  const r = await call(visit);
  if (!r.ok || r.technicianId !== t.id) throw new Error(`past visit: ${JSON.stringify(r)}`);
  expect((await accept(r.callId, t)).ok).toBe(true);
  expect((await finish(t)).ok).toBe(true);
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60_000);
  await sql`update visits set arrived_at = ${at}, started_at = ${at}, completed_at = ${at} where id = ${visit}`;
  await clearFloor();
  return visit;
}

describe('A. a request counts as a full normal turn', () => {
  it('Heavenly and the standard template count a request in full (multiplier 1)', () => {
    expect(HEAVENLY_RULE_CONFIG_V1.requests.requested_counts_points).toBe(1);
    expect(
      templateConfig('standard', HEAVENLY_RULE_CONFIG_V1).requests.requested_counts_points,
    ).toBe(1);
    const item = [{ isFillOrFullSet: false, categoryId: cat['manicure']! }];
    expect(visitPointsUnder(HEAVENLY_RULE_CONFIG_V1, item, 'request')).toBe(
      visitPointsUnder(HEAVENLY_RULE_CONFIG_V1, item, 'walk_in'),
    );
  });

  it('the requested technician earns a full turn for a requested visit, and half is still a setting', async () => {
    const t = await newTech('A-Req', 'gel');
    await onFloor(t, 30);
    const visit = await walkIn(['Gel manicure'], { requestedTechnicianId: t.id });
    expect((await accept(await mustCall(visit, t), t)).ok).toBe(true);
    expect(await finish(t)).toEqual({ ok: true, points: 1 });
    const half = structuredClone(HEAVENLY_RULE_CONFIG_V1);
    half.requests.requested_counts_points = 0.5;
    expect(
      visitPointsUnder(half, [{ isFillOrFullSet: false, categoryId: cat['manicure']! }], 'request'),
    ).toBe(0.5);
    await clearFloor();
  });
});

describe('B. points per service', () => {
  it('the starting menu has a polish change (0) and a gel polish change (1)', async () => {
    const names = HEAVENLY_SERVICES.map((s) => s.name);
    expect(names).toContain('Polish change');
    expect(names).toContain('Gel polish change');
    const rules = await activeRules(db, LOC);
    expect(rules.points.by_service?.[svc['Polish change']!]).toBe(0);
    expect(rules.points.by_service?.[svc['Gel polish change']!]).toBe(1);
  });

  it("a service's own points come before its category's and the defaults", () => {
    const c = structuredClone(HEAVENLY_RULE_CONFIG_V1);
    c.points.by_category = { [cat['manicure']!]: 2 };
    c.points.by_service = { [svc['Polish change']!]: 0 };
    const mani = { isFillOrFullSet: false, categoryId: cat['manicure']! };
    expect(visitPointsUnder(c, [{ ...mani, serviceId: svc['Polish change']! }], 'walk_in')).toBe(0);
    expect(visitPointsUnder(c, [{ ...mani, serviceId: svc['Gel manicure']! }], 'walk_in')).toBe(2);
  });

  it('validates the table, and an older config without it still validates', () => {
    const c = structuredClone(HEAVENLY_RULE_CONFIG_V1) as unknown as Record<string, unknown>;
    (c['points'] as Record<string, unknown>)['by_service'] = { x: 0.3 };
    const bad = validateRuleConfig(c);
    expect(bad.ok).toBe(false);
    const old = structuredClone(HEAVENLY_RULE_CONFIG_V1) as unknown as Record<string, unknown>;
    delete old['fixes'];
    delete old['groups'];
    const ok = validateRuleConfig(old);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.fixes).toEqual({ window_days: 14, receptionist_needs_approval: true });
      expect(ok.config.groups).toEqual({ max_people: 8 });
    }
  });

  it("save refuses a service that is not on this location's menu", async () => {
    const c = structuredClone(await activeRules(db, LOC));
    c.points.by_service = { ...c.points.by_service, [randomUUID()]: 1 };
    const r = await saveRuleConfig(db, {
      organizationId: ORG,
      locationId: LOC,
      config: c,
      actor: { userId: owner.userId },
    });
    expect(r).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('the engine posts 0 for a polish change and 1 for a gel polish change', async () => {
    const t = await newTech('B-Gel', 'gel');
    await onFloor(t, 30);
    const v1 = await walkIn(['Polish change']);
    expect((await accept(await mustCall(v1, t), t)).ok).toBe(true);
    expect(await finish(t)).toEqual({ ok: true, points: 0 });
    const v2 = await walkIn(['Gel polish change']);
    expect((await accept(await mustCall(v2, t), t)).ok).toBe(true);
    expect(await finish(t)).toEqual({ ok: true, points: 1 });
    expect(await pointsOf(t)).toBe(1);
    await clearFloor();
  });
});

describe('C. nail fix / repair', () => {
  const fixIn = (
    enteredBy: 'owner' | 'manager' | 'receptionist',
    ofVisitId: string | null,
    actor: { userId: string | null } = desk,
  ) =>
    createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [svc['Nail fix / repair']!],
      actor,
      fix: { enteredBy, ofVisitId },
    });

  it('is free and on the menu, but never on the kiosk', async () => {
    const rules = await activeRules(db, LOC);
    expect(rules.points.by_service?.[svc['Nail fix / repair']!]).toBe(0);
    const device = await createKioskDevice(db, { actor: owner, name: 'C kiosk', pin: '4321' });
    if (!device.ok) throw new Error(device.reason);
    const paired = await pairKiosk(db, { code: device.pairingCode });
    if (!paired.ok) throw new Error(paired.reason);
    const menu = await kioskMenu(db, paired.device);
    expect(menu.services.map((s) => s.name)).not.toContain('Nail fix / repair');
    expect(
      await kioskCheckIn(db, {
        device: paired.device,
        name: 'Sneaky',
        serviceIds: [svc['Nail fix / repair']!],
      }),
    ).toEqual({ ok: false, reason: 'unknown_service' });
    // Not as a plain walk-in either, and not with other services.
    expect(await walkIn(['Nail fix / repair']).catch((e: Error) => e.message)).toBe(
      'unknown_service',
    );
    const mixed = await createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [svc['Nail fix / repair']!, svc['Gel manicure']!],
      actor: desk,
      fix: { enteredBy: 'manager' },
    });
    expect(mixed).toMatchObject({ ok: false, reason: 'fix_alone' });
  });

  it("the desk sees the client's visits inside the window: date, services, technician", async () => {
    const t = await newTech('C-Linh', 'gel');
    const recent = await pastVisit(t, 'Gel manicure', '+18135559001', 'Kim', 3);
    await pastVisit(t, 'Gel manicure', '+18135559001', 'Kim', 20);
    const found = await fixCandidates(db, { locationId: LOC, query: '813 555 9001' });
    expect(found.windowDays).toBe(14);
    expect(found.visits.map((v) => v.visitId)).toEqual([recent]);
    expect(found.visits[0]).toMatchObject({
      services: ['Gel manicure'],
      technicianId: t.id,
      technician: 'C-Linh',
      technicianWorking: false,
      client: 'Kim F.',
    });
    expect((await fixCandidates(db, { locationId: LOC, query: 'kim' })).visits.length).toBe(1);
    // Nobody in the window: an empty list is the warning; a fix can still be entered.
    expect((await fixCandidates(db, { locationId: LOC, query: '813 555 9999' })).visits).toEqual(
      [],
    );
    // The window is a setting: 7 days hides a 10-day-old visit, 14 shows it.
    await sql`update visits set arrived_at = now() - interval '10 days' where id = ${recent}`;
    expect((await fixCandidates(db, { locationId: LOC, query: 'kim' })).visits.length).toBe(1);
    await saveRules((c) => {
      c.fixes.window_days = 7;
    });
    expect((await fixCandidates(db, { locationId: LOC, query: 'kim' })).visits.length).toBe(0);
    await saveRules((c) => {
      c.fixes.window_days = 14;
    });
  });

  it("a receptionist's fix waits for a manager; nobody can be called until then", async () => {
    const t = await newTech('C-Mai', 'acrylic');
    const orig = await pastVisit(t, 'Acrylic fill', '+18135559002', 'Ana', 2);
    await onFloor(t, 10);
    const r = await fixIn('receptionist', orig, { userId: deskActor.userId });
    if (!r.ok) throw new Error(r.reason);
    const [row] =
      await sql`select needs_approval, is_fix, fix_of_visit_id, client_id from visits where id = ${r.visitId}`;
    expect(row).toMatchObject({ needs_approval: true, is_fix: true, fix_of_visit_id: orig });
    const [o] = await sql`select client_id from visits where id = ${orig}`;
    expect(row!['client_id']).toBe(o!['client_id']);
    expect(await call(r.visitId)).toMatchObject({ ok: false, reason: 'needs_approval' });
    expect(
      await deskCall(db, {
        kind: 'desk_pick',
        visitId: r.visitId,
        technicianId: t.id,
        actor: desk,
        locationId: LOC,
      }),
    ).toMatchObject({ ok: false, reason: 'needs_approval' });
    // The database refuses too.
    await expect(
      sql`insert into turn_calls (organization_id, location_id, visit_id, technician_id, queue_snapshot) values (${ORG}, ${LOC}, ${r.visitId}, ${t.id}, '[]'::jsonb)`,
    ).rejects.toThrow(/approve/);
    expect((await deskOptions(db, LOC)).has(r.visitId)).toBe(false);

    expect(
      await reviewFix(db, { actor: manager, visitId: r.visitId, decision: 'approve' }),
    ).toEqual({ ok: true });
    // The desk picks: the technician who did the original work comes first.
    const opts = (await deskOptions(db, LOC)).get(r.visitId);
    expect(opts?.deskPicks).toBe(true);
    expect(opts?.technicians[0]).toMatchObject({ technicianId: t.id, original: true });
    // Her shift already holds the original visit's points; the fix adds none.
    const start = await pointsOf(t);
    const picked = await deskCall(db, {
      kind: 'desk_pick',
      visitId: r.visitId,
      technicianId: t.id,
      actor: desk,
      locationId: LOC,
    });
    if (!picked.ok) throw new Error(picked.reason);
    // Saying no is never a penalty.
    expect((await deny(picked.callId, t, 'other')).ok).toBe(true);
    expect(await pointsOf(t)).toBe(start);
    const again = await deskCall(db, {
      kind: 'desk_pick',
      visitId: r.visitId,
      technicianId: t.id,
      actor: desk,
      locationId: LOC,
    });
    if (!again.ok) throw new Error(again.reason);
    expect((await accept(again.callId, t)).ok).toBe(true);
    expect(await finish(t)).toEqual({ ok: true, points: 0 });
    expect(await pointsOf(t)).toBe(start);

    const log = await sql<{ action: string; after: Record<string, unknown> }[]>`
      select action, after from audit_log where entity_id = ${r.visitId} and action like 'fix_%' order by at`;
    expect(log.map((l) => l.action)).toEqual(['fix_entered', 'fix_approved']);
    expect(log[0]!.after).toMatchObject({
      fixOfVisitId: orig,
      inWindow: true,
      needsApproval: true,
    });
    expect(JSON.stringify(log)).not.toContain('Ana');
    expect(JSON.stringify(log)).not.toContain('9002');
    await clearFloor();
  });

  it("a manager's or owner's fix is approved at once; no visit in the window still goes through", async () => {
    const r = await fixIn('manager', null, { userId: manager.userId });
    if (!r.ok) throw new Error(r.reason);
    const [row] =
      await sql`select needs_approval, approved_by, fix_of_visit_id from visits where id = ${r.visitId}`;
    expect(row).toMatchObject({
      needs_approval: false,
      approved_by: manager.userId,
      fix_of_visit_id: null,
    });
    const [a] =
      await sql`select after from audit_log where entity_id = ${r.visitId} and action = 'fix_entered'`;
    expect(a!['after']).toMatchObject({ inWindow: false, needsApproval: false });
    // A receptionist's fix with nothing in the window: the manager may still approve it.
    const p = await fixIn('receptionist', null, { userId: deskActor.userId });
    if (!p.ok) throw new Error(p.reason);
    expect(
      await reviewFix(db, { actor: manager, visitId: p.visitId, decision: 'approve' }),
    ).toEqual({ ok: true });
    // Both stay open: the report below counts them.
  });

  it('a decline cancels the fix; another location cannot review it', async () => {
    const p = await fixIn('receptionist', null, { userId: deskActor.userId });
    if (!p.ok) throw new Error(p.reason);
    const elsewhere = { ...manager, locationId: randomUUID() };
    expect(
      await reviewFix(db, { actor: elsewhere, visitId: p.visitId, decision: 'approve' }),
    ).toEqual({
      ok: false,
      reason: 'wrong_location',
    });
    expect(
      await reviewFix(db, { actor: manager, visitId: p.visitId, decision: 'decline' }),
    ).toEqual({ ok: true });
    const [row] = await sql`select status, needs_approval from visits where id = ${p.visitId}`;
    expect(row).toMatchObject({ status: 'cancelled', needs_approval: false });
    expect(
      await reviewFix(db, { actor: manager, visitId: p.visitId, decision: 'approve' }),
    ).toEqual({
      ok: false,
      reason: 'not_pending',
    });
    const [a] =
      await sql`select count(*)::int as n from audit_log where entity_id = ${p.visitId} and action = 'fix_declined'`;
    expect(a!['n']).toBe(1);
  });

  it('a fix never moves her in the line: a 00 stays 00 after a free fix', async () => {
    const t = await newTech('C-Zero', 'gel');
    await onFloor(t, 10);
    const appt = await walkIn(['Gel fill'], { source: 'appointment', requestedTechnicianId: t.id });
    expect((await accept(await mustCall(appt, t), t)).ok).toBe(true);
    expect(await finish(t)).toEqual({ ok: true, points: 0 });
    const zeroZero = async () =>
      (await locationStatus(db, LOC)).find((r) => r.technicianId === t.id)?.hadAppointmentLast;
    expect(await zeroZero()).toBe(true);
    const f = await fixIn('owner', null, { userId: owner.userId });
    if (!f.ok) throw new Error(f.reason);
    const picked = await deskCall(db, {
      kind: 'desk_pick',
      visitId: f.visitId,
      technicianId: t.id,
      actor: desk,
      locationId: LOC,
    });
    if (!picked.ok) throw new Error(picked.reason);
    expect((await accept(picked.callId, t)).ok).toBe(true);
    expect(await finish(t)).toEqual({ ok: true, points: 0 });
    expect(await zeroZero()).toBe(true);
    await clearFloor();
  });

  it('reports: fixes per original technician, declined ones not counted', async () => {
    const today = localDate(new Date(), HEAVENLY.timezone);
    const rows = await fixesByOriginalTech(db, LOC, today);
    const mai = rows.find((r) => r.technician === 'C-Mai');
    expect(mai).toMatchObject({ fixes: 1, doneBySameTech: 1 });
    const none = rows.find((r) => r.technicianId === null);
    // With no visit found: the owner's fix that C-Zero did. The two approved
    // ones were still waiting when the floor was cleared (cancelled: not counted).
    expect(none?.fixes).toBe(1);
  });
});

describe('D. groups', () => {
  it('the desk enters a group: one visit and one client per person, linked by a party id', async () => {
    const a = await newTech('D-A', 'acrylic');
    const b = await newTech('D-B', 'acrylic');
    await onFloor(a, 30);
    await onFloor(b, 20);
    const r = await createParty(db, {
      organizationId: ORG,
      locationId: LOC,
      actor: { userId: deskActor.userId },
      people: [
        { firstName: 'Hana', lastName: 'Le', serviceIds: [svc['Gel manicure']!], note: 'Pink' },
        { firstName: 'Ivy', serviceIds: [svc['Basic pedicure']!], requestedTechnicianId: b.id },
        { firstName: 'Jo', serviceIds: [svc['Spa pedicure']!] },
      ],
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.visitIds.length).toBe(3);
    const rows = await sql<
      { party_id: string; group_id: string | null; client_id: string; needs_confirm: boolean }[]
    >`
      select party_id, group_id, client_id, needs_confirm from visits where id in ${sql(r.visitIds)}`;
    expect(new Set(rows.map((x) => x.party_id))).toEqual(new Set([r.partyId]));
    expect(rows.every((x) => x.group_id === null && !x.needs_confirm)).toBe(true);
    expect(new Set(rows.map((x) => x.client_id)).size).toBe(3);
    const desk_ = await waitingVisits(db, LOC);
    expect(desk_.filter((v) => v.partyId === r.partyId).map((v) => v.partySize)).toEqual([3, 3, 3]);
    // Each visit is called by turn on its own.
    const c1 = await call(r.visitIds[0]!);
    expect(c1).toMatchObject({ ok: true, technicianId: a.id });
    const c2 = await call(r.visitIds[1]!);
    expect(c2).toMatchObject({ ok: true, technicianId: b.id });
    expect(await call(r.visitIds[2]!)).toMatchObject({ ok: false, reason: 'nobody_eligible' });
    await clearFloor();
  });

  it("all or nothing, at most the rules' group size, every person named", async () => {
    const person = { firstName: 'X', serviceIds: [svc['Gel manicure']!] };
    const before = await sql`select count(*)::int as n from visits`;
    const bad = await createParty(db, {
      organizationId: ORG,
      locationId: LOC,
      actor: desk,
      people: [person, { firstName: 'Y', serviceIds: [randomUUID()] }],
    });
    expect(bad).toMatchObject({ ok: false, reason: 'unknown_service', person: 1 });
    expect((await sql`select count(*)::int as n from visits`)[0]!['n']).toBe(before[0]!['n']);
    const nine = Array.from({ length: 9 }, () => person);
    expect(
      await createParty(db, { organizationId: ORG, locationId: LOC, actor: desk, people: nine }),
    ).toMatchObject({
      ok: false,
      reason: 'party_too_big',
    });
    expect(
      await createParty(db, {
        organizationId: ORG,
        locationId: LOC,
        actor: desk,
        people: [person, { ...person, firstName: ' ' }],
      }),
    ).toMatchObject({ ok: false, reason: 'bad_name', person: 1 });
    await saveRules((c) => {
      c.groups.max_people = 3;
    });
    expect(
      await createParty(db, {
        organizationId: ORG,
        locationId: LOC,
        actor: desk,
        people: [person, person, person, person],
      }),
    ).toMatchObject({ ok: false, reason: 'party_too_big' });
    await saveRules((c) => {
      c.groups.max_people = 8;
    });
  });

  it('the kiosk group waits for the desk, writes no client until then, and confirms all or one by one', async () => {
    const device = await createKioskDevice(db, { actor: owner, name: 'D kiosk', pin: '4321' });
    if (!device.ok) throw new Error(device.reason);
    const paired = await pairKiosk(db, { code: device.pairingCode });
    if (!paired.ok) throw new Error(paired.reason);
    const clientsBefore = (await sql`select count(*)::int as n from clients`)[0]!['n'];
    const r = await kioskGroupCheckIn(db, {
      device: paired.device,
      phone: '+18135559100',
      people: [
        { name: 'Quinn', lastName: 'Ho', serviceIds: [svc['Gel manicure']!] },
        { name: 'Rae', serviceIds: [svc['Basic pedicure']!], note: 'Short nails' },
        { name: 'Sky', serviceIds: [svc['Spa pedicure']!] },
      ],
    });
    if (!r.ok) throw new Error(r.reason);
    const rows = await sql<
      { id: string; needs_confirm: boolean; kiosk_phone: string | null; client_id: string | null }[]
    >`
      select id, needs_confirm, kiosk_phone, client_id from visits where party_id = ${r.partyId} order by kiosk_name`;
    expect(rows.every((x) => x.needs_confirm && x.client_id === null)).toBe(true);
    expect(rows.filter((x) => x.kiosk_phone).length).toBe(1); // one phone, on the first person
    // The desk lists them in the order they were added.
    expect(
      (await waitingVisits(db, LOC)).filter((v) => v.partyId === r.partyId).map((v) => v.kioskName),
    ).toEqual(['Quinn', 'Rae', 'Sky']);
    expect((await sql`select count(*)::int as n from clients`)[0]!['n']).toBe(clientsBefore);
    // A fix cannot come in through a group either, and a person needs a name.
    expect(
      await kioskGroupCheckIn(db, {
        device: paired.device,
        people: [
          { name: 'A', serviceIds: [svc['Gel manicure']!] },
          { name: 'B', serviceIds: [svc['Nail fix / repair']!] },
        ],
      }),
    ).toMatchObject({ ok: false, reason: 'unknown_service', person: 1 });
    expect(
      await kioskGroupCheckIn(db, {
        device: paired.device,
        people: [
          { name: 'A', serviceIds: [svc['Gel manicure']!] },
          { name: '  ', serviceIds: [svc['Gel manicure']!] },
        ],
      }),
    ).toMatchObject({ ok: false, reason: 'bad_name', person: 1 });

    // One by one: only that person.
    const one = await reviewKioskVisit(db, {
      actor: deskActor,
      visitId: rows[0]!.id,
      decision: 'confirm',
    });
    expect(one).toEqual({ ok: true, visitIds: [rows[0]!.id] });
    // The rest at once.
    const rest = await reviewKioskVisit(db, {
      actor: deskActor,
      visitId: rows[1]!.id,
      decision: 'confirm',
      wholeParty: true,
    });
    expect(rest.ok && rest.visitIds.length).toBe(2);
    const after = await sql<
      { needs_confirm: boolean; client_id: string | null; kiosk_phone: string | null }[]
    >`
      select needs_confirm, client_id, kiosk_phone from visits where party_id = ${r.partyId}`;
    expect(after.every((x) => !x.needs_confirm && x.client_id && !x.kiosk_phone)).toBe(true);
    expect(new Set(after.map((x) => x.client_id)).size).toBe(3);
    const withPhone =
      await sql`select count(*)::int as n from clients where phone = '+18135559100'`;
    expect(withPhone[0]!['n']).toBe(1);
    await clearFloor();
  });
});

describe('E. client left', () => {
  it('the desk marks a called visit: no points, the visit closes as left, she keeps her place', async () => {
    const a = await newTech('E-A', 'gel');
    const b = await newTech('E-B', 'gel');
    await onFloor(a, 30);
    await onFloor(b, 20);
    const visit = await walkIn(['Gel manicure']);
    const c = await call(visit);
    expect(c).toMatchObject({ ok: true, technicianId: a.id });
    const r = await clientLeft(db, {
      visitId: visit,
      actor: { userId: deskActor.userId },
      locationId: LOC,
    });
    expect(r).toEqual({ ok: true, technicianId: a.id });
    const [v] = await sql`select status, left_at from visits where id = ${visit}`;
    expect(v!['status']).toBe('left');
    expect(v!['left_at']).not.toBeNull();
    const [tc] = await sql`select response from turn_calls where visit_id = ${visit}`;
    expect(tc!['response']).toBe('client_left');
    expect(await pointsOf(a)).toBe(0);
    const [st] = await sql`select status from technician_status where technician_id = ${a.id}`;
    expect(st!['status']).toBe('available');
    // She is still first in line.
    const next = await walkIn(['Gel manicure']);
    expect(await call(next)).toMatchObject({ ok: true, technicianId: a.id });
    const [log] =
      await sql`select after from audit_log where entity_id = ${visit} and action = 'client_left'`;
    expect(log!['after']).toMatchObject({ technicianId: a.id, by: 'desk', points: 0 });
    await clearFloor();
  });

  it('the called technician can mark it herself; another technician cannot; in service is refused', async () => {
    const a = await newTech('E-C', 'gel');
    const b = await newTech('E-D', 'gel');
    await onFloor(a, 30);
    await onFloor(b, 20);
    const visit = await walkIn(['Gel manicure']);
    await mustCall(visit, a);
    expect(
      await clientLeft(db, {
        visitId: visit,
        actor: { userId: b.userId },
        locationId: LOC,
        technicianId: b.id,
      }),
    ).toMatchObject({ ok: false, reason: 'not_your_call' });
    // v0.17.0: Heavenly's rule now asks the desk first (fairness.client_left_by_tech);
    // "direct" is the v0.16.0 behaviour this test was written for.
    await saveRules((c) => {
      c.fairness.client_left_by_tech = 'direct';
    });
    expect(
      await clientLeft(db, {
        visitId: visit,
        actor: { userId: a.userId },
        locationId: LOC,
        technicianId: a.id,
      }),
    ).toEqual({ ok: true, technicianId: a.id });
    await saveRules((c) => {
      c.fairness.client_left_by_tech = 'ask_desk';
    });
    const busy = await walkIn(['Gel manicure']);
    expect((await accept(await mustCall(busy, a), a)).ok).toBe(true);
    expect(await clientLeft(db, { visitId: busy, actor: desk, locationId: LOC })).toMatchObject({
      ok: false,
      reason: 'not_called',
    });
    expect(
      await clientLeft(db, { visitId: busy, actor: desk, locationId: randomUUID() }),
    ).toMatchObject({
      ok: false,
      reason: 'wrong_location',
    });
    await clearFloor();
  });
});

describe('F. need help', () => {
  it('the desk sees who needs help until someone acknowledges it; audited without the reason', async () => {
    const t = await newTech('F-Mai', 'gel');
    await onFloor(t, 10);
    const r = await askForHelp(db, {
      technicianId: t.id,
      actor: { userId: t.userId },
      reason: 'Need acetone',
    });
    expect(r).toMatchObject({ ok: true, alreadyOpen: false });
    if (!r.ok) return;
    const again = await askForHelp(db, { technicianId: t.id, actor: { userId: t.userId } });
    expect(again).toEqual({ ok: true, id: r.id, alreadyOpen: true });
    const open = await openHelpRequests(db, LOC);
    expect(open.map((o) => [o.technician, o.reason])).toEqual([['F-Mai', 'Need acetone']]);
    expect((await myOpenHelp(db, t.id))?.id).toBe(r.id);
    const elsewhere = { ...deskActor, locationId: randomUUID() };
    expect(await acknowledgeHelp(db, { actor: elsewhere, id: r.id })).toEqual({
      ok: false,
      reason: 'unknown_request',
    });
    expect(await acknowledgeHelp(db, { actor: deskActor, id: r.id })).toEqual({ ok: true });
    expect(await acknowledgeHelp(db, { actor: deskActor, id: r.id })).toEqual({
      ok: false,
      reason: 'already_acknowledged',
    });
    expect(await openHelpRequests(db, LOC)).toEqual([]);
    expect(await myOpenHelp(db, t.id)).toBeNull();
    const log = await sql<{ action: string; after: unknown }[]>`
      select action, after from audit_log where entity_id = ${r.id} order by at`;
    expect(log.map((l) => l.action)).toEqual(['help_requested', 'help_acknowledged']);
    expect(JSON.stringify(log)).not.toContain('acetone');
    expect(log[0]!.after).toMatchObject({ hasReason: true });
  });

  it('is rate limited per technician', async () => {
    const t = await newTech('F-Hoa', 'gel');
    let last: Awaited<ReturnType<typeof askForHelp>> | null = null;
    for (let i = 0; i <= HELP_PER_HOUR; i++) {
      last = await askForHelp(db, { technicianId: t.id, actor: { userId: t.userId } });
    }
    expect(last).toEqual({ ok: false, reason: 'too_many' });
  });
});

describe('G. owners and managers do not do nails', () => {
  it('no owner or manager has a technician row, so nobody calls them', async () => {
    const rows = await sql`
      select m.role from memberships m join technicians t on t.user_id = m.user_id and t.location_id = m.location_id
      where m.role in ('owner', 'manager')`;
    expect(rows.length).toBe(0);
  });
});

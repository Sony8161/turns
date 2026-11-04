// Done-when (REQ-ecc2ba80): an invalid config (negative minutes, text in a
// number field) is refused on save; saving creates a new version and never
// edits an old one; the engine reads only rule_config; the two unset values
// stay visible as unset; a preview re-sorts today's board under new rules.
// Added 2026-11-04 (Duong): an unanswered call is flagged after the configured
// minutes; the board carries an estimated wait and a long-wait flag.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callNext,
  createWalkIn,
  estimateWait,
  expireCall,
  finishVisit,
  floorAttention,
  respondToCall,
} from '../src/engine';
import {
  activeRules,
  previewBoard,
  ruleHistory,
  saveRuleConfig,
  validateRuleConfig,
  visitPointsUnder,
  type RuleConfig,
} from '../src/rules';
import { HEAVENLY, HEAVENLY_RULE_CONFIG_V1, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import { checkIn, shiftTotal, transition } from '../src/status';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
const desk = { userId: null };
let ownerId: string;
let manicure: string;
let fullSet: string;
let fullSetCategory: string;
type Tech = { id: string; userId: string };
let a: Tech;
let b: Tech;

function clone(): RuleConfig {
  return JSON.parse(JSON.stringify(HEAVENLY_RULE_CONFIG_V1)) as RuleConfig;
}

async function newUser(name: string, role: 'owner' | 'technician'): Promise<string> {
  const id = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${id}, 'authenticated', 'authenticated', ${`${name}-${id.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${id}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${id}, ${ORG}, ${LOC}, ${role})`;
  return id;
}

async function newTech(name: string): Promise<Tech> {
  const userId = await newUser(name, 'technician');
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${userId}, ${ORG}, ${LOC}, ${name}) returning id`;
  await checkIn(db, { technicianId: t!.id, actor: { userId }, position: null });
  await transition(db, { technicianId: t!.id, to: 'available', actor: { userId } });
  return { id: t!.id, userId };
}

async function walkIn(serviceIds: string[]): Promise<string> {
  const v = await createWalkIn(db, {
    organizationId: ORG,
    locationId: LOC,
    serviceIds,
    actor: desk,
  });
  if (!v.ok) throw new Error(v.reason);
  return v.visitId;
}

beforeAll(async () => {
  await resetAndMigrate();
  await seedHeavenly(TEST_URL);
  db = createDb(TEST_URL);
  ownerId = await newUser('Phu', 'owner');
  const [m] = await sql<
    { id: string }[]
  >`select id from services where location_id = ${LOC} and name = 'Basic manicure'`;
  const [f] = await sql<
    { id: string; category_id: string }[]
  >`select id, category_id from services where location_id = ${LOC} and name = 'Acrylic full set'`;
  manicure = m!.id;
  fullSet = f!.id;
  fullSetCategory = f!.category_id;
  a = await newTech('Thảo');
  b = await newTech('Linh');
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

describe('validateRuleConfig', () => {
  it("accepts Heavenly's version 1, with its two unset values kept as null", () => {
    const r = validateRuleConfig(HEAVENLY_RULE_CONFIG_V1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.penalties.late_tiers[2]?.start_points).toBeNull();
    expect(r.config.requests.requested_counts_points).toBeNull();
    expect(r.config.attention).toEqual({
      unanswered_call_min: 15,
      long_wait_min: 30,
      default_service_min: 45,
    });
  });

  it('refuses text in a number field, a negative minute count, and a missing field', () => {
    const text = clone() as unknown as { points: { default_service: unknown } };
    text.points.default_service = '1';
    const r1 = validateRuleConfig(text);
    expect(r1.ok).toBe(false);
    if (!r1.ok)
      expect(r1.errors).toContainEqual({ path: 'points.default_service', problem: 'not_a_number' });

    const negative = clone();
    negative.penalties.out_over_minutes = -5;
    const r2 = validateRuleConfig(negative);
    expect(r2.ok).toBe(false);
    if (!r2.ok)
      expect(r2.errors).toContainEqual({ path: 'penalties.out_over_minutes', problem: 'negative' });

    const missing = clone() as unknown as { penalties: Partial<RuleConfig['penalties']> };
    delete missing.penalties.deny;
    const r3 = validateRuleConfig(missing);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.errors).toContainEqual({ path: 'penalties.deny', problem: 'missing' });

    const noAttention = clone() as unknown as Partial<RuleConfig>;
    delete noAttention.attention;
    const r4 = validateRuleConfig(noAttention);
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.errors).toContainEqual({ path: 'attention', problem: 'missing' });
  });

  it('refuses points that are not a half step, and a late tier out of order', () => {
    const odd = clone();
    odd.points.fill_or_full_set = 0.3;
    const r1 = validateRuleConfig(odd);
    expect(r1.ok).toBe(false);
    if (!r1.ok)
      expect(r1.errors).toContainEqual({
        path: 'points.fill_or_full_set',
        problem: 'not_a_half_step',
      });

    const tiers = clone();
    tiers.penalties.late_tiers = [
      { after_minutes: 30, start_points: 1 },
      { after_minutes: 15, start_points: 0.5 },
    ];
    const r2 = validateRuleConfig(tiers);
    expect(r2.ok).toBe(false);
    if (!r2.ok)
      expect(r2.errors).toContainEqual({ path: 'penalties.late_tiers', problem: 'not_in_order' });
  });

  it('refuses unknown choices and a non-object', () => {
    const bad = clone() as unknown as { eligibility: { skill_match: string } };
    bad.eligibility.skill_match = 'maybe';
    const r = validateRuleConfig(bad);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors).toContainEqual({ path: 'eligibility.skill_match', problem: 'not_allowed' });
    expect(validateRuleConfig('nope').ok).toBe(false);
    expect(validateRuleConfig(null).ok).toBe(false);
    // Zero minutes would let the desk clear any call at once, with no penalty.
    const zero = clone();
    zero.attention.unanswered_call_min = 0;
    const r2 = validateRuleConfig(zero);
    expect(r2.ok).toBe(false);
    if (!r2.ok)
      expect(r2.errors).toContainEqual({
        path: 'attention.unanswered_call_min',
        problem: 'not_allowed',
      });
  });
});

describe('saveRuleConfig', () => {
  it('refuses an invalid config and writes nothing', async () => {
    const bad = clone();
    bad.penalties.deny = -1;
    const r = await saveRuleConfig(db, {
      organizationId: ORG,
      locationId: LOC,
      config: bad,
      actor: { userId: ownerId },
    });
    expect(r.ok).toBe(false);
    const [row] = await sql<
      { count: string }[]
    >`select count(*) from rule_configs where location_id = ${LOC}`;
    expect(Number(row?.count)).toBe(1);
  });

  it('refuses a category override for a category of another location', async () => {
    const other = clone();
    other.points.by_category = { [randomUUID()]: 1 };
    const r = await saveRuleConfig(db, {
      organizationId: ORG,
      locationId: LOC,
      config: other,
      actor: { userId: ownerId },
    });
    expect(r).toMatchObject({
      ok: false,
      errors: [{ path: 'points.by_category', problem: 'unknown_category' }],
    });
  });

  it('saves a new version with who and why, and the old version is untouched', async () => {
    const next = clone();
    next.penalties.deny = 2;
    const r = await saveRuleConfig(db, {
      organizationId: ORG,
      locationId: LOC,
      config: next,
      actor: { userId: ownerId },
      note: 'deny costs 2 from today',
    });
    expect(r).toMatchObject({ ok: true, version: 2 });
    const rows = await sql<
      { version: number; deny: number; created_by: string | null; note: string | null }[]
    >`select version, (config->'penalties'->>'deny')::float8 as deny, created_by, note from rule_configs where location_id = ${LOC} order by version`;
    expect(rows).toEqual([
      { version: 1, deny: 1, created_by: null, note: null },
      { version: 2, deny: 2, created_by: ownerId, note: 'deny costs 2 from today' },
    ]);
    const [audit] = await sql<
      { action: string; before: { version: number }; after: { version: number } }[]
    >`select action, before, after from audit_log where entity_type = 'rule_configs' order by at desc limit 1`;
    expect(audit).toMatchObject({
      action: 'rule_config_changed',
      before: { version: 1 },
      after: { version: 2 },
    });
    expect((await activeRules(db, LOC)).penalties.deny).toBe(2);
    expect((await ruleHistory(db, LOC)).map((h) => h.version)).toEqual([2, 1]);
  });

  it('refuses a save based on a version that is no longer the newest', async () => {
    const r = await saveRuleConfig(db, {
      organizationId: ORG,
      locationId: LOC,
      config: clone(),
      actor: { userId: ownerId },
      expectedVersion: 1,
    });
    expect(r).toEqual({ ok: false, reason: 'stale', latestVersion: 2 });
  });

  it('the database refuses an edit or a removal of any version, even from the service key', async () => {
    await expect(
      sql`update rule_configs set config = '{}'::jsonb where location_id = ${LOC} and version = 1`,
    ).rejects.toThrow(/append-only/);
    await expect(sql`delete from rule_configs where location_id = ${LOC}`).rejects.toThrow(
      /append-only/,
    );
  });

  it('the engine falls back to the last good version when a newer row is bad', async () => {
    // Only the service key can plant a bad row; the app refuses it on save.
    await sql`insert into rule_configs (organization_id, location_id, version, config) values (${ORG}, ${LOC}, 3, '{"points": "broken"}'::jsonb)`;
    expect((await activeRules(db, LOC)).penalties.deny).toBe(2);
    expect((await ruleHistory(db, LOC)).map((h) => [h.version, h.valid])).toEqual([
      [3, false],
      [2, true],
      [1, true],
    ]);
  });
});

describe('every number comes from rule_config', () => {
  it('engine.ts and status.ts never fall back to a literal for a rule value', () => {
    for (const file of ['engine.ts', 'status.ts']) {
      const src = readFileSync(join(__dirname, '..', 'src', file), 'utf8');
      const hits = src.match(
        /(points|penalties|attention|eligibility|requests|queue)\??\.\w+\s*\?\?/g,
      );
      expect({ file, hits: hits ?? [] }).toEqual({ file, hits: [] });
    }
  });

  it('the deny penalty follows the active version', async () => {
    // Version 2 is active (deny = 2). Thảo denies: +2, not +1.
    const visitId = await walkIn([manicure]);
    const c = await callNext(db, { visitId, actor: desk, locationId: LOC });
    expect(c).toMatchObject({ ok: true, technicianId: a.id });
    if (!c.ok) return;
    await respondToCall(db, {
      callId: c.callId,
      technicianId: a.id,
      response: 'denied',
      denyReason: 'other',
      actor: { userId: a.userId },
    });
    const [s] = await sql<
      { shift_id: string }[]
    >`select shift_id from technician_status where technician_id = ${a.id}`;
    expect(await shiftTotal(db, s!.shift_id)).toBe(2);
    // Linh takes it and finishes: ½ for a full set is unchanged in v2.
    const again = await callNext(db, { visitId, actor: desk, locationId: LOC });
    expect(again).toMatchObject({ ok: true, technicianId: b.id });
    if (!again.ok) return;
    await respondToCall(db, {
      callId: again.callId,
      technicianId: b.id,
      response: 'denied',
      denyReason: 'other',
      actor: { userId: b.userId },
    });
    await sql`update visits set status = 'cancelled', cancelled_at = now() where id = ${visitId}`;
  });

  it('a per-category override and the requested-technician multiplier are read from the config', () => {
    const rules = clone();
    rules.points.by_category = { [fullSetCategory]: 1.5 };
    rules.requests.requested_counts_points = 0.5;
    const fill = { isFillOrFullSet: true, categoryId: fullSetCategory };
    const other = { isFillOrFullSet: true, categoryId: randomUUID() };
    const standard = { isFillOrFullSet: false, categoryId: randomUUID() };
    expect(visitPointsUnder(rules, [fill], 'walk_in')).toBe(1.5);
    expect(visitPointsUnder(rules, [other], 'walk_in')).toBe(0.5);
    expect(visitPointsUnder(rules, [standard], 'request')).toBe(0.5);
    // Unset (null) means a requested visit counts like any other, until Phu decides.
    rules.requests.requested_counts_points = null;
    expect(visitPointsUnder(rules, [standard], 'request')).toBe(1);
  });
});

describe('attention: unanswered calls and the wait estimate', () => {
  it('estimateWait is a pure queue simulation', () => {
    const now = new Date('2026-11-04T15:00:00Z');
    const at = (min: number) => new Date(now.getTime() + min * 60_000);
    // Nobody on: unknown.
    expect(estimateWait({ now, available: 0, inService: [], waiting: [] })).toBeNull();
    // Someone free and nobody waiting: no wait.
    expect(estimateWait({ now, available: 1, inService: [], waiting: [] })).toBe(0);
    // One free technician, two waiting (30 and 45 min): the newcomer waits 75.
    expect(estimateWait({ now, available: 1, inService: [], waiting: [30, 45] })).toBe(75);
    // Two busy (free in 10 and 20), one waiting 30: it goes to the first free; newcomer waits 20.
    expect(estimateWait({ now, available: 0, inService: [at(10), at(20)], waiting: [30] })).toBe(
      20,
    );
    // A technician past their expected end counts as free now.
    expect(estimateWait({ now, available: 0, inService: [at(-5)], waiting: [] })).toBe(0);
  });

  it('flags a call with no answer past attention.unanswered_call_min, and reads the estimate', async () => {
    // Both techs had their deny; both are available again. Thảo 2 points, Linh 2 points.
    const visitId = await walkIn([manicure]);
    const c = await callNext(db, { visitId, actor: desk, locationId: LOC });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    let floor = await floorAttention(db, LOC);
    expect(floor.unansweredCalls).toEqual([]);
    // The call has been open for 16 minutes (v2 says 15).
    await sql`update turn_calls set called_at = now() - interval '16 minutes' where id = ${c.callId}`;
    floor = await floorAttention(db, LOC);
    expect(floor.unansweredCalls).toHaveLength(1);
    expect(floor.unansweredCalls[0]).toMatchObject({ callId: c.callId, visitId });
    expect(floor.unansweredCalls[0]!.waitedMin).toBeGreaterThanOrEqual(16);
    expect(floor.unansweredCallMin).toBe(15);
    expect(floor.longWaitMin).toBe(30);
    // The called technician is still counted as busy for the estimate; one is free: no wait.
    expect(floor.estimatedWaitMin).toBe(0);
    expect(floor.longWait).toBe(false);
    // The desk clears it: no penalty, the visit waits again, the flag is gone.
    const cleared = await expireCall(db, { callId: c.callId, actor: desk, locationId: LOC });
    expect(cleared).toEqual({ ok: true, visitId });
    const [row] = await sql<
      { response: string; status: string }[]
    >`select c.response, v.status from turn_calls c join visits v on v.id = c.visit_id where c.id = ${c.callId}`;
    expect(row).toEqual({ response: 'expired', status: 'waiting' });
    const [s] = await sql<
      { shift_id: string }[]
    >`select shift_id from technician_status where technician_id = ${c.technicianId}`;
    expect(await shiftTotal(db, s!.shift_id)).toBe(2); // unchanged: no penalty
    expect((await floorAttention(db, LOC)).unansweredCalls).toEqual([]);
    await sql`update visits set status = 'cancelled', cancelled_at = now() where id = ${visitId}`;
  });

  it('a call cannot be cleared before the rules say it is unanswered, nor from another location', async () => {
    const visitId = await walkIn([manicure]);
    expect(await callNext(db, { visitId, actor: desk, locationId: randomUUID() })).toMatchObject({
      ok: false,
      reason: 'wrong_location',
    });
    const c = await callNext(db, { visitId, actor: desk, locationId: LOC });
    if (!c.ok) throw new Error(c.reason);
    expect(
      await expireCall(db, { callId: c.callId, actor: desk, locationId: randomUUID() }),
    ).toMatchObject({ ok: false, reason: 'wrong_location' });
    expect(await expireCall(db, { callId: c.callId, actor: desk, locationId: LOC })).toMatchObject({
      ok: false,
      reason: 'too_soon',
    });
    await sql`update turn_calls set responded_at = now(), response = 'overridden' where id = ${c.callId}`;
    await sql`update visits set status = 'cancelled', cancelled_at = now() where id = ${visitId}`;
  });

  it('a long wait shows when the simulated wait reaches attention.long_wait_min', async () => {
    // Thảo and Linh both go on break; three walk-ins wait. Nobody can take them: unknown wait.
    await transition(db, { technicianId: a.id, to: 'break', actor: { userId: a.userId } });
    await transition(db, { technicianId: b.id, to: 'break', actor: { userId: b.userId } });
    const ids = [await walkIn([manicure]), await walkIn([manicure]), await walkIn([fullSet])];
    let floor = await floorAttention(db, LOC);
    expect(floor.estimatedWaitMin).toBeNull();
    // Linh comes back: one free technician, 30 + 30 + 75 minutes queued: 135 minute wait.
    await transition(db, { technicianId: b.id, to: 'available', actor: { userId: b.userId } });
    floor = await floorAttention(db, LOC);
    expect(floor.estimatedWaitMin).toBe(135);
    expect(floor.longWait).toBe(true);
    for (const id of ids) {
      await sql`update visits set status = 'cancelled', cancelled_at = now() where id = ${id}`;
    }
    await transition(db, { technicianId: a.id, to: 'available', actor: { userId: a.userId } });
  });
});

describe('previewBoard', () => {
  it("re-sorts today's board under a candidate config without saving it", async () => {
    // Thảo 2 (deny), Linh 2 (deny). Linh finishes a full set: ½ under v2. Board: Thảo 2, Linh 2½.
    const visitId = await walkIn([fullSet]);
    const c = await callNext(db, { visitId, actor: desk, locationId: LOC });
    expect(c).toMatchObject({ ok: true, technicianId: a.id });
    if (!c.ok) return;
    // Thảo was called first (checked in first); hand it to Linh by a deny would add points,
    // so Linh takes the next one instead: cancel and re-enter with a request for Linh.
    await sql`update turn_calls set responded_at = now(), response = 'overridden' where id = ${c.callId}`;
    await sql`update visits set status = 'waiting' where id = ${visitId}`;
    await sql`update visits set requested_technician_id = ${b.id} where id = ${visitId}`;
    const again = await callNext(db, { visitId, actor: desk, locationId: LOC });
    expect(again).toMatchObject({ ok: true, technicianId: b.id });
    if (!again.ok) return;
    await respondToCall(db, {
      callId: again.callId,
      technicianId: b.id,
      response: 'accepted',
      actor: { userId: b.userId },
    });
    await finishVisit(db, { technicianId: b.id, actor: { userId: b.userId } });

    // Candidate: a full set is worth 3 and a deny costs ½. Thảo ½, Linh 3½: same order,
    // different numbers; then a candidate where a deny costs 3: Thảo 3, Linh 3½.
    const candidate = clone();
    candidate.points.fill_or_full_set = 3;
    candidate.penalties.deny = 0.5;
    const rows = await previewBoard(db, LOC, candidate);
    expect(rows.map((r) => [r.displayName, r.points, r.previewPoints])).toEqual([
      ['Thảo', 2, 0.5],
      ['Linh', 2.5, 3.5],
    ]);
    const [row] = await sql<
      { count: string }[]
    >`select count(*) from rule_configs where location_id = ${LOC}`;
    expect(Number(row?.count)).toBe(3); // v1, v2 and the planted bad v3: nothing saved
  });
});

// v0.17.1 "Review fixes" (17-Next-Build-Plan.md, Release 2): the findings
// #4 to #11 of the review of v0.11.0 to v0.16.1, the permissions mismatch,
// and the areas the review had not reached (indexes, clock-change days).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deskAnswerCall, deskFinishVisit, setReceptionistActsFor } from '../src/act-for';
import { techBoard } from '../src/board';
import {
  CLIENT_LOOKUPS,
  CLIENT_SEARCH_LIMIT,
  findClients,
  maskPhone,
  parseClientQuery,
  revealClientPhone,
  setReceptionistSeesPhone,
  viewClient,
} from '../src/clients';
import {
  callNext,
  clientLeft,
  createWalkIn,
  deskOptions,
  expireCall,
  finishVisit,
  leftWithoutService,
  reassignVisit,
  respondToCall,
} from '../src/engine';
import {
  FRESHA_HOST,
  feedStates,
  feedSummary,
  pendingFeeds,
  pollFeeds,
  reviewFeed,
  safeFetchText,
  setFeed,
  setTechCalendarLinks,
  syncFeed,
  type FetchText,
  type GetOnce,
  type Resolve,
} from '../src/feeds';
import { findFixVisits } from '../src/fixes';
import { feedStateFor, testFeedLink } from '../src/fresha';
import {
  createKioskDevice,
  KIOSK_LIMITS,
  kioskCheckInLimited,
  kioskGroupCheckIn,
  pairKiosk,
  reviewKioskVisit,
} from '../src/kiosk';
import { setTechnicianLevel, type SkillLevel } from '../src/levels';
import { allowedAt, can } from '../src/permissions';
import { activeRules, previewBoard, saveRuleConfig, type RuleConfig } from '../src/rules';
import { HEAVENLY, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import type { StaffActor } from '../src/staff';
import { checkIn, shiftTotal, sweepFloor, transition } from '../src/status';
import { setReceptionistEdits, staffAdjustPoints } from '../src/tech-settings';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
const nobody = { userId: null };
let owner: StaffActor;
let manager: StaffActor;
let reception: StaffActor;
type Tech = { id: string; userId: string; name: string; actor: StaffActor };
const svc: Record<string, string> = {};
const PUBLIC: Resolve = async () => [{ address: '93.184.216.34', family: 4 }];

async function newUser(name: string, role: string): Promise<string> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${role}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${LOC}, ${role}::role)`;
  return userId;
}

async function staff(name: string, role: 'owner' | 'manager' | 'receptionist') {
  return { userId: await newUser(name, role), role, organizationId: ORG, locationId: LOC };
}

async function newTech(name: string, level: SkillLevel = 'acrylic'): Promise<Tech> {
  const userId = await newUser(name, 'technician');
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${userId}, ${ORG}, ${LOC}, ${name}) returning id`;
  const filled = await setTechnicianLevel(db, { actor: owner, technicianId: t!.id, level });
  if (!filled.ok) throw new Error(filled.reason);
  return {
    id: t!.id,
    userId,
    name,
    actor: { userId, role: 'technician', organizationId: ORG, locationId: LOC },
  };
}

async function onFloor(t: Tech, minutesAgo = 30) {
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

async function clearFloor() {
  await sql`update turn_calls set responded_at = now(), response = 'overridden' where responded_at is null`;
  await sql`update visits set status = 'cancelled', cancelled_at = now() where status in ('waiting', 'called', 'in_service')`;
  await sql`update shifts set checked_out_at = now() where checked_out_at is null`;
  await sql`update technician_status set status = 'off', shift_id = null where status <> 'off'`;
  await sql`delete from appointments`;
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

async function mustCall(visitId: string): Promise<{ callId: string; technicianId: string }> {
  const r = await callNext(db, { visitId, actor: nobody, locationId: LOC });
  if (!r.ok) throw new Error(`call: ${r.reason} ${r.detail ?? ''}`);
  return r;
}

async function pointsOf(t: Tech): Promise<number> {
  const [s] = await sql<
    { shift_id: string | null }[]
  >`select shift_id from technician_status where technician_id = ${t.id}`;
  return s?.shift_id ? shiftTotal(db, s.shift_id) : 0;
}

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

async function auditRows(action: string) {
  return sql<
    { entity_id: string | null; after: unknown; before: unknown; reason: string | null }[]
  >`select entity_id, after, before, reason from audit_log where action = ${action} order by at, id`;
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
  owner = await staff('Phu', 'owner');
  manager = await staff('Vy', 'manager');
  reception = await staff('Hạnh', 'receptionist');
});

afterAll(async () => {
  await db.$client.end();
  await sql.end();
});

// ---------------------------------------------------------------------------
describe('#4 the client list cannot be harvested', () => {
  let phoned: string;
  beforeAll(async () => {
    const [c] = await sql<{ id: string }[]>`insert into clients
      (organization_id, location_id, name, first_name, last_name, search_name, phone)
      values (${ORG}, ${LOC}, 'Lan Nguyen', 'Lan', 'Nguyen', 'lan nguyen', '+18135550199') returning id`;
    phoned = c!.id;
    for (let i = 0; i < CLIENT_SEARCH_LIMIT + 5; i++) {
      await sql`insert into clients (organization_id, location_id, name, first_name, last_name, search_name)
        values (${ORG}, ${LOC}, ${`Annie T${i}`}, 'Annie', ${`T${i}`}, ${`annie t${i}`})`;
    }
  });

  it('a search needs 3 letters of a name or 4 digits of a phone', async () => {
    // v0.18.0: two letters only as a whole first or last name (Võ, Lê): never a prefix.
    expect(parseClientQuery('an')).toEqual({ name: 'an', exact: true });
    expect(parseClientQuery('a')).toBeNull();
    expect(parseClientQuery('ann')).toEqual({ name: 'ann' });
    expect(parseClientQuery('8 1 3')).toBeNull();
    expect(parseClientQuery('019')).toBeNull();
    expect(parseClientQuery('0199')).toEqual({ phone: '0199' });
    const viewer = await staff('Short', 'receptionist');
    expect(await findClients(db, { viewer, query: 'l' })).toEqual({
      ok: false,
      reason: 'too_short',
    });
    // A refused search costs nothing.
    const [rl] =
      await sql`select count(*)::int as n from rate_limits where key = ${`client-search:${viewer.userId}`}`;
    expect(rl!['n']).toBe(0);
  });

  it('still at most 25 results, and with the owner switch off the list never shows a whole phone', async () => {
    // v0.18.0: the switch is on by default (the desk sees whole numbers);
    // off, the v0.17.1 masked list comes back.
    await setReceptionistSeesPhone(db, { actor: owner, on: false });
    const viewer = await staff('Lister', 'manager');
    const r = await findClients(db, { viewer, query: 'annie' });
    expect(r.ok && r.hits.length).toBe(CLIENT_SEARCH_LIMIT);
    const lan = await findClients(db, { viewer, query: 'lan' });
    expect(lan.ok && lan.hits[0]?.phone).toBe('(•••) •••-0199');
    expect(maskPhone('+18135550199')).toBe('(•••) •••-0199');
    await setReceptionistSeesPhone(db, { actor: owner, on: true });
  });

  it('client pages and the fix lookup count against the same limit as search', async () => {
    const viewer = await staff('Harvester', 'receptionist');
    let used = 0;
    for (; used < CLIENT_LOOKUPS.limit - 20; used++) {
      expect((await findClients(db, { viewer, query: 'annie' })).ok).toBe(true);
    }
    for (; used < CLIENT_LOOKUPS.limit - 10; used++) {
      expect((await viewClient(db, { viewer, clientId: phoned })).ok).toBe(true);
    }
    for (; used < CLIENT_LOOKUPS.limit; used++) {
      expect((await findFixVisits(db, { viewer, query: 'lan' })).ok).toBe(true);
    }
    expect(await viewClient(db, { viewer, clientId: phoned })).toEqual({
      ok: false,
      reason: 'too_many',
    });
    expect(await findClients(db, { viewer, query: 'annie' })).toEqual({
      ok: false,
      reason: 'too_many',
    });
    expect(await findFixVisits(db, { viewer, query: 'lan' })).toEqual({
      ok: false,
      reason: 'too_many',
    });
    expect(await revealClientPhone(db, { viewer, clientId: phoned })).toEqual({
      ok: false,
      reason: 'too_many',
    });
    // Someone else at the desk is not slowed down by it.
    const other = await staff('Other', 'receptionist');
    expect((await viewClient(db, { viewer: other, clientId: phoned })).ok).toBe(true);
  });

  it('with the owner switch off, only owners and managers see the full phone; a receptionist taps Show, counted and audited', async () => {
    await setReceptionistSeesPhone(db, { actor: owner, on: false });
    const desk = await staff('Desk', 'receptionist');
    const mine = await viewClient(db, { viewer: desk, clientId: phoned });
    expect(mine).toMatchObject({
      ok: true,
      client: { phone: '(•••) •••-0199', phoneMasked: true },
    });
    for (const viewer of [manager, owner]) {
      expect(await viewClient(db, { viewer, clientId: phoned })).toMatchObject({
        ok: true,
        client: { phone: '+18135550199', phoneMasked: false },
      });
    }
    const before = (await auditRows('client_phone_shown')).length;
    expect(await revealClientPhone(db, { viewer: desk, clientId: phoned })).toEqual({
      ok: true,
      phone: '+18135550199',
    });
    const rows = await auditRows('client_phone_shown');
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)!.entity_id).toBe(phoned);
    // No number in the audit row, not even the last four digits.
    expect(JSON.stringify(rows.at(-1))).not.toMatch(/0199|813|555/);
    const [rl] =
      await sql`select count from rate_limits where key = ${`client-search:${desk.userId}`}`;
    expect(Number(rl!['count'])).toBe(2);
    // Another location's client is not found; a technician never sees one.
    expect(await revealClientPhone(db, { viewer: desk, clientId: randomUUID() })).toEqual({
      ok: false,
      reason: 'unknown_client',
    });
    const tech = await newTech('Peek');
    expect(await revealClientPhone(db, { viewer: tech.actor, clientId: phoned })).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect(await viewClient(db, { viewer: tech.actor, clientId: phoned })).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    await setReceptionistSeesPhone(db, { actor: owner, on: true });
  });
});

// ---------------------------------------------------------------------------
describe('#5 kiosk groups', () => {
  async function kiosk(name: string) {
    const device = await createKioskDevice(db, { actor: owner, name, pin: '4321' });
    if (!device.ok) throw new Error(device.reason);
    const paired = await pairKiosk(db, { code: device.pairingCode });
    if (!paired.ok) throw new Error(paired.reason);
    return paired.device;
  }
  const countOf = async (key: string) =>
    Number((await sql`select count from rate_limits where key = ${key}`)[0]?.['count'] ?? 0);

  it('each person in a group counts against the device limit', async () => {
    const device = await kiosk('Limit kiosk');
    expect(KIOSK_LIMITS.perDevice.limit).toBe(30);
    const big = { device, ip: '10.0.0.8', phone: null, people: 8 };
    expect(await kioskCheckInLimited(db, big)).toBe(false); // 8
    expect(await kioskCheckInLimited(db, big)).toBe(false); // 16
    expect(await kioskCheckInLimited(db, big)).toBe(false); // 24
    expect(await kioskCheckInLimited(db, big)).toBe(true); // 32: over 30
    expect(await countOf(`kiosk:device:${device.deviceId}`)).toBe(32);
    // One person is one; the group's phone still counts once (Duong, v0.16.0).
    const other = await kiosk('One kiosk');
    expect(
      await kioskCheckInLimited(db, { device: other, ip: '10.9.9.9', phone: null, people: 1 }),
    ).toBe(false);
    expect(await countOf(`kiosk:device:${other.deviceId}`)).toBe(1);
    await kioskCheckInLimited(db, {
      device: other,
      ip: '10.9.9.9',
      phone: '+18135557001',
      people: 5,
    });
    expect(await countOf(`kiosk:phone:${LOC}:+18135557001`)).toBe(1);
  });

  it('"Confirm all" makes no client row for a person without a phone, like one check-in', async () => {
    const device = await kiosk('Group kiosk');
    const before = Number((await sql`select count(*)::int as n from clients`)[0]!['n']);
    const r = await kioskGroupCheckIn(db, {
      device,
      phone: '+18135557002',
      people: [
        { name: 'Uma', serviceIds: [svc['Gel manicure']!] },
        { name: 'Vee', serviceIds: [svc['Basic pedicure']!] },
        { name: 'Wren', serviceIds: [svc['Spa pedicure']!] },
      ],
    });
    if (!r.ok) throw new Error(r.reason);
    const ok = await reviewKioskVisit(db, {
      actor: reception,
      visitId: r.visitIds[0]!,
      decision: 'confirm',
      wholeParty: true,
    });
    expect(ok.ok && ok.visitIds.length).toBe(3);
    const after = Number((await sql`select count(*)::int as n from clients`)[0]!['n']);
    expect(after).toBe(before + 1);
    const rows = await sql<{ kiosk_name: string; client_id: string | null }[]>`
      select kiosk_name, client_id from visits where party_id = ${r.partyId} order by kiosk_name`;
    expect(rows.map((x) => [x.kiosk_name, x.client_id !== null])).toEqual([
      ['Uma', true],
      ['Vee', false],
      ['Wren', false],
    ]);
    await clearFloor();
  });
});

// ---------------------------------------------------------------------------
describe("#6 a technician's own Fresha link", () => {
  const LINK = 'https://calendar-export.fresha.com/1111-SECRET-TOKEN.ics';
  const LINK2 = 'https://calendar-export.fresha.com/2222-SECRET-OTHER.ics';
  const ics = (d: Date) => d.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const cal = (name: string) =>
    [
      'BEGIN:VCALENDAR',
      `X-WR-CALNAME:${name}`,
      'BEGIN:VEVENT',
      'UID:x1@f',
      `DTSTART:${ics(new Date(Date.now() + 3 * 3_600_000))}`,
      `DTEND:${ics(new Date(Date.now() + 4 * 3_600_000))}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
  const fromText =
    (text: string): FetchText =>
    async () => ({ ok: true, text });
  let linh: Tech;
  let mai: Tech;
  const apptsOf = async (t: Tech) =>
    Number(
      (
        await sql`select count(*)::int as n from appointments where technician_id = ${t.id} and cancelled_at is null`
      )[0]!['n'],
    );
  const save = (t: Tech, url: string, fetchText?: FetchText) =>
    setFeed(db, {
      actor: t.actor,
      technicianId: t.id,
      url,
      resolve: PUBLIC,
      hosts: [FRESHA_HOST],
      ...(fetchText ? { fetchText } : {}),
    });

  beforeAll(async () => {
    linh = await newTech('Linh');
    mai = await newTech('Mai Tran');
  });

  it('defaults to owner_approves; only the owner changes it, audited', async () => {
    const [l] = await sql`select tech_calendar_links from locations where id = ${LOC}`;
    expect(l!['tech_calendar_links']).toBe('owner_approves');
    expect(await setTechCalendarLinks(db, { actor: manager, value: 'open' })).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect(await setTechCalendarLinks(db, { actor: owner, value: 'anything' as 'open' })).toEqual({
      ok: false,
      reason: 'bad_value',
    });
    expect(await setTechCalendarLinks(db, { actor: owner, value: 'open' })).toEqual({ ok: true });
    expect(await setTechCalendarLinks(db, { actor: owner, value: 'owner_approves' })).toEqual({
      ok: true,
    });
    const rows = await auditRows('tech_calendar_links_setting');
    expect(rows.map((r) => r.after)).toEqual([
      { techCalendarLinks: 'open' },
      { techCalendarLinks: 'owner_approves' },
    ]);
  });

  it('owner_approves: her link waits, is never fetched and holds nothing', async () => {
    const r = await save(linh, LINK);
    expect(r).toMatchObject({ ok: true, pending: true });
    if (!r.ok) return;
    expect(await feedStateFor(db, linh.id)).toMatchObject({ connected: true, pending: true });
    let fetched = 0;
    const counting: FetchText = async () => {
      fetched++;
      return { ok: true, text: cal('Fresha - LINH  Heavenly Nails') };
    };
    expect(await syncFeed(db, { feedId: r.feedId, fetchText: counting })).toEqual({
      ok: false,
      error: 'pending',
    });
    await pollFeeds(db, { fetchText: counting, force: true, locationId: LOC });
    expect(fetched).toBe(0);
    expect(await apptsOf(linh)).toBe(0);
    // Not "failing" or "stale" on the board: waiting for the owner or a manager.
    const summary = await feedSummary(db, LOC);
    expect(summary.stale).not.toContain('Linh');
    expect(summary.pending).toEqual(['Linh']);
    expect((await pendingFeeds(db, LOC)).map((p) => p.technicianId)).toEqual([linh.id]);
    const state = (await feedStates(db, LOC)).find((f) => f.technicianId === linh.id);
    expect(state?.pending).toBe(true);
    const set = (await auditRows('feed_set')).at(-1)!;
    expect(set.after).toMatchObject({ technicianId: linh.id, pending: true, by: 'technician' });
    expect(JSON.stringify(set)).not.toContain('SECRET');
  });

  it('a receptionist or the tech cannot approve; a manager can, with no URL in the log', async () => {
    for (const actor of [reception, linh.actor]) {
      expect(await reviewFeed(db, { actor, technicianId: linh.id, decision: 'approve' })).toEqual({
        ok: false,
        reason: 'not_allowed',
      });
    }
    expect(
      await reviewFeed(db, { actor: manager, technicianId: linh.id, decision: 'approve' }),
    ).toMatchObject({ ok: true });
    const [f] =
      await sql`select id, needs_approval, approved_by from calendar_feeds where technician_id = ${linh.id}`;
    expect(f).toMatchObject({ needs_approval: false, approved_by: manager.userId });
    const row = (await auditRows('feed_approved')).at(-1)!;
    expect(row.after).toEqual({ technicianId: linh.id });
    expect(JSON.stringify(row)).not.toMatch(/SECRET|fresha/);
    expect(
      await syncFeed(db, {
        feedId: f!['id'] as string,
        fetchText: fromText(cal('Fresha - LINH  Heavenly Nails')),
      }),
    ).toMatchObject({ ok: true, added: 1 });
    expect(await apptsOf(linh)).toBe(1);
    expect(
      await reviewFeed(db, { actor: owner, technicianId: linh.id, decision: 'approve' }),
    ).toEqual({ ok: false, reason: 'not_pending' });
  });

  it('a new link from her waits again; one the owner pastes for her never waits', async () => {
    expect(await save(linh, LINK2)).toMatchObject({ ok: true, pending: true });
    const [f] =
      await sql`select needs_approval, approved_at from calendar_feeds where technician_id = ${linh.id}`;
    expect(f).toMatchObject({ needs_approval: true, approved_at: null });
    const byOwner = await setFeed(db, {
      actor: owner,
      technicianId: linh.id,
      url: LINK,
      resolve: PUBLIC,
      hosts: [FRESHA_HOST],
    });
    expect(byOwner).toMatchObject({ ok: true, pending: false });
  });

  it('declining removes the link', async () => {
    await save(linh, LINK2);
    expect(
      await reviewFeed(db, { actor: owner, technicianId: linh.id, decision: 'decline' }),
    ).toMatchObject({ ok: true });
    const [f] =
      await sql`select url, archived_at from calendar_feeds where technician_id = ${linh.id}`;
    expect(f!['url']).toBe('');
    expect(f!['archived_at']).not.toBeNull();
    expect((await auditRows('feed_declined')).at(-1)!.after).toEqual({ technicianId: linh.id });
  });

  it('name_must_match: the calendar must carry her name; then it works at once', async () => {
    await setTechCalendarLinks(db, { actor: owner, value: 'name_must_match' });
    expect(await save(mai, LINK2, fromText(cal('Fresha - LINH  Heavenly Nails')))).toEqual({
      ok: false,
      reason: 'calendar_name',
    });
    expect(
      await save(mai, LINK2, fromText(cal('Fresha - MAI TRAN  Heavenly Nails'))),
    ).toMatchObject({ ok: true, pending: false });
    await setTechCalendarLinks(db, { actor: owner, value: 'open' });
    expect(await save(mai, LINK)).toMatchObject({ ok: true, pending: false });
    await setTechCalendarLinks(db, { actor: owner, value: 'owner_approves' });
  });
});

// ---------------------------------------------------------------------------
describe('#7 every redirect hop is checked against the Fresha host list', () => {
  const LINK = 'https://calendar-export.fresha.com/3333-SECRET.ics';
  const okBody = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
  const offList: GetOnce = async (url) =>
    url.hostname === FRESHA_HOST
      ? { status: 302, location: 'https://evil.example/cal.ics' }
      : { status: 200, body: okBody };
  const onList: GetOnce = async (url) =>
    url.pathname.endsWith('/moved.ics')
      ? { status: 200, body: okBody }
      : { status: 301, location: '/moved.ics' };

  it('the fetch refuses a hop off the list, follows one on it', async () => {
    expect(await safeFetchText(PUBLIC, { hosts: [FRESHA_HOST], get: offList })(LINK)).toEqual({
      ok: false,
      error: 'not_fresha',
    });
    expect(await safeFetchText(PUBLIC, { hosts: [FRESHA_HOST], get: onList })(LINK)).toEqual({
      ok: true,
      text: okBody,
    });
  });

  it('the test of a link checks every hop', async () => {
    expect(
      await testFeedLink(db, {
        actor: owner,
        url: LINK,
        hosts: [FRESHA_HOST],
        fetchOptions: { resolve: PUBLIC, get: offList },
      }),
    ).toEqual({ ok: false, reason: 'not_fresha' });
  });

  it('the poll checks every hop', async () => {
    const t = await newTech('Hop');
    const r = await setFeed(db, {
      actor: owner,
      technicianId: t.id,
      url: LINK,
      resolve: PUBLIC,
      hosts: [FRESHA_HOST],
    });
    if (!r.ok) throw new Error(r.reason);
    expect(
      await syncFeed(db, { feedId: r.feedId, fetchOptions: { resolve: PUBLIC, get: offList } }),
    ).toEqual({ ok: false, error: 'not_fresha' });
    const polled = await pollFeeds(db, {
      locationId: LOC,
      force: true,
      now: new Date(Date.now() + 120_000),
      fetchOptions: { resolve: PUBLIC, get: offList },
    });
    expect(polled.failed).toBeGreaterThanOrEqual(1);
    const [f] = await sql`select last_error from calendar_feeds where id = ${r.feedId}`;
    expect(f!['last_error']).toBe('not_fresha');
    await sql`update calendar_feeds set archived_at = now(), url = '' where id = ${r.feedId}`;
  });

  it("an owner's other (not Fresha) link keeps the public-address check on every hop", async () => {
    const t = await newTech('Other link');
    const r = await setFeed(db, {
      actor: owner,
      technicianId: t.id,
      url: 'https://calendar.example.org/me.ics',
      resolve: PUBLIC,
    });
    if (!r.ok) throw new Error(r.reason);
    // A redirect to another public host is followed, as in Part 7 ...
    const elsewhere: GetOnce = async (url) =>
      url.hostname === 'calendar.example.org'
        ? { status: 302, location: 'https://cdn.example.net/me.ics' }
        : { status: 200, body: okBody };
    expect(
      await syncFeed(db, { feedId: r.feedId, fetchOptions: { resolve: PUBLIC, get: elsewhere } }),
    ).toMatchObject({ ok: true });
    // ... and a hop to a private address is still refused.
    const inside: Resolve = async (host) =>
      host === 'calendar.example.org'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '10.0.0.5', family: 4 }];
    expect(
      await syncFeed(db, { feedId: r.feedId, fetchOptions: { resolve: inside, get: elsewhere } }),
    ).toEqual({ ok: false, error: 'private_address' });
    await sql`update calendar_feeds set archived_at = now(), url = '' where id = ${r.feedId}`;
  });
});

// ---------------------------------------------------------------------------
describe('#8 reassign refuses a closed visit', () => {
  it('left after the call, walked out, or closed at day end', async () => {
    await clearFloor();
    const a = await newTech('Re A');
    const b = await newTech('Re B');
    await onFloor(a, 40);
    await onFloor(b, 20);
    const left = await walkIn(['Basic pedicure']);
    await mustCall(left);
    expect((await clientLeft(db, { visitId: left, actor: nobody, locationId: LOC })).ok).toBe(true);
    const walked = await walkIn(['Basic pedicure']);
    expect(
      (await leftWithoutService(db, { visitId: walked, actor: nobody, locationId: LOC })).ok,
    ).toBe(true);
    const dayEnd = await walkIn(['Basic pedicure']);
    await sql`update visits set arrived_at = now() - interval '2 days' where id = ${dayEnd}`;
    await sweepFloor(db, LOC);
    const [de] = await sql`select status, close_reason from visits where id = ${dayEnd}`;
    expect(de).toMatchObject({ status: 'cancelled', close_reason: 'day_end' });
    for (const visitId of [left, walked, dayEnd]) {
      expect(
        await reassignVisit(db, { visitId, toTechnicianId: b.id, actor: manager, reason: 'test' }),
      ).toMatchObject({ ok: false, reason: 'visit_closed' });
    }
    await clearFloor();
  });
});

// ---------------------------------------------------------------------------
describe('#9 one lock order: visit first, then call', () => {
  // Each pair runs at the same moment on two connections. Before v0.17.1
  // respondToCall locked the call first and could deadlock with the others.
  let a: Tech;
  let b: Tech;
  beforeAll(async () => {
    await clearFloor();
    a = await newTech('Lock A');
    b = await newTech('Lock B');
  });

  async function called(): Promise<{ visitId: string; callId: string; tech: Tech }> {
    await clearFloor();
    await onFloor(a, 40);
    await onFloor(b, 20);
    const visitId = await walkIn(['Basic pedicure']);
    const c = await mustCall(visitId);
    return { visitId, callId: c.callId, tech: c.technicianId === a.id ? a : b };
  }

  const accept = (callId: string, t: Tech) =>
    respondToCall(db, {
      callId,
      technicianId: t.id,
      response: 'accepted',
      actor: { userId: t.userId },
    });

  /** Both at once; neither may throw (a deadlock or a "try again"). */
  async function race(
    left: () => Promise<{ ok: boolean }>,
    right: () => Promise<{ ok: boolean }>,
  ): Promise<boolean[]> {
    const settled = await Promise.allSettled([left(), right()]);
    for (const s of settled) if (s.status === 'rejected') throw s.reason;
    return settled.map((s) => (s as PromiseFulfilledResult<{ ok: boolean }>).value.ok);
  }

  for (const round of [1, 2, 3]) {
    it(`desk "Client left" and her Accept (round ${round})`, async () => {
      const c = await called();
      const oks = await race(
        () => clientLeft(db, { visitId: c.visitId, actor: nobody, locationId: LOC }),
        () => accept(c.callId, c.tech),
      );
      expect(oks.filter(Boolean).length).toBe(1);
    });

    it(`desk "Client left" and the desk's Accept for her (round ${round})`, async () => {
      const c = await called();
      const oks = await race(
        () => clientLeft(db, { visitId: c.visitId, actor: nobody, locationId: LOC }),
        () => deskAnswerCall(db, { actor: reception, callId: c.callId, response: 'accepted' }),
      );
      expect(oks.filter(Boolean).length).toBe(1);
    });

    it(`her "Client left" and her Deny (round ${round})`, async () => {
      const c = await called();
      await race(
        () =>
          clientLeft(db, {
            visitId: c.visitId,
            actor: { userId: c.tech.userId },
            locationId: LOC,
            technicianId: c.tech.id,
          }),
        () =>
          respondToCall(db, {
            callId: c.callId,
            technicianId: c.tech.id,
            response: 'denied',
            denyReason: 'other',
            actor: { userId: c.tech.userId },
          }),
      );
    });

    it(`expire and her Accept (round ${round})`, async () => {
      const c = await called();
      await sql`update turn_calls set called_at = now() - interval '30 minutes' where id = ${c.callId}`;
      const oks = await race(
        () => expireCall(db, { callId: c.callId, actor: nobody, locationId: LOC }),
        () => accept(c.callId, c.tech),
      );
      expect(oks.filter(Boolean).length).toBe(1);
    });

    it(`reassign and her Accept (round ${round})`, async () => {
      const c = await called();
      const other = c.tech.id === a.id ? b : a;
      await race(
        () =>
          reassignVisit(db, {
            visitId: c.visitId,
            toTechnicianId: other.id,
            actor: manager,
            reason: 'race',
          }),
        () => accept(c.callId, c.tech),
      );
    });

    it(`the day-end close-out and her Accept (round ${round})`, async () => {
      const c = await called();
      await sql`update visits set arrived_at = now() - interval '2 days' where id = ${c.visitId}`;
      await sql`update turn_calls set called_at = now() - interval '2 days' where id = ${c.callId}`;
      await race(
        () => sweepFloor(db, LOC).then(() => ({ ok: true })),
        () => accept(c.callId, c.tech),
      );
    });

    it(`the desk's Finish for her and reassign (round ${round})`, async () => {
      const c = await called();
      expect((await accept(c.callId, c.tech)).ok).toBe(true);
      const other = c.tech.id === a.id ? b : a;
      await race(
        () => deskFinishVisit(db, { actor: reception, technicianId: c.tech.id }),
        () =>
          reassignVisit(db, {
            visitId: c.visitId,
            toTechnicianId: other.id,
            actor: manager,
            reason: 'race',
          }),
      );
    });
  }

  afterAll(async () => {
    await clearFloor();
  });
});

// ---------------------------------------------------------------------------
describe('#10 and #11 fixes, checked on the server', () => {
  let a: Tech;
  let original: string;
  beforeAll(async () => {
    await clearFloor();
    a = await newTech('Fix A');
    await onFloor(a, 60);
    await sql`insert into clients
      (organization_id, location_id, name, first_name, last_name, search_name, phone)
      values (${ORG}, ${LOC}, 'Kim Fix', 'Kim', 'Fix', 'kim fix', '+18135550177')`;
    original = await walkIn(['Gel manicure'], { client: { phone: '+18135550177' } });
    const call = await mustCall(original);
    await respondToCall(db, {
      callId: call.callId,
      technicianId: a.id,
      response: 'accepted',
      actor: { userId: a.userId },
    });
    const done = await finishVisit(db, { technicianId: a.id, actor: { userId: a.userId } });
    expect(done.ok).toBe(true);
  });

  const fix = (ofVisitId: string | null) =>
    createWalkIn(db, {
      organizationId: ORG,
      locationId: LOC,
      serviceIds: [svc['Nail fix / repair']!],
      actor: { userId: manager.userId },
      fix: { enteredBy: 'manager', ofVisitId },
    });

  /** The desk picks her for the fix; she accepts. */
  async function startFix(visitId: string) {
    await sql`insert into turn_calls (organization_id, location_id, visit_id, technician_id, kind, queue_snapshot)
      values (${ORG}, ${LOC}, ${visitId}, ${a.id}, 'desk_pick', '[]'::jsonb)`;
    await sql`update visits set status = 'called' where id = ${visitId}`;
    const [open] =
      await sql`select id from turn_calls where visit_id = ${visitId} and responded_at is null`;
    const r = await respondToCall(db, {
      callId: open!['id'] as string,
      technicianId: a.id,
      response: 'accepted',
      actor: { userId: a.userId },
    });
    expect(r.ok).toBe(true);
  }

  it('a fix must point at a completed visit that is not a fix, inside the window', async () => {
    const ok = await fix(original);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    // A fix of that fix (once it is done) is refused.
    await sql`update visits set status = 'completed', completed_at = now() where id = ${ok.visitId}`;
    expect(await fix(ok.visitId)).toMatchObject({ ok: false, reason: 'unknown_fix_visit' });
    // Outside the window (Heavenly: 14 days).
    await sql`update visits set arrived_at = now() - interval '15 days' where id = ${original}`;
    expect(await fix(original)).toMatchObject({ ok: false, reason: 'unknown_fix_visit' });
    await sql`update visits set arrived_at = now() - interval '13 days' where id = ${original}`;
    expect((await fix(original)).ok).toBe(true);
    // Not finished yet, or unknown here.
    const open = await walkIn(['Basic pedicure']);
    expect(await fix(open)).toMatchObject({ ok: false, reason: 'unknown_fix_visit' });
    expect(await fix(randomUUID())).toMatchObject({ ok: false, reason: 'unknown_fix_visit' });
    await sql`update visits set status = 'cancelled' where status in ('waiting', 'called')`;
  });

  it('a fix always posts 0, whatever the rules say', async () => {
    const fixId = svc['Nail fix / repair']!;
    for (const value of [2, undefined]) {
      await saveRules((c) => {
        const table = { ...(c.points.by_service ?? {}) };
        if (value === undefined) delete table[fixId];
        else table[fixId] = value;
        c.points.by_service = table;
      });
      const before = await pointsOf(a);
      const r = await fix(original);
      if (!r.ok) throw new Error(r.reason);
      const [snap] =
        await sql`select points_value_snapshot from visit_services where visit_id = ${r.visitId}`;
      expect(Number(snap!['points_value_snapshot'])).toBe(0);
      await startFix(r.visitId);
      expect(await finishVisit(db, { technicianId: a.id, actor: { userId: a.userId } })).toEqual({
        ok: true,
        points: 0,
      });
      expect(await pointsOf(a)).toBe(before);
    }
    // The rules preview never re-values a fix either.
    const candidate = structuredClone(await activeRules(db, LOC));
    candidate.points.by_service = { ...(candidate.points.by_service ?? {}), [fixId]: 3 };
    const preview = (await previewBoard(db, LOC, candidate)).find((p) => p.technicianId === a.id);
    expect(preview?.previewPoints).toBe(preview?.points);
  });

  it('a fix still in the chair at day end posts 0 too', async () => {
    await saveRules((c) => {
      c.points.by_service = { ...(c.points.by_service ?? {}), [svc['Nail fix / repair']!]: 2 };
    });
    const r = await fix(original);
    if (!r.ok) throw new Error(r.reason);
    await startFix(r.visitId);
    await sql`update visits set arrived_at = now() - interval '1 day', started_at = now() - interval '1 day' where id = ${r.visitId}`;
    await sweepFloor(db, LOC);
    const [v] =
      await sql`select status, auto_finished, points_posted from visits where id = ${r.visitId}`;
    expect(v).toMatchObject({ status: 'completed', auto_finished: true });
    expect(Number(v!['points_posted'])).toBe(0);
    await saveRules((c) => {
      c.points.by_service = { ...(c.points.by_service ?? {}), [svc['Nail fix / repair']!]: 0 };
    });
    await clearFloor();
  });
});

// ---------------------------------------------------------------------------
describe('the permissions table matches the owner switches, on the server', () => {
  it('receptionists edit techs, adjust points and act for a tech only while the switches are on', async () => {
    const desk = await staff('Switch', 'receptionist');
    for (const cap of ['edit_technicians', 'adjust_points', 'act_for_technician'] as const) {
      expect(can('receptionist', cap)).toBe(true);
      expect(await allowedAt(db, desk, cap)).toBe(true);
      expect(await allowedAt(db, manager, cap)).toBe(true);
    }
    expect(can('receptionist', 'manage_levels')).toBe(false);
    // v0.18.0: a switched right now (on by default, Duong 2026-11-13).
    expect(await allowedAt(db, desk, 'see_client_phone')).toBe(true);
    await setReceptionistEdits(db, { actor: owner, on: false });
    expect(await allowedAt(db, desk, 'edit_technicians')).toBe(false);
    expect(await allowedAt(db, desk, 'adjust_points')).toBe(false);
    expect(await allowedAt(db, desk, 'act_for_technician')).toBe(true);
    expect(await allowedAt(db, manager, 'adjust_points')).toBe(true);
    const t = await newTech('Switch T');
    await onFloor(t);
    expect(
      await staffAdjustPoints(db, { actor: desk, technicianId: t.id, delta: 1, reason: 'x' }),
    ).toEqual({ ok: false, reason: 'not_allowed' });
    await setReceptionistEdits(db, { actor: owner, on: true });
    expect(
      await staffAdjustPoints(db, { actor: desk, technicianId: t.id, delta: 1, reason: 'x' }),
    ).toEqual({ ok: true });
    await setReceptionistActsFor(db, { actor: owner, on: false });
    expect(await allowedAt(db, desk, 'act_for_technician')).toBe(false);
    expect(await allowedAt(db, desk, 'edit_technicians')).toBe(true);
    await setReceptionistActsFor(db, { actor: owner, on: true });
    for (const cap of ['edit_technicians', 'adjust_points', 'act_for_technician'] as const) {
      expect(await allowedAt(db, t.actor, cap)).toBe(false);
    }
    await clearFloor();
  });
});

// ---------------------------------------------------------------------------
describe('Pick a tech says when she is held for her appointment', () => {
  it('"held" with the appointment time, not "available"', async () => {
    await clearFloor();
    const t = await newTech('Held');
    await onFloor(t);
    const start = new Date(Math.ceil((Date.now() + 20 * 60_000) / 60_000) * 60_000);
    await sql`insert into appointments (organization_id, location_id, technician_id, start_at, end_at, source)
      values (${ORG}, ${LOC}, ${t.id}, ${start}, ${new Date(start.getTime() + 3_600_000)}, 'manual')`;
    const visitId = await walkIn(['Nail art / design']);
    const options = (await deskOptions(db, LOC)).get(visitId);
    const mine = options?.technicians.find((o) => o.technicianId === t.id);
    expect(mine).toMatchObject({ status: 'held', canCall: false });
    expect(mine?.appointmentAt?.getTime()).toBe(start.getTime());
    await clearFloor();
  });
});

// ---------------------------------------------------------------------------
describe('clock-change days: the sweep and the tech card too', () => {
  // v0.17.0 tested coming back and the queue; these cover the other two
  // places the same minutes are counted: the board's sweep (she is still
  // out) and the tech card's "held for an appointment".
  let t: Tech;
  beforeAll(async () => {
    await clearFloor();
    t = await newTech('Clock2');
  });
  const at = (iso: string) => new Date(iso);
  async function wipe() {
    await sql`update technician_status set status = 'off', shift_id = null where technician_id = ${t.id}`;
    await sql`delete from turn_ledger where technician_id = ${t.id}`;
    await sql`delete from shifts where technician_id = ${t.id}`;
    await sql`delete from appointments where technician_id = ${t.id}`;
  }
  for (const day of [
    {
      name: 'spring forward',
      outAt: '2026-03-08T06:30:00Z', // 01:30 EST
      sweepShort: '2026-03-08T07:00:00Z', // 03:00 EDT: 30 real minutes
      sweepLong: '2026-03-08T07:35:00Z', // 03:35 EDT: 65 real minutes
      appointment: '2026-03-08T07:10:00Z', // 03:10 EDT
      heldAt: '2026-03-08T06:50:00Z',
      freeAt: '2026-03-08T06:30:00Z',
    },
    {
      name: 'fall back',
      outAt: '2026-11-01T05:10:00Z', // 01:10 EDT
      sweepShort: '2026-11-01T05:50:00Z', // 01:50 EDT: 40 real minutes
      sweepLong: '2026-11-01T06:20:00Z', // 01:20 EST: 70 real minutes
      appointment: '2026-11-01T06:20:00Z', // 01:20 EST
      heldAt: '2026-11-01T05:55:00Z',
      freeAt: '2026-11-01T05:40:00Z',
    },
  ]) {
    it(`${day.name}: the sweep posts out-over after 60 real minutes`, async () => {
      for (const [when, posts] of [
        [day.sweepShort, false],
        [day.sweepLong, true],
      ] as const) {
        await wipe();
        const start = new Date(at(day.outAt).getTime() - 10 * 60_000);
        const me = { userId: t.userId };
        await checkIn(db, { technicianId: t.id, actor: me, position: null, now: start });
        await transition(db, { technicianId: t.id, to: 'available', actor: me, now: start });
        await transition(db, { technicianId: t.id, to: 'out', actor: me, now: at(day.outAt) });
        const swept = await sweepFloor(db, LOC, at(when));
        expect(swept.outOverPosted.includes(t.id)).toBe(posts);
        expect(await pointsOf(t)).toBe(posts ? 1 : 0);
      }
    });

    it(`${day.name}: the tech card's hold counts real minutes`, async () => {
      await wipe();
      const start = new Date(at(day.freeAt).getTime() - 30 * 60_000);
      const me = { userId: t.userId };
      await checkIn(db, { technicianId: t.id, actor: me, position: null, now: start });
      await transition(db, { technicianId: t.id, to: 'available', actor: me, now: start });
      const appt = at(day.appointment);
      await sql`insert into appointments (organization_id, location_id, technician_id, start_at, end_at, source)
        values (${ORG}, ${LOC}, ${t.id}, ${appt}, ${new Date(appt.getTime() + 3_600_000)}, 'manual')`;
      const card = async (now: Date) =>
        (await techBoard(db, LOC, now)).find((c) => c.technicianId === t.id);
      expect((await card(at(day.heldAt)))?.heldForAppointment).toBe(true);
      expect((await card(at(day.freeAt)))?.heldForAppointment).toBe(false);
    });
  }
  afterAll(async () => {
    await wipe();
  });
});

// ---------------------------------------------------------------------------
describe('indexes, checked against the queries that use them', () => {
  it('the open visit on a technician, calls and visits by day have indexes', async () => {
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes where schemaname = 'public'
        and indexname in ('visits_assigned_open', 'turn_calls_location_called', 'visits_location_arrived')`;
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      'turn_calls_location_called',
      'visits_assigned_open',
      'visits_location_arrived',
    ]);
    expect(rows.find((r) => r.indexname === 'visits_assigned_open')!.indexdef).toMatch(
      /WHERE .*status.*called.*in_service/,
    );
  });
});

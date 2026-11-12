// Done-when (v0.11.0, Connect Fresha): the onboarding screens accept Fresha
// calendar links only, test a link without saving it, suggest the technician a
// calendar belongs to without assigning it, let a technician connect their own
// calendar and nobody else's, and never put the URL in the audit log or on a
// screen. Threat model T13, T14.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkFreshaUrl,
  feedHosts,
  feedStates,
  removeFeed,
  setFeed,
  syncFeed,
  type FetchText,
  type Resolve,
} from '../src/feeds';
import {
  calendarName,
  feedStateFor,
  normalizeName,
  suggestTechnician,
  testFeedLink,
} from '../src/fresha';
import { HEAVENLY, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import type { StaffActor } from '../src/staff';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
const NOW = new Date('2026-11-12T12:00:00Z');
const PUBLIC: Resolve = async () => [{ address: '93.184.216.34', family: 4 }];
const LINK = 'https://calendar-export.fresha.com/71450a6c-SECRET-TOKEN.ics';
const OTHER_LINK = 'https://calendar-export.fresha.com/99999999-SECRET-OTHER.ics';

let owner: StaffActor;
let duong: { techId: string; userId: string; actor: StaffActor };
let thao: { techId: string; userId: string; actor: StaffActor };

const ics = (name: string, events: string) =>
  [
    'BEGIN:VCALENDAR',
    `X-WR-CALNAME:${name}`,
    'VERSION:2.0',
    'PRODID:-//Elixir ICalendar//Elixir ICalendar//EN',
    events,
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');
const event = (uid: string, start: string, end: string, extra = '') =>
  [`BEGIN:VEVENT`, `UID:${uid}`, `DTSTART:${start}`, `DTEND:${end}`, extra, 'END:VEVENT']
    .filter(Boolean)
    .join('\r\n');
const EMPTY = ics('Fresha - DUONG LAM  Heavenly Nails', '');
const TWO_AHEAD = ics(
  'Fresha - DUONG LAM  Heavenly Nails',
  [
    event('a@f', '20261112T150000Z', '20261112T160000Z'),
    event('b@f', '20261113T150000Z', '20261113T160000Z'),
    event('c@f', '20261113T170000Z', '20261113T180000Z', 'STATUS:CANCELLED'),
    event('past@f', '20261112T080000Z', '20261112T090000Z'),
  ].join('\r\n'),
);
const fromText =
  (text: string): FetchText =>
  async () => ({ ok: true, text });

async function addTech(name: string) {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`t-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${LOC}, 'technician')`;
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${userId}, ${ORG}, ${LOC}, ${name}) returning id`;
  const actor: StaffActor = { userId, role: 'technician', organizationId: ORG, locationId: LOC };
  return { techId: t!.id, userId, actor };
}

beforeAll(async () => {
  await resetAndMigrate();
  await seedHeavenly(TEST_URL);
  db = createDb(TEST_URL);
  const ownerId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${ownerId}, 'authenticated', 'authenticated', ${`o-${ownerId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${ownerId}, 'Phu')`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${ownerId}, ${ORG}, ${LOC}, 'owner')`;
  owner = { userId: ownerId, role: 'owner', organizationId: ORG, locationId: LOC };
  duong = await addTech('Dương');
  thao = await addTech('Thảo');
});

afterAll(async () => {
  await db?.$client.end();
  await sql.end();
});

describe('Fresha links only, for onboarding (T13)', () => {
  it('accepts calendar-export.fresha.com over https, refuses other hosts', () => {
    expect(checkFreshaUrl(LINK).ok).toBe(true);
    expect(checkFreshaUrl('webcal://calendar-export.fresha.com/x.ics').ok).toBe(true);
    expect(checkFreshaUrl('https://CALENDAR-EXPORT.FRESHA.COM/x.ics').ok).toBe(true);
    for (const bad of [
      'https://calendar.google.com/x.ics',
      'https://calendar-export.fresha.com.evil.example/x.ics',
      'https://evil.example/calendar-export.fresha.com/x.ics',
      'https://fresha.com/x.ics',
    ]) {
      expect(checkFreshaUrl(bad)).toEqual({ ok: false, problem: 'not_fresha' });
    }
    expect(checkFreshaUrl('http://calendar-export.fresha.com/x.ics')).toEqual({
      ok: false,
      problem: 'not_https',
    });
  });

  it('more hosts can be allowed by config, never by a bad entry', () => {
    expect(feedHosts(undefined)).toEqual(['calendar-export.fresha.com']);
    expect(feedHosts(' Cal.Example.com , ,bad host,*.x.com')).toEqual([
      'calendar-export.fresha.com',
      'cal.example.com',
    ]);
    const hosts = feedHosts('cal.example.com');
    expect(checkFreshaUrl('https://cal.example.com/a.ics', hosts).ok).toBe(true);
  });
});

describe('calendar name and suggestion', () => {
  it('reads X-WR-CALNAME, unfolded and unescaped', () => {
    expect(calendarName(EMPTY)).toBe('Fresha - DUONG LAM  Heavenly Nails');
    expect(
      calendarName('BEGIN:VCALENDAR\r\nX-WR-CALNAME:Fresha - Th\r\n ảo\\, B\r\nEND:VCALENDAR'),
    ).toBe('Fresha - Thảo, B');
    expect(calendarName('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).toBeNull();
  });

  it('matches names without accents or case, and never guesses between two', () => {
    expect(normalizeName('Dương Lâm')).toBe('duong lam');
    const techs = [
      { id: 'd', name: 'Dương' },
      { id: 't', name: 'Thảo' },
      { id: 'm', name: 'Mai' },
    ];
    expect(suggestTechnician('Fresha - DUONG LAM  Heavenly Nails', techs)).toBe('d');
    expect(suggestTechnician('Fresha - THAO NGUYEN  Heavenly Nails', techs)).toBe('t');
    expect(suggestTechnician('Fresha - KIM  Heavenly Nails', techs)).toBeNull();
    expect(suggestTechnician(null, techs)).toBeNull();
    // Two technicians match equally: no suggestion rather than a wrong one.
    expect(
      suggestTechnician('Fresha - MAI THAO', [
        { id: 'm', name: 'Mai' },
        { id: 't', name: 'Thảo' },
      ]),
    ).toBeNull();
    // A full-name match beats a first-name match.
    expect(
      suggestTechnician('Fresha - MAI TRAN', [
        { id: 'm1', name: 'Mai' },
        { id: 'm2', name: 'Mai Tran' },
      ]),
    ).toBe('m2');
  });
});

describe('test a link without saving it', () => {
  it('counts upcoming appointments, suggests the technician, saves nothing', async () => {
    const r = await testFeedLink(db, {
      actor: owner,
      url: LINK,
      fetchText: fromText(TWO_AHEAD),
      now: NOW,
    });
    expect(r).toEqual({
      ok: true,
      upcoming: 2,
      calendarName: 'Fresha - DUONG LAM  Heavenly Nails',
      suggestedTechnicianId: duong.techId,
    });
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from calendar_feeds`;
    expect(row!.n).toBe(0);
  });

  it('an empty calendar works, with no appointments yet', async () => {
    const r = await testFeedLink(db, {
      actor: owner,
      url: LINK,
      fetchText: fromText(EMPTY),
      now: NOW,
    });
    expect(r).toMatchObject({ ok: true, upcoming: 0 });
  });

  it('names what is wrong: not Fresha, unreachable, not a calendar', async () => {
    expect(
      await testFeedLink(db, { actor: owner, url: 'https://calendar.google.com/a.ics' }),
    ).toEqual({ ok: false, reason: 'not_fresha' });
    expect(
      await testFeedLink(db, {
        actor: owner,
        url: LINK,
        fetchText: async () => ({ ok: false, error: 'timeout' }),
      }),
    ).toEqual({ ok: false, reason: 'timeout' });
    expect(
      await testFeedLink(db, {
        actor: owner,
        url: LINK,
        fetchText: fromText('<html>nope</html>'),
      }),
    ).toEqual({ ok: false, reason: 'not_a_calendar' });
  });

  it('writes a feed_tested audit row with no URL or token', async () => {
    const rows = await sql<
      { after: unknown; entity_id: string | null }[]
    >`select after, entity_id from audit_log where action = 'feed_tested'`;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('71450a6c');
    expect(text).toContain('not_fresha');
  });

  it('a receptionist or manager cannot test links; a technician only for themselves', async () => {
    for (const role of ['receptionist', 'manager'] as const) {
      expect(await testFeedLink(db, { actor: { ...owner, role }, url: LINK })).toEqual({
        ok: false,
        reason: 'not_allowed',
      });
    }
    expect(
      await testFeedLink(db, {
        actor: duong.actor,
        technicianId: thao.techId,
        url: LINK,
        fetchText: fromText(EMPTY),
      }),
    ).toEqual({ ok: false, reason: 'not_allowed' });
    const own = await testFeedLink(db, {
      actor: duong.actor,
      technicianId: duong.techId,
      url: LINK,
      fetchText: fromText(TWO_AHEAD),
      now: NOW,
    });
    // A technician gets the count, not a suggestion about other people.
    expect(own).toMatchObject({ ok: true, upcoming: 2, suggestedTechnicianId: null });
  });
});

describe('a technician connects their own calendar (T13, T14)', () => {
  it('saves for their own row, Fresha links only', async () => {
    expect(
      await setFeed(db, {
        actor: duong.actor,
        technicianId: duong.techId,
        url: 'https://calendar.google.com/a.ics',
        resolve: PUBLIC,
      }),
    ).toEqual({ ok: false, reason: 'not_fresha' });
    const r = await setFeed(db, {
      actor: duong.actor,
      technicianId: duong.techId,
      url: LINK,
      resolve: PUBLIC,
    });
    expect(r.ok).toBe(true);
  });

  it("cannot set or remove another technician's calendar", async () => {
    expect(
      await setFeed(db, {
        actor: duong.actor,
        technicianId: thao.techId,
        url: OTHER_LINK,
        resolve: PUBLIC,
      }),
    ).toEqual({ ok: false, reason: 'not_allowed' });
    await setFeed(db, {
      actor: owner,
      technicianId: thao.techId,
      url: OTHER_LINK,
      resolve: PUBLIC,
    });
    expect(await removeFeed(db, { actor: duong.actor, technicianId: thao.techId })).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    const [row] = await sql<
      { url: string }[]
    >`select url from calendar_feeds where technician_id = ${thao.techId}`;
    expect(row!.url).toBe(OTHER_LINK);
  });

  it('a technician whose membership is off cannot connect a calendar', async () => {
    await sql`update memberships set active = false where user_id = ${thao.userId}`;
    expect(
      await setFeed(db, {
        actor: thao.actor,
        technicianId: thao.techId,
        url: OTHER_LINK,
        resolve: PUBLIC,
      }),
    ).toEqual({ ok: false, reason: 'not_allowed' });
    await sql`update memberships set active = true where user_id = ${thao.userId}`;
  });

  it('the database refuses a technician writing calendar_feeds directly', async () => {
    const err = await sql
      .begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub', ${duong.userId}, true)`;
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: duong.userId, role: 'authenticated' })}, true)`;
        await tx.unsafe('set local role authenticated');
        await tx`update calendar_feeds set url = 'https://evil.example/x.ics' where technician_id = ${thao.techId}`;
      })
      .catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('42501');
  });

  it('the state the technician sees has no URL: connected, last synced', async () => {
    const [f] = await sql<
      { id: string }[]
    >`select id from calendar_feeds where technician_id = ${duong.techId}`;
    const before = await feedStateFor(db, duong.techId, NOW);
    expect(before).toMatchObject({ connected: true, lastSyncedAt: null, lastError: null });
    const synced = await syncFeed(db, { feedId: f!.id, fetchText: fromText(TWO_AHEAD), now: NOW });
    expect(synced.ok).toBe(true);
    const after = await feedStateFor(db, duong.techId, NOW);
    expect(after).toMatchObject({ connected: true, lastError: null, upcoming: 2 });
    expect(after.lastSyncedAt).toEqual(NOW);
    const text = JSON.stringify([after, await feedStates(db, LOC, NOW)]);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('71450a6c');
    expect(await feedStateFor(db, randomUUID(), NOW)).toMatchObject({ connected: false });
  });

  it('a technician can disconnect their own calendar', async () => {
    expect(await removeFeed(db, { actor: duong.actor, technicianId: duong.techId })).toEqual({
      ok: true,
    });
    expect(await feedStateFor(db, duong.techId, NOW)).toMatchObject({ connected: false });
  });
});

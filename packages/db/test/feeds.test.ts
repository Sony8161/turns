// Done-when (REQ-0c2b89ef, Part 7): the calendar poll is https only, refuses
// private addresses, has size and time limits; a failed poll shows on the
// board and writes an audit row; the feed URL is never sent to a client
// (no app role can read it; the audit log holds only the hint). Threat model
// T13, T14, T15.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkFeedUrl,
  feedStates,
  feedSummary,
  isPublicAddress,
  parseIcs,
  pollFeeds,
  removeFeed,
  resolvePublic,
  safeFetchText,
  setFeed,
  syncFeed,
  urlHint,
  zonedToUtc,
  type FetchText,
  type Resolve,
} from '../src/feeds';
import { sampleIcs } from '../src/feed-local';
import { HEAVENLY, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import type { StaffActor } from '../src/staff';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'sample.ics'), 'utf8');
const ZONE = 'America/New_York';
const NOW = new Date('2026-11-12T12:00:00Z');

describe('feed URL checks (T13)', () => {
  it('accepts https and webcal, refuses everything else', () => {
    expect(checkFeedUrl('https://calendar.fresha.com/abc.ics').ok).toBe(true);
    const webcal = checkFeedUrl('webcal://calendar.fresha.com/abc.ics');
    expect(webcal.ok && webcal.url.protocol).toBe('https:');
    expect(checkFeedUrl('http://calendar.fresha.com/abc.ics')).toEqual({
      ok: false,
      problem: 'not_https',
    });
    expect(checkFeedUrl('file:///etc/passwd')).toMatchObject({ ok: false, problem: 'not_https' });
    expect(checkFeedUrl('ftp://x.example/a')).toMatchObject({ ok: false, problem: 'not_https' });
    expect(checkFeedUrl('not a url')).toMatchObject({ ok: false, problem: 'not_a_url' });
    expect(checkFeedUrl('https://user:pw@x.example/a')).toMatchObject({
      ok: false,
      problem: 'has_credentials',
    });
    expect(checkFeedUrl('https://x.example:8443/a')).toMatchObject({
      ok: false,
      problem: 'bad_port',
    });
    expect(checkFeedUrl(`https://x.example/${'a'.repeat(2100)}`)).toMatchObject({
      ok: false,
      problem: 'too_long',
    });
  });

  it('only public addresses pass', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::a00:1',
      '2002:a00:1::',
      'ff02::1',
      'not-an-ip',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it('refuses a host when any DNS answer is private, and IP literals directly', async () => {
    const fake =
      (answers: string[]): Resolve =>
      async () =>
        answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    const u = (s: string) => new URL(s);
    expect(await resolvePublic(u('https://ok.example/a'), fake(['93.184.216.34']))).toMatchObject({
      ok: true,
    });
    expect(
      await resolvePublic(u('https://mixed.example/a'), fake(['93.184.216.34', '10.0.0.5'])),
    ).toEqual({ ok: false, problem: 'private_address' });
    expect(await resolvePublic(u('https://localhost/a'), fake(['127.0.0.1']))).toEqual({
      ok: false,
      problem: 'private_address',
    });
    expect(await resolvePublic(u('https://127.0.0.1/a'))).toEqual({
      ok: false,
      problem: 'private_address',
    });
    expect(await resolvePublic(u('https://[::1]/a'))).toEqual({
      ok: false,
      problem: 'private_address',
    });
    expect(await resolvePublic(u('https://169.254.169.254/latest'))).toEqual({
      ok: false,
      problem: 'private_address',
    });
    const failing: Resolve = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await resolvePublic(u('https://nx.example/a'), failing)).toEqual({
      ok: false,
      problem: 'dns_failed',
    });
  });

  it('the real fetch refuses before connecting', async () => {
    const fetchText = safeFetchText(async () => [{ address: '10.0.0.1', family: 4 }]);
    expect(await fetchText('https://internal.example/feed.ics')).toEqual({
      ok: false,
      error: 'private_address',
    });
    expect(await safeFetchText()('http://example.com/feed.ics')).toEqual({
      ok: false,
      error: 'not_https',
    });
    expect(await safeFetchText()('https://127.0.0.1/feed.ics')).toEqual({
      ok: false,
      error: 'private_address',
    });
  });

  it('the hint shows the host and four characters, never the token', () => {
    const hint = urlHint(new URL('https://calendar.fresha.com/feeds/SECRET-TOKEN-1234.ics'));
    expect(hint).toBe('calendar.fresha.com ….ics');
    expect(hint).not.toContain('SECRET');
  });
});

describe('ICS parsing', () => {
  it('reads the fixture: zones, UTC, floating, duration, folding, escapes, cancelled', () => {
    const r = parseIcs(FIXTURE, ZONE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byUid = new Map(r.events.map((e) => [e.uid, e]));
    // All-day, no UID and end-before-start are dropped.
    expect([...byUid.keys()].sort()).toEqual([
      'cancelled-4@fixture',
      'control-7@fixture',
      'floating-3@fixture',
      'utc-2@fixture',
      'zoned-1@fixture',
    ]);
    const zoned = byUid.get('zoned-1@fixture')!;
    expect(zoned.startAt.toISOString()).toBe('2026-11-12T15:00:00.000Z'); // 10:00 EST
    expect(zoned.endAt.toISOString()).toBe('2026-11-12T16:00:00.000Z');
    expect(zoned.summary).toBe('Lan Nguyen - Gel, manicure');
    const utc = byUid.get('utc-2@fixture')!;
    expect(utc.endAt.toISOString()).toBe('2026-11-12T18:15:00.000Z');
    expect(utc.summary).toBe(
      'A very long summary that is folded onto a second line by the calendar',
    );
    const floating = byUid.get('floating-3@fixture')!;
    expect(floating.startAt.toISOString()).toBe('2026-11-12T19:00:00.000Z');
    expect(floating.summary).toBeNull();
    expect(byUid.get('cancelled-4@fixture')!.cancelled).toBe(true);
    // An unknown zone falls back to the location's; markup is kept as text.
    const control = byUid.get('control-7@fixture')!;
    expect(control.startAt.toISOString()).toBe('2026-11-12T17:00:00.000Z');
    expect(control.summary).toBe('<script>alert(1)</script>');
  });

  it('daylight time is right on both sides of the change', () => {
    expect(zonedToUtc(2026, 7, 1, 10, 0, 0, ZONE).toISOString()).toBe('2026-07-01T14:00:00.000Z');
    expect(zonedToUtc(2026, 12, 1, 10, 0, 0, ZONE).toISOString()).toBe('2026-12-01T15:00:00.000Z');
  });

  it('refuses what is not a calendar and never throws on junk', () => {
    expect(parseIcs('<html>login</html>', ZONE)).toEqual({ ok: false, error: 'not_a_calendar' });
    const junk = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:garbage\nEND:VEVENT\n', ZONE);
    expect(junk).toEqual({ ok: true, events: [] });
  });

  it('caps the number of events', () => {
    const many = Array.from(
      { length: 2001 },
      (_, i) =>
        `BEGIN:VEVENT\nUID:e${i}\nDTSTART:20261112T150000Z\nDTEND:20261112T160000Z\nEND:VEVENT`,
    ).join('\n');
    expect(parseIcs(`BEGIN:VCALENDAR\n${many}\nEND:VCALENDAR`, ZONE)).toEqual({
      ok: false,
      error: 'too_many_events',
    });
  });

  it('the dev sample parses into two open appointments and one cancelled', () => {
    const r = parseIcs(sampleIcs(NOW), ZONE);
    expect(r.ok && r.events.map((e) => e.cancelled)).toEqual([false, false, true]);
  });
});

// Database ----------------------------------------------------------------------

const sql = superuser();
let db: Db;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
let owner: StaffActor;
let techId: string;
let techUser: string;
const PUBLIC: Resolve = async () => [{ address: '93.184.216.34', family: 4 }];
const SECRET_URL = 'https://calendar.example.com/feeds/SECRET-TOKEN-abcd.ics';

beforeAll(async () => {
  await resetAndMigrate();
  await seedHeavenly(TEST_URL);
  db = createDb(TEST_URL);
  const ownerId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${ownerId}, 'authenticated', 'authenticated', ${`o-${ownerId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${ownerId}, 'Phu')`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${ownerId}, ${ORG}, ${LOC}, 'owner')`;
  owner = { userId: ownerId, role: 'owner', organizationId: ORG, locationId: LOC };
  techUser = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${techUser}, 'authenticated', 'authenticated', ${`t-${techUser.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${techUser}, 'Lan')`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${techUser}, ${ORG}, ${LOC}, 'technician')`;
  const [t] = await sql<
    { id: string }[]
  >`insert into technicians (user_id, organization_id, location_id, display_name) values (${techUser}, ${ORG}, ${LOC}, 'Lan') returning id`;
  techId = t!.id;
});

afterAll(async () => {
  await db?.$client.end();
  await sql.end();
});

const fromText =
  (text: string): FetchText =>
  async () => ({ ok: true, text });

describe('owner sets and removes a feed', () => {
  it('refuses a non-owner, a bad URL and a private host', async () => {
    const manager = { ...owner, role: 'manager' as const };
    expect(
      await setFeed(db, { actor: manager, technicianId: techId, url: SECRET_URL, resolve: PUBLIC }),
    ).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect(
      await setFeed(db, { actor: owner, technicianId: techId, url: 'http://x.example/a.ics' }),
    ).toEqual({ ok: false, reason: 'not_https' });
    expect(
      await setFeed(db, {
        actor: owner,
        technicianId: techId,
        url: 'https://inside.example/a.ics',
        resolve: async () => [{ address: '192.168.0.10', family: 4 }],
      }),
    ).toEqual({ ok: false, reason: 'private_address' });
  });

  it('keeps the URL server-side: the audit log and the screens see the hint only', async () => {
    const r = await setFeed(db, {
      actor: owner,
      technicianId: techId,
      url: SECRET_URL,
      resolve: PUBLIC,
    });
    expect(r.ok).toBe(true);
    const audit = await sql<
      { after: unknown }[]
    >`select after from audit_log where action = 'feed_set'`;
    expect(JSON.stringify(audit)).not.toContain('SECRET');
    const states = await feedStates(db, LOC);
    expect(JSON.stringify(states)).not.toContain('SECRET');
    expect(states[0]).toMatchObject({
      technicianName: 'Lan',
      urlHint: 'calendar.example.com ….ics',
    });
  });

  it('no app role can read calendar_feeds, not even the owner (T14)', async () => {
    for (const userId of [owner.userId, techUser]) {
      const err = await sql
        .begin(async (tx) => {
          await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`;
          await tx.unsafe('set local role authenticated');
          await tx`select url from calendar_feeds`;
        })
        .catch((e: { code?: string }) => e);
      expect((err as { code?: string }).code).toBe('42501');
    }
  });
});

describe('sync', () => {
  const feedId = async () => {
    const [f] = await sql<
      { id: string }[]
    >`select id from calendar_feeds where technician_id = ${techId}`;
    return f!.id;
  };

  it("adds the window's events, skips cancelled ones, records last synced", async () => {
    const r = await syncFeed(db, {
      feedId: await feedId(),
      fetchText: fromText(FIXTURE),
      now: NOW,
    });
    expect(r).toEqual({ ok: true, added: 4, changed: 0, cancelled: 0, events: 5 });
    const rows = await sql<
      { external_id: string; source: string; technician_id: string; cancelled_at: Date | null }[]
    >`select external_id, source, technician_id, cancelled_at from appointments order by start_at`;
    expect(rows).toHaveLength(4);
    expect(rows.every((x) => x.source === 'ics' && x.technician_id === techId)).toBe(true);
    const summary = await feedSummary(db, LOC, NOW);
    expect(summary.lastSyncedAt?.toISOString()).toBe(NOW.toISOString());
    expect(summary.failing).toEqual([]);
    // Times and technician in the audit log, never the client's name (T11).
    const audit = await sql`select after from audit_log where action = 'appointment_synced'`;
    expect(audit).toHaveLength(4);
    expect(JSON.stringify(audit)).not.toContain('Lan Nguyen');
  });

  it('a second poll of the same file changes nothing and writes no audit rows', async () => {
    const before = await sql`select count(*)::int as n from audit_log`;
    const r = await syncFeed(db, {
      feedId: await feedId(),
      fetchText: fromText(FIXTURE),
      now: NOW,
    });
    expect(r).toEqual({ ok: true, added: 0, changed: 0, cancelled: 0, events: 5 });
    const after = await sql`select count(*)::int as n from audit_log`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('a moved event moves, a dropped event is cancelled, an arrived one is left alone', async () => {
    // The UTC event has become a visit already.
    await sql`update appointments set arrived_at = now() where external_id like '%utc-2@fixture'`;
    const moved = FIXTURE.replace(
      'DTSTART;TZID=America/New_York:20261112T100000',
      'DTSTART;TZID=America/New_York:20261112T103000',
    )
      .replace(
        'DTEND;TZID=America/New_York:20261112T110000',
        'DTEND;TZID=America/New_York:20261112T113000',
      )
      .replace(/BEGIN:VEVENT\r?\nUID:floating-3[\s\S]*?END:VEVENT\r?\n/, '')
      .replace(/BEGIN:VEVENT\r?\nUID:utc-2[\s\S]*?END:VEVENT\r?\n/, '');
    const r = await syncFeed(db, { feedId: await feedId(), fetchText: fromText(moved), now: NOW });
    expect(r).toMatchObject({ ok: true, added: 0, changed: 1, cancelled: 1 });
    const [zoned] = await sql<
      { start_at: Date }[]
    >`select start_at from appointments where external_id like '%zoned-1@fixture'`;
    expect(zoned!.start_at.toISOString()).toBe('2026-11-12T15:30:00.000Z');
    const [floating] = await sql<
      { cancelled_at: Date | null }[]
    >`select cancelled_at from appointments where external_id like '%floating-3@fixture'`;
    expect(floating!.cancelled_at).not.toBeNull();
    const [arrived] = await sql<
      { cancelled_at: Date | null }[]
    >`select cancelled_at from appointments where external_id like '%utc-2@fixture'`;
    expect(arrived!.cancelled_at).toBeNull();
  });

  it('events outside the window are not imported', async () => {
    const far = new Date('2027-03-01T12:00:00Z');
    const r = await syncFeed(db, {
      feedId: await feedId(),
      fetchText: fromText(FIXTURE),
      now: far,
    });
    expect(r).toMatchObject({ ok: true, added: 0, events: 0 });
  });

  it('a failed poll keeps the error, writes an audit row with the hint only, and shows on the board', async () => {
    const r = await syncFeed(db, {
      feedId: await feedId(),
      fetchText: async () => ({ ok: false, error: 'http_404' }),
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(r).toEqual({ ok: false, error: 'http_404' });
    const [row] = await sql<
      { after: { error: string; urlHint: string } }[]
    >`select after from audit_log where action = 'feed_sync_failed' order by at desc limit 1`;
    expect(row!.after.error).toBe('http_404');
    expect(JSON.stringify(row)).not.toContain('SECRET');
    const summary = await feedSummary(db, LOC, NOW);
    expect(summary.failing).toEqual([
      expect.objectContaining({ technicianName: 'Lan', error: 'http_404' }),
    ]);
    // A file that is not a calendar (a login page) is a failure too.
    const html = await syncFeed(db, {
      feedId: await feedId(),
      fetchText: fromText('<html>'),
      now: NOW,
    });
    expect(html).toEqual({ ok: false, error: 'not_a_calendar' });
  });

  it('the poll waits the interval; "sync now" waits a minute', async () => {
    const t0 = new Date(NOW.getTime() + 10 * 60_000);
    // The last attempt was at NOW: ten minutes ago, inside the 15-minute interval.
    expect(await pollFeeds(db, { fetchText: fromText(FIXTURE), now: t0 })).toEqual({
      polled: 0,
      failed: 0,
    });
    expect(
      await pollFeeds(db, { locationId: LOC, force: true, fetchText: fromText(FIXTURE), now: t0 }),
    ).toEqual({ polled: 1, failed: 0 });
    expect(
      await pollFeeds(db, { locationId: LOC, force: true, fetchText: fromText(FIXTURE), now: t0 }),
    ).toEqual({ polled: 0, failed: 0 });
    const later = new Date(t0.getTime() + 16 * 60_000);
    expect(await pollFeeds(db, { fetchText: fromText(FIXTURE), now: later })).toEqual({
      polled: 1,
      failed: 0,
    });
    expect((await feedSummary(db, LOC, later)).failing).toEqual([]);
  });

  it('a stale feed is reported', async () => {
    const later = new Date(NOW.getTime() + 3 * 3_600_000);
    expect((await feedSummary(db, LOC, later)).stale).toEqual(['Lan']);
  });

  it('removing a feed blanks the URL, keeps its appointments and stops the poll', async () => {
    expect(await removeFeed(db, { actor: owner, technicianId: techId })).toEqual({ ok: true });
    const [f] = await sql<
      { url: string; archived_at: Date | null }[]
    >`select url, archived_at from calendar_feeds where technician_id = ${techId}`;
    expect(f!.url).toBe('');
    expect(f!.archived_at).not.toBeNull();
    const [n] = await sql<
      { n: number }[]
    >`select count(*)::int as n from appointments where source = 'ics'`;
    expect(n!.n).toBeGreaterThan(0);
    expect(
      await pollFeeds(db, { fetchText: fromText(FIXTURE), now: new Date(Date.now() + 86_400_000) }),
    ).toEqual({
      polled: 0,
      failed: 0,
    });
    expect(await feedStates(db, LOC)).toEqual([]);
  });
});

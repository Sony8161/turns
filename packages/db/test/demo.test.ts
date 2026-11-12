// The demo day (v0.12.0): built by the engine, and the cheat sheet in
// docs/DEMO-EXPECTED.md is exactly what the engine says. The expectations
// below are worked out by hand from Duong's rules (service 1, fill or full set
// ½, appointment -½, deny +1 unless excused, out over 60 min +1, late start
// tier, ties by check-in), so a change in the engine's numbers fails here.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildDemoDay,
  DEMO_TECH_NAMES,
  demoFeedUrl,
  demoReport,
  renderDemoExpected,
  type DemoReport,
} from '../src/demo';
import { aheadBecause, techBoard } from '../src/board';
import { isPlaceholderFeedUrl, pollFeeds } from '../src/feeds';
import { HEAVENLY, seedHeavenly } from '../src/seed';
import { createDb, type Db } from '../src/server';
import { TEST_URL, resetAndMigrate, superuser } from './helpers';

const sql = superuser();
let db: Db;
let report: DemoReport;
const ORG = HEAVENLY.organizationId;
const LOC = HEAVENLY.locationId;
const SHEET = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'DEMO-EXPECTED.md',
);

async function person(name: string, role: string): Promise<string> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, aud, role, email) values (${userId}, 'authenticated', 'authenticated', ${`${role}-${userId.slice(0, 6)}@example.test`})`;
  await sql`insert into profiles (id, display_name) values (${userId}, ${name})`;
  await sql`insert into memberships (user_id, organization_id, location_id, role) values (${userId}, ${ORG}, ${LOC}, ${role})`;
  if (role === 'technician') {
    await sql`insert into technicians (user_id, organization_id, location_id, display_name) values (${userId}, ${ORG}, ${LOC}, ${name})`;
  }
  return userId;
}

/** The demo needs an hour of today behind it: before 2 PM the clock is set to
 *  2 PM today (Date only; timers and the database clock are real). */
function atLeastTwoPm(): void {
  const tz = HEAVENLY.timezone;
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const minutes =
    (Number(parts.find((p) => p.type === 'hour')!.value) % 24) * 60 +
    Number(parts.find((p) => p.type === 'minute')!.value);
  if (minutes >= 14 * 60) return;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now.getTime() + (14 * 60 - minutes) * 60_000));
}

beforeAll(async () => {
  await resetAndMigrate();
  await seedHeavenly(TEST_URL);
  db = createDb(TEST_URL);
  const owner = await person('Phu', 'owner');
  const desk = await person('Hạnh', 'receptionist');
  for (const n of DEMO_TECH_NAMES) await person(n, 'technician');
  atLeastTwoPm();
  await buildDemoDay(db, {
    organizationId: ORG,
    locationId: LOC,
    ownerUserId: owner,
    receptionistUserId: desk,
    kioskPin: '1234',
  });
  report = await demoReport(db, LOC);
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  await db?.$client.end();
  await sql.end();
});

describe('demo day', () => {
  it('puts the board in the order the rules give', () => {
    expect(report.board.map((b) => [b.name, b.points, b.status])).toEqual([
      ['Thảo', 0.5, 'available'], // gel fill ½; the deny excused
      ['Tâm', 0.5, 'break'], // 17 min late: ½; checked in after Thảo
      ['Linh', 0.5, 'available'], // gel manicure appointment 1 - ½; last visit an appointment
      ['Vân', 1, 'available'], // out 62 min: +1; checked in first
      ['Mai', 1, 'available'], // deny, not excused: +1
      ['Hoa', 1.5, 'in_service'], // acrylic fill ½ + gel manicure 1
    ]);
    expect(report.board.find((b) => b.name === 'Linh')!.hadAppointmentLast).toBe(true);
    expect(report.board.find((b) => b.name === 'Thảo')!.lines.map((l) => l.delta)).toEqual([
      1, -1, 0.5,
    ]);
  });

  it('calls the waiting rows as the cheat sheet says', () => {
    expect(report.calls.map((c) => [c.client, c.picked])).toEqual([
      ['An Do', 'Vân'], // kid: Linh takes no kids; Vân ties Mai at 1 and checked in first
      ['Lan Nguyen', 'Linh'],
      ['Minh Tran', 'Mai'], // a man: Thảo takes no male clients
      ['Thu Pham', null], // asked for Hoa, who is with a client
      ['Ngoc Vo', null], // everyone busy or held out
      ['Bích', null], // kiosk: waits for the desk's confirm
    ]);
    const kid = report.calls[0]!.skipped.map((s) => [s.name, s.why]);
    expect(kid).toEqual([
      ['Thảo', 'appointment_soon'],
      ['Tâm', 'break'],
      ['Linh', 'no_kids'],
    ]);
    expect(report.calls[2]!.skipped[0]).toMatchObject({ name: 'Thảo', why: 'no_male_clients' });
    expect(report.calls[3]!.waitingFor).toBe('Hoa');
    expect(report.calls[5]!.needsConfirm).toBe(true);
  });

  it('has the appointment mix: arrived, soon, later, no-show, from the calendar and the desk', () => {
    expect(
      report.appointments
        .map((a) => [a.name, a.source, a.state])
        .sort((x, y) => x.join().localeCompare(y.join())),
    ).toEqual(
      [
        ['Linh', 'calendar', 'arrived'],
        ['Tâm', 'calendar', 'no_show'],
        ['Thảo', 'calendar', 'upcoming'],
        ['Mai', 'desk', 'upcoming'],
        ['Linh', 'desk', 'upcoming'],
      ].sort((x, y) => x.join().localeCompare(y.join())),
    );
  });

  it('leaves the call simulation out of the database', async () => {
    const [open] = await sql`select count(*)::int as n from turn_calls where responded_at is null`;
    expect(open!.n).toBe(0);
  });

  it('matches the committed cheat sheet exactly', () => {
    // UPDATE_DEMO_SHEET=1 rewrites it, after a deliberate change to the demo or the rules.
    if (process.env.UPDATE_DEMO_SHEET) writeFileSync(SHEET, renderDemoExpected(report), 'utf8');
    expect(readFileSync(SHEET, 'utf8')).toBe(renderDemoExpected(report));
  });

  it('shows each tech on the board with what they do, their next appointment and the chair', async () => {
    const cards = await techBoard(db, LOC);
    expect(cards.map((c) => c.displayName)).toEqual(report.board.map((b) => b.name));
    const card = (n: string) => cards.find((c) => c.displayName === n)!;
    expect(card('Hoa').currentServices).toEqual(['Spa pedicure']);
    expect(card('Hoa').status).toBe('in_service');
    expect(card('Thảo').nextAppointmentAt).not.toBeNull(); // in 20 min
    expect(card('Tâm').nextAppointmentAt).toBeNull(); // her calendar client is a no-show
    expect(card('Vân').skills).toEqual(['manicure', 'pedicure']);
    expect(card('Linh').skills).toBeNull();
    expect(card('Linh').restrictions.map((r) => r.type)).toEqual(['no_kids']);
    expect(card('Thảo').lines.map((l) => [l.kind, l.delta])).toEqual([
      ['deny', 1],
      ['excuse', -1],
      ['visit', 0.5],
    ]);
    expect(card('Vân').checkInRank).toBe(1);
    expect(aheadBecause(card('Thảo'), card('Tâm'))).toBe('earlier_check_in');
    expect(aheadBecause(card('Tâm'), card('Linh'))).toBe('appointment_last');
    expect(aheadBecause(card('Linh'), card('Vân'))).toBe('fewer_points');
  });

  it('never fetches a demo calendar link', async () => {
    expect(isPlaceholderFeedUrl(demoFeedUrl('Linh'))).toBe(true);
    expect(isPlaceholderFeedUrl('https://calendar-export.fresha.com/x.ics')).toBe(false);
    let fetched = 0;
    await pollFeeds(db, {
      locationId: LOC,
      force: true,
      fetchText: async () => {
        fetched++;
        return { ok: false, error: 'should_not_fetch' };
      },
      now: new Date(Date.now() + 3_600_000),
    });
    expect(fetched).toBe(0);
    const rows =
      await sql`select last_error, last_synced_at from calendar_feeds where location_id = ${LOC}`;
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.last_error).toBeNull();
  });
});

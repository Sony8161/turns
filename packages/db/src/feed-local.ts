// Development only: run one calendar sync from a local .ics file, so the feed
// path can be watched without a real Fresha link. The file stands in for the
// network fetch; everything after it (parse, match, upsert, cancel, the board's
// "last synced") is the real code. Refuses any database that is not local.
// Usage: DATABASE_URL=... npm run -w @turn/db feed:local -- "<technician name>" <file.ics>
//    or: ... feed:local -- "<technician name>" --sample   (three appointments around now)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { syncFeed } from './feeds';
import { calendarFeeds, technicians } from './schema';
import { createDb } from './server';

function assertLocal(url: string): void {
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`feed:local refuses a non-local database: ${host}`);
  }
}

/** Three events: one in 20 minutes, one in 2 hours, one cancelled. UIDs are
 *  per day, so running it again the same day updates instead of adding. */
export function sampleIcs(now: Date): string {
  const stamp = (d: Date) =>
    d
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
  const day = now.toISOString().slice(0, 10);
  const at = (min: number) => new Date(Math.ceil(now.getTime() / 300_000) * 300_000 + min * 60_000);
  const event = (
    uid: string,
    start: number,
    length: number,
    summary: string,
    status = 'CONFIRMED',
  ) =>
    [
      'BEGIN:VEVENT',
      `UID:${uid}-${day}@fixture.local`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(at(start))}`,
      `DTEND:${stamp(at(start + length))}`,
      `SUMMARY:${summary}`,
      `STATUS:${status}`,
      'END:VEVENT',
    ].join('\r\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//turn-system//fixture//EN',
    event('soon', 20, 45, 'Sample client - Gel manicure'),
    event('later', 120, 75, 'Sample client - Acrylic full set'),
    event('gone', 240, 30, 'Sample client - Basic pedicure', 'CANCELLED'),
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const [name, file] = process.argv.slice(2);
  if (!url || !name || !file) {
    throw new Error('usage: DATABASE_URL=... feed:local "<technician name>" <file.ics>');
  }
  assertLocal(url);
  const text =
    file === '--sample'
      ? sampleIcs(new Date())
      : readFileSync(resolve(process.cwd(), file), 'utf8');
  const db = createDb(url);
  try {
    const [tech] = await db
      .select({
        id: technicians.id,
        organizationId: technicians.organizationId,
        locationId: technicians.locationId,
      })
      .from(technicians)
      .where(and(eq(technicians.displayName, name), eq(technicians.active, true)));
    if (!tech) throw new Error(`no active technician named ${name}`);
    const [feed] = await db
      .insert(calendarFeeds)
      .values({
        organizationId: tech.organizationId,
        locationId: tech.locationId,
        technicianId: tech.id,
        url: 'https://fixture.local/calendar.ics',
        urlHint: 'fixture.local …r.ics',
      })
      .onConflictDoUpdate({
        target: calendarFeeds.technicianId,
        set: {
          archivedAt: null,
          url: 'https://fixture.local/calendar.ics',
          urlHint: 'fixture.local …r.ics',
        },
      })
      .returning({ id: calendarFeeds.id });
    const r = await syncFeed(db, {
      feedId: feed!.id,
      fetchText: async () => ({ ok: true, text }),
    });
    console.log(r);
  } finally {
    await db.$client.end();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

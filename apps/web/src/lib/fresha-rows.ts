import 'server-only';
// Rows for the Connect Fresha screens (v0.11.0): every active technician at
// the location with their calendar's state. The state carries times and an
// error name, never the link or its hint (T14).
import { technicians } from '@turn/db';
import { feedStates } from '@turn/db/feeds';
import { feedStateFor, type OwnFeedState } from '@turn/db/fresha';
import { and, asc, eq } from 'drizzle-orm';
import type { FreshaRowItem, FreshaRowState } from '@/components/fresha-state';
import type { Dictionary, Lang } from '@/i18n/dictionary';
import { db } from './db';

type Feedish = Pick<OwnFeedState, 'lastSyncedAt' | 'lastError' | 'stale' | 'pending'>;

function stateOf(f: Feedish | null, t: Dictionary, format: (d: Date) => string): FreshaRowState {
  if (!f) return { kind: 'none' };
  // v0.17.1: her own link waits for the owner or a manager; nothing is fetched.
  if (f.pending) return { kind: 'pending' };
  if (f.lastError) {
    return {
      kind: 'failing',
      error: t.fresha.errors[f.lastError] ?? t.appointments.feedErrors[f.lastError] ?? f.lastError,
    };
  }
  if (!f.lastSyncedAt) return { kind: 'never' };
  return { kind: f.stale ? 'stale' : 'ok', time: format(f.lastSyncedAt) };
}

function formatter(lang: Lang, timezone: string) {
  const f = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  return (d: Date) => f.format(d);
}

/** The owner's rows: every active technician at the location. */
export async function ownerRows(
  locationId: string,
  t: Dictionary,
  lang: Lang,
  timezone: string,
): Promise<FreshaRowItem[]> {
  const now = new Date();
  const [techs, feeds] = await Promise.all([
    db()
      .select({ id: technicians.id, name: technicians.displayName })
      .from(technicians)
      .where(and(eq(technicians.locationId, locationId), eq(technicians.active, true)))
      .orderBy(asc(technicians.displayName)),
    feedStates(db(), locationId, now),
  ]);
  const byTech = new Map(feeds.map((f) => [f.technicianId, f]));
  const format = formatter(lang, timezone);
  return techs.map((x) => ({
    id: x.id,
    name: x.name,
    state: stateOf(byTech.get(x.id) ?? null, t, format),
  }));
}

/** A technician's own row. */
export async function selfRow(
  technicianId: string,
  name: string,
  t: Dictionary,
  lang: Lang,
  timezone: string,
): Promise<FreshaRowItem> {
  const f = await feedStateFor(db(), technicianId);
  return {
    id: technicianId,
    name,
    state: stateOf(f.connected ? f : null, t, formatter(lang, timezone)),
  };
}

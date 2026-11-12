// v0.16.0 (Duong, 2026-11-12): "Need help". A technician taps it on her phone,
// with an optional short reason; the desk board (owner, manager,
// receptionist) shows "Mai needs help" and how long she has waited, until
// someone acknowledges it. One open request per technician (a second tap is
// the same request), rate limited, audited (whether there is a reason, never
// its text: T11). No phone push: the board's own refresh shows it. Server only.
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { ManagerActor } from './engine';
import { consumeRateLimit } from './rate-limit';
import { helpRequests, technicians } from './schema';
import type { Db } from './server';
import { writeAudit, type Actor } from './status';

export const HELP_REASON_MAX = 80;
/** Taps per technician per hour, counted before the "already open" check. */
export const HELP_PER_HOUR = 6;

export function cleanHelpReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, HELP_REASON_MAX)
      .trim() || null
  );
}

export type HelpRequest = {
  id: string;
  technicianId: string;
  technician: string;
  reason: string | null;
  createdAt: Date;
};

/** The technician asks for help. Returns the open request (new or the one already waiting). */
export async function askForHelp(
  db: Db,
  input: { technicianId: string; actor: Actor; reason?: unknown },
): Promise<
  | { ok: true; id: string; alreadyOpen: boolean }
  | { ok: false; reason: 'unknown_technician' | 'too_many' }
> {
  const limit = await consumeRateLimit(db, `help:tech:${input.technicianId}`, HELP_PER_HOUR, 3600);
  if (!limit.allowed) return { ok: false, reason: 'too_many' };
  const reason = cleanHelpReason(input.reason);
  return db.transaction(async (tx) => {
    const [tech] = await tx
      .select({
        id: technicians.id,
        organizationId: technicians.organizationId,
        locationId: technicians.locationId,
      })
      .from(technicians)
      .where(and(eq(technicians.id, input.technicianId), eq(technicians.active, true)));
    if (!tech) return { ok: false as const, reason: 'unknown_technician' as const };
    const [open] = await tx
      .select({ id: helpRequests.id })
      .from(helpRequests)
      .where(and(eq(helpRequests.technicianId, tech.id), isNull(helpRequests.acknowledgedAt)));
    if (open) return { ok: true as const, id: open.id, alreadyOpen: true };
    const [row] = await tx
      .insert(helpRequests)
      .values({
        organizationId: tech.organizationId,
        locationId: tech.locationId,
        technicianId: tech.id,
        reason,
      })
      // Two taps at the same second: the one-open index keeps one.
      .onConflictDoNothing()
      .returning({ id: helpRequests.id });
    if (!row) {
      const [again] = await tx
        .select({ id: helpRequests.id })
        .from(helpRequests)
        .where(and(eq(helpRequests.technicianId, tech.id), isNull(helpRequests.acknowledgedAt)));
      return { ok: true as const, id: again!.id, alreadyOpen: true };
    }
    await writeAudit(tx, {
      organizationId: tech.organizationId,
      locationId: tech.locationId,
      actorUserId: input.actor.userId,
      entityType: 'help_requests',
      entityId: row.id,
      action: 'help_requested',
      after: { technicianId: tech.id, hasReason: reason !== null },
    });
    return { ok: true as const, id: row.id, alreadyOpen: false };
  });
}

/** Requests nobody has acknowledged yet, oldest first: the desk board's strip. */
export async function openHelpRequests(db: Db, locationId: string): Promise<HelpRequest[]> {
  return db
    .select({
      id: helpRequests.id,
      technicianId: helpRequests.technicianId,
      technician: technicians.displayName,
      reason: helpRequests.reason,
      createdAt: helpRequests.createdAt,
    })
    .from(helpRequests)
    .innerJoin(technicians, eq(technicians.id, helpRequests.technicianId))
    .where(and(eq(helpRequests.locationId, locationId), isNull(helpRequests.acknowledgedAt)))
    .orderBy(asc(helpRequests.createdAt));
}

/** The technician's own open request, for her phone ("Help is on the way"). */
export async function myOpenHelp(
  db: Db,
  technicianId: string,
): Promise<{ id: string; createdAt: Date } | null> {
  const [row] = await db
    .select({ id: helpRequests.id, createdAt: helpRequests.createdAt })
    .from(helpRequests)
    .where(and(eq(helpRequests.technicianId, technicianId), isNull(helpRequests.acknowledgedAt)));
  return row ?? null;
}

/** Someone at the desk is on it. Same location only (threat model T10). */
export async function acknowledgeHelp(
  db: Db,
  input: { actor: ManagerActor; id: string; now?: Date },
): Promise<{ ok: true } | { ok: false; reason: 'unknown_request' | 'already_acknowledged' }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(helpRequests)
      .where(
        and(
          eq(helpRequests.id, input.id),
          eq(helpRequests.locationId, input.actor.locationId),
          eq(helpRequests.organizationId, input.actor.organizationId),
        ),
      )
      .for('update');
    if (!row) return { ok: false as const, reason: 'unknown_request' as const };
    if (row.acknowledgedAt) return { ok: false as const, reason: 'already_acknowledged' as const };
    await tx
      .update(helpRequests)
      .set({ acknowledgedAt: now, acknowledgedBy: input.actor.userId })
      .where(eq(helpRequests.id, row.id));
    await writeAudit(tx, {
      organizationId: row.organizationId,
      locationId: row.locationId,
      actorUserId: input.actor.userId,
      entityType: 'help_requests',
      entityId: row.id,
      action: 'help_acknowledged',
      after: {
        technicianId: row.technicianId,
        waitedSeconds: Math.max(0, Math.round((now.getTime() - row.createdAt.getTime()) / 1000)),
      },
    });
    return { ok: true as const };
  });
}

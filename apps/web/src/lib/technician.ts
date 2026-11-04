import 'server-only';
// The technician row the signed-in user may act as: active row, active
// technician membership at the same location (threat model T10). With more
// than one location the oldest wins until Part 4 adds an explicit choice.
import { and, asc, eq } from 'drizzle-orm';
import { memberships, technicians } from '@turn/db';
import { db } from './db';

export async function technicianForUser(userId: string) {
  const [row] = await db()
    .select({
      id: technicians.id,
      organizationId: technicians.organizationId,
      locationId: technicians.locationId,
    })
    .from(technicians)
    .innerJoin(
      memberships,
      and(
        eq(memberships.userId, technicians.userId),
        eq(memberships.locationId, technicians.locationId),
        eq(memberships.role, 'technician'),
        eq(memberships.active, true),
      ),
    )
    .where(and(eq(technicians.userId, userId), eq(technicians.active, true)))
    .orderBy(asc(technicians.createdAt))
    .limit(1);
  return row ?? null;
}

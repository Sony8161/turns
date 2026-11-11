// A salon's second (and later) location (Part 7). Server only; today the
// operator runs it from the command line. The new location gets the starting
// menu and rules version 1, like a new salon, and every owner of the salon
// becomes owner there too, so they can switch to it. Staff join it by invite.
// Usage: DATABASE_URL=... npm run -w @turn/db db:add-location -- <organization id> "<name>"
import { and, eq } from 'drizzle-orm';
import { locations, memberships, ruleConfigs, serviceCategories, services } from './schema';
import { HEAVENLY_CATEGORIES, HEAVENLY_RULE_CONFIG_V1, HEAVENLY_SERVICES } from './seed';
import { createDb, type Db } from './server';
import { writeAudit } from './status';

export async function addLocation(
  db: Db,
  input: {
    organizationId: string;
    name: string;
    /** A fixed id makes it safe to run twice (the dev seed). */
    id?: string;
    timezone?: string;
    actorUserId?: string | null;
  },
): Promise<{ ok: true; locationId: string; created: boolean } | { ok: false; reason: string }> {
  const name = input.name.trim().slice(0, 120);
  if (!name) return { ok: false, reason: 'name_required' };
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.organizationId, input.organizationId), eq(locations.name, name)));
    if (existing) return { ok: true, locationId: existing.id, created: false };
    const [loc] = await tx
      .insert(locations)
      .values({
        ...(input.id ? { id: input.id } : {}),
        organizationId: input.organizationId,
        name,
        timezone: input.timezone ?? 'America/New_York',
      })
      .returning({ id: locations.id });
    if (!loc) throw new Error('location insert returned nothing');
    const cats = await tx
      .insert(serviceCategories)
      .values(
        HEAVENLY_CATEGORIES.map((c) => ({
          organizationId: input.organizationId,
          locationId: loc.id,
          name: c.name,
          basePoints: c.basePoints,
          isFillOrFullSet: c.isFillOrFullSet,
        })),
      )
      .returning({ id: serviceCategories.id, name: serviceCategories.name });
    const byName = new Map(cats.map((c) => [c.name, c.id]));
    await tx.insert(services).values(
      HEAVENLY_SERVICES.map((s) => ({
        organizationId: input.organizationId,
        locationId: loc.id,
        categoryId: byName.get(s.category)!,
        name: s.name,
        defaultDurationMin: s.minutes,
      })),
    );
    await tx.insert(ruleConfigs).values({
      organizationId: input.organizationId,
      locationId: loc.id,
      version: 1,
      config: HEAVENLY_RULE_CONFIG_V1,
    });
    const owners = await tx
      .selectDistinct({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, input.organizationId),
          eq(memberships.role, 'owner'),
          eq(memberships.active, true),
        ),
      );
    if (owners.length) {
      await tx
        .insert(memberships)
        .values(
          owners.map((o) => ({
            userId: o.userId,
            organizationId: input.organizationId,
            locationId: loc.id,
            role: 'owner' as const,
          })),
        )
        .onConflictDoNothing();
    }
    await writeAudit(tx, {
      organizationId: input.organizationId,
      locationId: loc.id,
      actorUserId: input.actorUserId ?? null,
      entityType: 'locations',
      entityId: loc.id,
      action: 'location_created',
      after: { name, owners: owners.length },
    });
    return { ok: true, locationId: loc.id, created: true };
  });
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  const [organizationId, name] = process.argv.slice(2);
  if (!url || !organizationId || !name) {
    console.error('usage: DATABASE_URL=... db:add-location <organization id> "<location name>"');
    process.exit(1);
  }
  const db = createDb(url);
  addLocation(db, { organizationId, name })
    .then((r) => console.log(r))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.$client.end());
}

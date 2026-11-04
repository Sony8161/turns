// Salon setup codes: how a new salon comes into being. The platform operator
// generates a code (db:setup-code); the person who redeems it after signing in
// becomes the owner of a new organization with one location, the default
// service categories and rule config version 1. Server only.
import { eq } from 'drizzle-orm';
import { generateCode, hashCode } from './invites';
import {
  locations,
  memberships,
  organizations,
  profiles,
  ruleConfigs,
  serviceCategories,
  services,
  setupCodes,
} from './schema';
import { HEAVENLY_CATEGORIES, HEAVENLY_RULE_CONFIG_V1, HEAVENLY_SERVICES } from './seed';
import type { Db } from './server';
import { writeAudit } from './status';

export const SETUP_CODE_TTL_HOURS = 24 * 14;

export async function createSetupCode(
  db: Db,
  input: { note?: string; ttlHours?: number } = {},
): Promise<{ id: string; code: string; expiresAt: Date }> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + (input.ttlHours ?? SETUP_CODE_TTL_HOURS) * 3_600_000);
  const [row] = await db
    .insert(setupCodes)
    .values({ codeHash: hashCode(code), note: input.note, expiresAt })
    .returning({ id: setupCodes.id });
  if (!row) throw new Error('setup code insert returned nothing');
  return { id: row.id, code, expiresAt };
}

export type SetupResult =
  | { ok: true; organizationId: string; locationId: string }
  | { ok: false; reason: 'unknown' | 'used' | 'expired' };

export async function redeemSetupCode(
  db: Db,
  input: {
    code: string;
    userId: string;
    displayName: string;
    salonName: string;
    locationName: string;
    email?: string;
    phone?: string;
  },
): Promise<SetupResult> {
  return db.transaction(async (tx) => {
    const [setup] = await tx
      .select({ id: setupCodes.id, expiresAt: setupCodes.expiresAt, usedAt: setupCodes.usedAt })
      .from(setupCodes)
      .where(eq(setupCodes.codeHash, hashCode(input.code)))
      .for('update');
    if (!setup) return { ok: false, reason: 'unknown' };
    if (setup.usedAt) return { ok: false, reason: 'used' };
    if (setup.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };

    const [org] = await tx
      .insert(organizations)
      .values({ name: input.salonName })
      .returning({ id: organizations.id });
    if (!org) throw new Error('organization insert returned nothing');
    const [loc] = await tx
      .insert(locations)
      .values({ organizationId: org.id, name: input.locationName })
      .returning({ id: locations.id });
    if (!loc) throw new Error('location insert returned nothing');

    await tx
      .insert(profiles)
      .values({
        id: input.userId,
        displayName: input.displayName,
        email: input.email,
        phone: input.phone,
      })
      .onConflictDoNothing();
    await tx.insert(memberships).values({
      userId: input.userId,
      organizationId: org.id,
      locationId: loc.id,
      role: 'owner',
    });
    // Same starting rules and menu as Heavenly; the owner edits them later.
    const cats = await tx
      .insert(serviceCategories)
      .values(
        HEAVENLY_CATEGORIES.map((c) => ({
          organizationId: org.id,
          locationId: loc.id,
          name: c.name,
          basePoints: c.basePoints,
          isFillOrFullSet: c.isFillOrFullSet,
        })),
      )
      .returning({ id: serviceCategories.id, name: serviceCategories.name });
    const categoryByName = new Map(cats.map((c) => [c.name, c.id]));
    await tx.insert(services).values(
      HEAVENLY_SERVICES.map((s) => ({
        organizationId: org.id,
        locationId: loc.id,
        categoryId: categoryByName.get(s.category)!,
        name: s.name,
        defaultDurationMin: s.minutes,
      })),
    );
    await tx.insert(ruleConfigs).values({
      organizationId: org.id,
      locationId: loc.id,
      version: 1,
      config: HEAVENLY_RULE_CONFIG_V1,
    });
    await tx
      .update(setupCodes)
      .set({ usedBy: input.userId, usedAt: new Date(), organizationId: org.id })
      .where(eq(setupCodes.id, setup.id));
    await writeAudit(tx, {
      organizationId: org.id,
      locationId: loc.id,
      actorUserId: input.userId,
      entityType: 'organizations',
      entityId: org.id,
      action: 'salon_created',
      after: {
        salonName: input.salonName,
        locationName: input.locationName,
        setupCodeId: setup.id,
      },
    });

    return { ok: true, organizationId: org.id, locationId: loc.id };
  });
}

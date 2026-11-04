// Invite codes: how staff join a salon (design doc, Authentication; threat
// model T9). Server-only: runs with the service-role connection, so the
// callers (web server actions) must check that the actor may invite this role
// at this location before calling createInvite.
import { createHash, randomInt } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { inviteCodes, locations, memberships, profiles, technicians } from './schema';
import type { Db } from './server';

export type Role = 'owner' | 'manager' | 'receptionist' | 'technician';

// No 0/O or 1/I, so a code read out loud or typed on an iPad is unambiguous.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
export const DEFAULT_TTL_HOURS = 72;

export function generateCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Case- and punctuation-insensitive, so "abcde-fghjk" and "ABCDEFGHJK" match. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashCode(code: string): string {
  return createHash('sha256').update(normalizeCode(code)).digest('hex');
}

export async function createInvite(
  db: Db,
  input: {
    organizationId: string;
    locationId: string;
    role: Role;
    createdBy: string;
    ttlHours?: number;
  },
): Promise<{ id: string; code: string; expiresAt: Date }> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + (input.ttlHours ?? DEFAULT_TTL_HOURS) * 3_600_000);
  const [row] = await db
    .insert(inviteCodes)
    .values({
      organizationId: input.organizationId,
      locationId: input.locationId,
      role: input.role,
      codeHash: hashCode(code),
      createdBy: input.createdBy,
      expiresAt,
    })
    .returning({ id: inviteCodes.id });
  if (!row) throw new Error('invite insert returned nothing');
  return { id: row.id, code, expiresAt };
}

export type RedeemResult =
  | { ok: true; organizationId: string; locationId: string; locationName: string; role: Role }
  | { ok: false; reason: 'unknown' | 'used' | 'expired' };

/**
 * Redeems a code for an authenticated user: creates the profile if missing,
 * the membership, and a technician row for the technician role. Single use:
 * the row is locked for the transaction, so two redemptions cannot both win.
 */
export async function redeemInvite(
  db: Db,
  input: { code: string; userId: string; displayName: string; email?: string; phone?: string },
): Promise<RedeemResult> {
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select({
        id: inviteCodes.id,
        organizationId: inviteCodes.organizationId,
        locationId: inviteCodes.locationId,
        role: inviteCodes.role,
        expiresAt: inviteCodes.expiresAt,
        usedAt: inviteCodes.usedAt,
        locationName: locations.name,
      })
      .from(inviteCodes)
      .innerJoin(
        locations,
        and(
          eq(locations.id, inviteCodes.locationId),
          eq(locations.organizationId, inviteCodes.organizationId),
        ),
      )
      .where(eq(inviteCodes.codeHash, hashCode(input.code)))
      .for('update', { of: inviteCodes });
    if (!invite) return { ok: false, reason: 'unknown' };
    if (invite.usedAt) return { ok: false, reason: 'used' };
    if (invite.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };

    await tx
      .insert(profiles)
      .values({
        id: input.userId,
        displayName: input.displayName,
        email: input.email,
        phone: input.phone,
      })
      .onConflictDoNothing();
    await tx
      .insert(memberships)
      .values({
        userId: input.userId,
        organizationId: invite.organizationId,
        locationId: invite.locationId,
        role: invite.role,
      })
      .onConflictDoNothing();
    if (invite.role === 'technician') {
      await tx
        .insert(technicians)
        .values({
          userId: input.userId,
          organizationId: invite.organizationId,
          locationId: invite.locationId,
          displayName: input.displayName,
        })
        .onConflictDoNothing();
    }
    await tx
      .update(inviteCodes)
      .set({ usedBy: input.userId, usedAt: new Date() })
      .where(eq(inviteCodes.id, invite.id));

    return {
      ok: true,
      organizationId: invite.organizationId,
      locationId: invite.locationId,
      locationName: invite.locationName,
      role: invite.role,
    };
  });
}

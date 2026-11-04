// Staff management (Part 5; design doc, Roles and permissions; Duong,
// 2026-11-04): owner-made invite codes, role changes (the only way a role
// changes), archive and restore. Nothing is deleted. Server only: the caller
// has verified the session; this module checks the actor's own role and
// location against the target (threat model T10) and writes the audit log.
import { and, asc, eq } from 'drizzle-orm';
import { createInvite, type Role } from './invites';
import { memberships, profiles, technicianStatus, technicians } from './schema';
import type { Db } from './server';
import { writeAudit } from './status';

/** The signed-in person, at the location they are acting for. */
export type StaffActor = {
  userId: string;
  role: Role;
  organizationId: string;
  locationId: string;
};

export type StaffRow = {
  membershipId: string;
  userId: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  role: Role;
  active: boolean;
  technicianId: string | null;
  technicianStatus: string | null;
  joinedAt: Date;
};

export type StaffError =
  | 'not_allowed'
  | 'wrong_location'
  | 'unknown_member'
  | 'own_membership'
  | 'already_has_role'
  | 'on_shift'
  | 'archived'
  | 'reason_required';

/** Who may set which role (design doc): owners anyone; managers managers and below. */
export function canSetRole(actor: Role, from: Role, to: Role): boolean {
  if (actor === 'owner') return true;
  if (actor === 'manager') return from !== 'owner' && to !== 'owner';
  return false;
}

/** Everyone at the location, active first, then by name. Archived rows included
 *  so an owner or manager can restore them (they see archived; nobody deletes). */
export async function listStaff(db: Db, locationId: string): Promise<StaffRow[]> {
  const rows = await db
    .select({
      membershipId: memberships.id,
      userId: memberships.userId,
      displayName: profiles.displayName,
      email: profiles.email,
      phone: profiles.phone,
      role: memberships.role,
      active: memberships.active,
      technicianId: technicians.id,
      technicianStatus: technicianStatus.status,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(profiles, eq(profiles.id, memberships.userId))
    .leftJoin(
      technicians,
      and(
        eq(technicians.userId, memberships.userId),
        eq(technicians.locationId, memberships.locationId),
      ),
    )
    .leftJoin(technicianStatus, eq(technicianStatus.technicianId, technicians.id))
    .where(eq(memberships.locationId, locationId))
    .orderBy(asc(memberships.createdAt));
  return rows
    .map((r) => ({ ...r, technicianStatus: r.technicianStatus ?? null }))
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        a.displayName.localeCompare(b.displayName) ||
        a.joinedAt.getTime() - b.joinedAt.getTime(),
    );
}

/** A staff invite made from the admin screen. Managers cannot mint owners. */
export async function makeInvite(
  db: Db,
  input: { actor: StaffActor; role: Role },
): Promise<{ ok: true; code: string; expiresAt: Date } | { ok: false; reason: StaffError }> {
  if (!canSetRole(input.actor.role, input.role, input.role)) {
    return { ok: false, reason: 'not_allowed' };
  }
  return db.transaction(async (tx) => {
    const invite = await createInvite(tx as unknown as Db, {
      organizationId: input.actor.organizationId,
      locationId: input.actor.locationId,
      role: input.role,
      createdBy: input.actor.userId,
    });
    await writeAudit(tx, {
      organizationId: input.actor.organizationId,
      locationId: input.actor.locationId,
      actorUserId: input.actor.userId,
      entityType: 'invite_codes',
      entityId: invite.id,
      action: 'invite_created',
      after: { role: input.role, expiresAt: invite.expiresAt },
    });
    return { ok: true, code: invite.code, expiresAt: invite.expiresAt };
  });
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

type MembershipRow = typeof memberships.$inferSelect;
type Target = { ok: true; membership: MembershipRow } | { ok: false; reason: StaffError };

/** The target membership, locked, only if it is at the actor's own location. */
async function targetOf(tx: Tx, actor: StaffActor, membershipId: string): Promise<Target> {
  const [m] = await tx
    .select()
    .from(memberships)
    .where(eq(memberships.id, membershipId))
    .for('update');
  if (!m) return { ok: false, reason: 'unknown_member' };
  if (m.organizationId !== actor.organizationId || m.locationId !== actor.locationId) {
    return { ok: false, reason: 'wrong_location' };
  }
  if (m.userId === actor.userId) return { ok: false, reason: 'own_membership' };
  return { ok: true, membership: m };
}

/** Is this person's technician row on shift (anything but off)? Locks the
 *  technicians row the way checkIn does, so a check-in saved at the same
 *  second waits for this change instead of slipping in between. */
async function onShift(tx: Tx, userId: string, locationId: string): Promise<boolean> {
  const [row] = await tx
    .select({ status: technicianStatus.status })
    .from(technicians)
    .leftJoin(technicianStatus, eq(technicianStatus.technicianId, technicians.id))
    .where(and(eq(technicians.userId, userId), eq(technicians.locationId, locationId)))
    .for('update', { of: technicians });
  return !!row?.status && row.status !== 'off';
}

/**
 * Changes one membership's role. A technician who stops being a technician
 * keeps their technician row (turn history anchors to it) but it goes
 * inactive; someone who becomes a technician gets a row, or theirs back.
 */
export async function changeRole(
  db: Db,
  input: { actor: StaffActor; membershipId: string; toRole: Role; reason?: string | null },
): Promise<{ ok: true } | { ok: false; reason: StaffError }> {
  return db.transaction(async (tx) => {
    const t = await targetOf(tx, input.actor, input.membershipId);
    if (!t.ok) return t;
    const m = t.membership;
    if (!m.active) return { ok: false, reason: 'archived' };
    if (m.role === input.toRole) return { ok: true };
    if (!canSetRole(input.actor.role, m.role, input.toRole)) {
      return { ok: false, reason: 'not_allowed' };
    }
    if (m.role === 'technician' && (await onShift(tx, m.userId, m.locationId))) {
      return { ok: false, reason: 'on_shift' };
    }
    const [clash] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, m.userId),
          eq(memberships.locationId, m.locationId),
          eq(memberships.role, input.toRole),
        ),
      );
    if (clash) return { ok: false, reason: 'already_has_role' };

    const now = new Date();
    await tx
      .update(memberships)
      .set({ role: input.toRole, updatedAt: now })
      .where(eq(memberships.id, m.id));
    if (m.role === 'technician') {
      await tx
        .update(technicians)
        .set({ active: false, updatedAt: now })
        .where(and(eq(technicians.userId, m.userId), eq(technicians.locationId, m.locationId)));
    }
    if (input.toRole === 'technician') {
      const [profile] = await tx
        .select({ displayName: profiles.displayName })
        .from(profiles)
        .where(eq(profiles.id, m.userId));
      await tx
        .insert(technicians)
        .values({
          userId: m.userId,
          organizationId: m.organizationId,
          locationId: m.locationId,
          displayName: profile?.displayName ?? '',
        })
        .onConflictDoUpdate({
          target: [technicians.userId, technicians.locationId],
          set: { active: true, updatedAt: now },
        });
    }
    await writeAudit(tx, {
      organizationId: m.organizationId,
      locationId: m.locationId,
      actorUserId: input.actor.userId,
      entityType: 'memberships',
      entityId: m.id,
      action: 'role_changed',
      before: { userId: m.userId, role: m.role },
      after: { userId: m.userId, role: input.toRole },
      reason: input.reason?.trim().slice(0, 300) || null,
    });
    return { ok: true };
  });
}

/** Archive: the membership goes inactive (every request checks that), the
 *  technician row too. History stays. A reason is required (audit). */
export async function archiveMember(
  db: Db,
  input: { actor: StaffActor; membershipId: string; reason: string },
): Promise<{ ok: true } | { ok: false; reason: StaffError }> {
  if (!input.reason.trim()) return { ok: false, reason: 'reason_required' };
  return db.transaction(async (tx) => {
    const t = await targetOf(tx, input.actor, input.membershipId);
    if (!t.ok) return t;
    const m = t.membership;
    if (!canSetRole(input.actor.role, m.role, m.role)) return { ok: false, reason: 'not_allowed' };
    if (!m.active) return { ok: true };
    if (m.role === 'technician' && (await onShift(tx, m.userId, m.locationId))) {
      return { ok: false, reason: 'on_shift' };
    }
    const now = new Date();
    await tx
      .update(memberships)
      .set({ active: false, updatedAt: now })
      .where(eq(memberships.id, m.id));
    if (m.role === 'technician') {
      await tx
        .update(technicians)
        .set({ active: false, updatedAt: now })
        .where(and(eq(technicians.userId, m.userId), eq(technicians.locationId, m.locationId)));
    }
    await writeAudit(tx, {
      organizationId: m.organizationId,
      locationId: m.locationId,
      actorUserId: input.actor.userId,
      entityType: 'memberships',
      entityId: m.id,
      action: 'member_archived',
      before: { userId: m.userId, role: m.role, active: true },
      after: { userId: m.userId, role: m.role, active: false },
      reason: input.reason.trim().slice(0, 300),
    });
    return { ok: true };
  });
}

/** Restore an archived membership (and the technician row, for a technician). */
export async function restoreMember(
  db: Db,
  input: { actor: StaffActor; membershipId: string },
): Promise<{ ok: true } | { ok: false; reason: StaffError }> {
  return db.transaction(async (tx) => {
    const t = await targetOf(tx, input.actor, input.membershipId);
    if (!t.ok) return t;
    const m = t.membership;
    if (!canSetRole(input.actor.role, m.role, m.role)) return { ok: false, reason: 'not_allowed' };
    if (m.active) return { ok: true };
    const now = new Date();
    await tx
      .update(memberships)
      .set({ active: true, updatedAt: now })
      .where(eq(memberships.id, m.id));
    if (m.role === 'technician') {
      await tx
        .update(technicians)
        .set({ active: true, updatedAt: now })
        .where(and(eq(technicians.userId, m.userId), eq(technicians.locationId, m.locationId)));
    }
    await writeAudit(tx, {
      organizationId: m.organizationId,
      locationId: m.locationId,
      actorUserId: input.actor.userId,
      entityType: 'memberships',
      entityId: m.id,
      action: 'member_restored',
      before: { userId: m.userId, role: m.role, active: false },
      after: { userId: m.userId, role: m.role, active: true },
    });
    return { ok: true };
  });
}

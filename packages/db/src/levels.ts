// Skill levels (v0.14.0, Duong 2026-11-12). A ladder: regular polish < gel <
// dip < acrylic. A technician has one level, set by an owner or a manager
// (never a receptionist, never the technician). The level ticks every service
// at or below it; the owner or manager then ticks and unticks single services
// (some technicians do a gel pedicure but not a gel manicure). Those ticks,
// technician_services, are what the engine reads.
//
// A service names the levels that get it by turn (services.turn_levels; null =
// every level). A regular manicure goes to regular and gel technicians: an
// acrylic technician keeps her place and is only asked by the desk. A service
// with desk_picks is never called by turn: the desk picks the technician.
import { and, asc, eq, isNull } from 'drizzle-orm';
import { can } from './permissions';
import { services, technicianServices, technicianSkills, technicians } from './schema';
import type { Db } from './server';
import type { StaffActor } from './staff';
import { writeAudit } from './status';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Lowest first: the order is the ladder. */
export const SKILL_LEVELS = ['regular', 'gel', 'dip', 'acrylic'] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

export function isSkillLevel(v: unknown): v is SkillLevel {
  return typeof v === 'string' && (SKILL_LEVELS as readonly string[]).includes(v);
}

export function levelRank(level: SkillLevel): number {
  return SKILL_LEVELS.indexOf(level);
}

/** Does a technician at `level` reach a service whose lowest level is `min`? */
export function reaches(level: SkillLevel, min: SkillLevel): boolean {
  return levelRank(level) >= levelRank(min);
}

/** Is this service theirs by turn? null turn levels = every level. Pure. */
export function byTurn(level: SkillLevel, turnLevels: readonly SkillLevel[] | null): boolean {
  return turnLevels === null || turnLevels.includes(level);
}

export type TechnicianLevel = { level: SkillLevel; serviceIds: Set<string> };

/** Every technician with a level at a location, and the services ticked for them. */
export async function loadLevels(
  db: Db | Tx,
  locationId: string,
): Promise<Map<string, TechnicianLevel>> {
  const [techs, rows] = await Promise.all([
    db
      .select({ id: technicians.id, level: technicians.skillLevel })
      .from(technicians)
      .where(eq(technicians.locationId, locationId)),
    db
      .select({
        technicianId: technicianServices.technicianId,
        serviceId: technicianServices.serviceId,
      })
      .from(technicianServices)
      .where(eq(technicianServices.locationId, locationId)),
  ]);
  const out = new Map<string, TechnicianLevel>();
  for (const t of techs) if (t.level) out.set(t.id, { level: t.level, serviceIds: new Set() });
  for (const r of rows) out.get(r.technicianId)?.serviceIds.add(r.serviceId);
  return out;
}

export type ServiceLevels = {
  id: string;
  name: string;
  minLevel: SkillLevel;
  /** null = every level gets it by turn. */
  turnLevels: SkillLevel[] | null;
  deskPicks: boolean;
};

/** The open menu with each service's level settings, by name. */
export async function menuLevels(db: Db | Tx, locationId: string): Promise<ServiceLevels[]> {
  return db
    .select({
      id: services.id,
      name: services.name,
      minLevel: services.minLevel,
      turnLevels: services.turnLevels,
      deskPicks: services.deskPicks,
    })
    .from(services)
    .where(and(eq(services.locationId, locationId), isNull(services.archivedAt)))
    .orderBy(asc(services.name));
}

export type LevelError =
  | 'not_allowed'
  | 'wrong_location'
  | 'unknown_technician'
  | 'unknown_service'
  | 'bad_level'
  | 'no_services'
  | 'no_levels';

// v0.17.1: the shared permissions table (owners and managers).
const mayManage = (actor: StaffActor) => can(actor.role, 'manage_levels');

/**
 * Sets a technician's level and the services ticked for them. `serviceIds`
 * null = tick everything at or below the level (the pre-fill). `level` null
 * clears the level and the ticks: the technician is back on the Part 6
 * category skills. Owners and managers only, at their own location; audited
 * with before and after.
 */
export async function setTechnicianLevel(
  db: Db,
  input: {
    actor: StaffActor;
    technicianId: string;
    level: SkillLevel | null;
    serviceIds?: string[] | null;
  },
): Promise<{ ok: true; serviceIds: string[] } | { ok: false; reason: LevelError }> {
  if (!mayManage(input.actor)) return { ok: false, reason: 'not_allowed' };
  if (input.level !== null && !isSkillLevel(input.level)) return { ok: false, reason: 'bad_level' };
  return db.transaction(async (tx) => {
    const [tech] = await tx
      .select({
        id: technicians.id,
        organizationId: technicians.organizationId,
        locationId: technicians.locationId,
        level: technicians.skillLevel,
      })
      .from(technicians)
      .where(eq(technicians.id, input.technicianId))
      .for('update');
    if (!tech) return { ok: false as const, reason: 'unknown_technician' as const };
    if (
      tech.organizationId !== input.actor.organizationId ||
      tech.locationId !== input.actor.locationId
    ) {
      return { ok: false as const, reason: 'wrong_location' as const };
    }
    const menu = await menuLevels(tx, tech.locationId);
    let next: string[] = [];
    if (input.level !== null) {
      const level = input.level;
      if (input.serviceIds == null) {
        next = menu.filter((s) => reaches(level, s.minLevel)).map((s) => s.id);
      } else {
        next = [...new Set(input.serviceIds)];
        const known = new Set(menu.map((s) => s.id));
        if (next.some((id) => !known.has(id))) {
          return { ok: false as const, reason: 'unknown_service' as const };
        }
      }
      if (next.length === 0) return { ok: false as const, reason: 'no_services' as const };
    }
    const before = await tx
      .select({ serviceId: technicianServices.serviceId })
      .from(technicianServices)
      .where(eq(technicianServices.technicianId, tech.id));
    await tx.delete(technicianServices).where(eq(technicianServices.technicianId, tech.id));
    if (next.length) {
      await tx.insert(technicianServices).values(
        next.map((serviceId) => ({
          organizationId: tech.organizationId,
          locationId: tech.locationId,
          technicianId: tech.id,
          serviceId,
        })),
      );
      // One truth: the category ticks of Part 6 no longer apply to this technician.
      await tx.delete(technicianSkills).where(eq(technicianSkills.technicianId, tech.id));
    }
    await tx
      .update(technicians)
      .set({ skillLevel: input.level, updatedAt: new Date() })
      .where(eq(technicians.id, tech.id));
    await writeAudit(tx, {
      organizationId: tech.organizationId,
      locationId: tech.locationId,
      actorUserId: input.actor.userId,
      entityType: 'technicians',
      entityId: tech.id,
      action: 'technician_level_changed',
      before: { level: tech.level, serviceIds: before.map((b) => b.serviceId).sort() },
      after: { level: input.level, serviceIds: [...next].sort() },
    });
    return { ok: true as const, serviceIds: next };
  });
}

/**
 * Who gets a service by turn, the lowest level that does it, and whether the
 * desk picks the technician. Owners and managers, own location, audited.
 * Every level ticked is stored as null ("everyone").
 */
export async function setServiceLevels(
  db: Db,
  input: {
    actor: StaffActor;
    serviceId: string;
    minLevel: SkillLevel;
    turnLevels: SkillLevel[] | null;
    deskPicks: boolean;
  },
): Promise<{ ok: true } | { ok: false; reason: LevelError }> {
  if (!mayManage(input.actor)) return { ok: false, reason: 'not_allowed' };
  if (!isSkillLevel(input.minLevel)) return { ok: false, reason: 'bad_level' };
  let turn: SkillLevel[] | null = null;
  if (input.turnLevels !== null) {
    if (input.turnLevels.some((l) => !isSkillLevel(l))) return { ok: false, reason: 'bad_level' };
    turn = SKILL_LEVELS.filter((l) => input.turnLevels!.includes(l));
    if (turn.length === 0) return { ok: false, reason: 'no_levels' };
    if (turn.length === SKILL_LEVELS.length) turn = null;
  }
  return db.transaction(async (tx) => {
    const [svc] = await tx
      .select({
        id: services.id,
        organizationId: services.organizationId,
        locationId: services.locationId,
        minLevel: services.minLevel,
        turnLevels: services.turnLevels,
        deskPicks: services.deskPicks,
      })
      .from(services)
      .where(and(eq(services.id, input.serviceId), isNull(services.archivedAt)))
      .for('update');
    if (!svc) return { ok: false as const, reason: 'unknown_service' as const };
    if (
      svc.organizationId !== input.actor.organizationId ||
      svc.locationId !== input.actor.locationId
    ) {
      return { ok: false as const, reason: 'wrong_location' as const };
    }
    await tx
      .update(services)
      .set({
        minLevel: input.minLevel,
        turnLevels: turn,
        deskPicks: input.deskPicks,
        updatedAt: new Date(),
      })
      .where(eq(services.id, svc.id));
    await writeAudit(tx, {
      organizationId: svc.organizationId,
      locationId: svc.locationId,
      actorUserId: input.actor.userId,
      entityType: 'services',
      entityId: svc.id,
      action: 'service_levels_changed',
      before: { minLevel: svc.minLevel, turnLevels: svc.turnLevels, deskPicks: svc.deskPicks },
      after: { minLevel: input.minLevel, turnLevels: turn, deskPicks: input.deskPicks },
    });
    return { ok: true as const };
  });
}

/** For a technician's own screens and the tech cards: level and service names. */
export async function technicianLevel(
  db: Db | Tx,
  technicianId: string,
): Promise<{ level: SkillLevel | null; serviceIds: string[] }> {
  const [tech] = await db
    .select({ level: technicians.skillLevel })
    .from(technicians)
    .where(eq(technicians.id, technicianId));
  if (!tech?.level) return { level: null, serviceIds: [] };
  const rows = await db
    .select({ serviceId: technicianServices.serviceId })
    .from(technicianServices)
    .where(eq(technicianServices.technicianId, technicianId));
  return { level: tech.level, serviceIds: rows.map((r) => r.serviceId) };
}

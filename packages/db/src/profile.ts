// Technician profile (Part 6; design doc, Technician profile; Duong,
// 2026-11-04): skills per service category, free tags, and the five
// restrictions. Owners and managers edit it at their own location (threat
// model T10); every save writes the audit log with before and after. The
// engine reads it through loadProfiles.
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  serviceCategories,
  technicianRestrictions,
  technicianSkills,
  technicianTags,
  technicians,
} from './schema';
import type { Db } from './server';
import type { StaffActor } from './staff';
import { writeAudit } from './status';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const RESTRICTION_TYPES = [
  'no_male_clients',
  'no_kids',
  'no_same_time',
  'min_client_age',
  'custom',
] as const;
export type RestrictionType = (typeof RESTRICTION_TYPES)[number];

export type Restriction = { type: RestrictionType; value: number | null; note: string | null };

export type TechnicianProfile = {
  technicianId: string;
  /** Category ids the technician does; empty = every category (nothing set up). */
  skillCategoryIds: string[];
  tags: string[];
  restrictions: Restriction[];
};

/** Does this technician do every category? True when no skill rows exist. */
export function doesEverything(profile: Pick<TechnicianProfile, 'skillCategoryIds'>): boolean {
  return profile.skillCategoryIds.length === 0;
}

export function restrictionOf(
  profile: Pick<TechnicianProfile, 'restrictions'>,
  type: RestrictionType,
): Restriction | undefined {
  return profile.restrictions.find((r) => r.type === type);
}

/** Every technician's profile at a location, keyed by technician id. */
export async function loadProfiles(
  db: Db | Tx,
  locationId: string,
): Promise<Map<string, TechnicianProfile>> {
  const [skills, tags, restrictions] = await Promise.all([
    db
      .select({
        technicianId: technicianSkills.technicianId,
        categoryId: technicianSkills.categoryId,
      })
      .from(technicianSkills)
      .where(eq(technicianSkills.locationId, locationId)),
    db
      .select({ technicianId: technicianTags.technicianId, tag: technicianTags.tag })
      .from(technicianTags)
      .where(eq(technicianTags.locationId, locationId))
      .orderBy(asc(technicianTags.tag)),
    db
      .select({
        technicianId: technicianRestrictions.technicianId,
        type: technicianRestrictions.type,
        value: technicianRestrictions.value,
        note: technicianRestrictions.note,
      })
      .from(technicianRestrictions)
      .where(eq(technicianRestrictions.locationId, locationId)),
  ]);
  const out = new Map<string, TechnicianProfile>();
  const of = (id: string): TechnicianProfile => {
    let p = out.get(id);
    if (!p) {
      p = { technicianId: id, skillCategoryIds: [], tags: [], restrictions: [] };
      out.set(id, p);
    }
    return p;
  };
  for (const s of skills) of(s.technicianId).skillCategoryIds.push(s.categoryId);
  for (const t of tags) of(t.technicianId).tags.push(t.tag);
  for (const r of restrictions) {
    of(r.technicianId).restrictions.push({ type: r.type, value: r.value, note: r.note });
  }
  return out;
}

const EMPTY = (technicianId: string): TechnicianProfile => ({
  technicianId,
  skillCategoryIds: [],
  tags: [],
  restrictions: [],
});

/** One technician's profile, empty when nothing is set. */
export async function loadProfile(db: Db, technicianId: string): Promise<TechnicianProfile> {
  const [tech] = await db
    .select({ locationId: technicians.locationId })
    .from(technicians)
    .where(eq(technicians.id, technicianId));
  if (!tech) return EMPTY(technicianId);
  const all = await loadProfiles(db, tech.locationId);
  return all.get(technicianId) ?? EMPTY(technicianId);
}

export type ProfileInput = {
  /** Category ids, or null for "does every category". */
  skillCategoryIds: string[] | null;
  tags: string[];
  restrictions: Restriction[];
};

export type ProfileError =
  | 'not_allowed'
  | 'wrong_location'
  | 'unknown_technician'
  | 'unknown_category'
  | 'no_skills'
  | 'bad_age'
  | 'bad_restriction'
  | 'bad_tag';

const MAX_TAG = 40;
const MAX_TAGS = 12;
const MAX_NOTE = 300;
const MAX_AGE = 120;

/** Shape check, no database: the same rules the screen states. */
export function validateProfile(
  input: ProfileInput,
): { ok: true; input: ProfileInput } | { ok: false; reason: ProfileError } {
  if (input.skillCategoryIds !== null && input.skillCategoryIds.length === 0) {
    return { ok: false, reason: 'no_skills' };
  }
  const tags = [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))];
  if (tags.length > MAX_TAGS || tags.some((t) => t.length > MAX_TAG)) {
    return { ok: false, reason: 'bad_tag' };
  }
  const seen = new Set<RestrictionType>();
  const restrictions: Restriction[] = [];
  for (const r of input.restrictions) {
    if (!RESTRICTION_TYPES.includes(r.type) || seen.has(r.type)) {
      return { ok: false, reason: 'bad_restriction' };
    }
    seen.add(r.type);
    if (r.type === 'min_client_age') {
      if (
        typeof r.value !== 'number' ||
        !Number.isInteger(r.value) ||
        r.value < 1 ||
        r.value > MAX_AGE
      ) {
        return { ok: false, reason: 'bad_age' };
      }
      restrictions.push({ type: r.type, value: r.value, note: null });
    } else if (r.type === 'custom') {
      const note = (r.note ?? '').trim().slice(0, MAX_NOTE);
      if (!note) return { ok: false, reason: 'bad_restriction' };
      restrictions.push({ type: r.type, value: null, note });
    } else {
      restrictions.push({ type: r.type, value: null, note: null });
    }
  }
  return {
    ok: true,
    input: {
      skillCategoryIds: input.skillCategoryIds ? [...new Set(input.skillCategoryIds)] : null,
      tags,
      restrictions,
    },
  };
}

/**
 * Replaces a technician's profile. Rows here are settings, not history, so
 * they are rewritten; the audit row keeps before and after. The technician
 * must be at the actor's own location.
 */
export async function saveProfile(
  db: Db,
  input: { actor: StaffActor; technicianId: string; profile: ProfileInput },
): Promise<{ ok: true } | { ok: false; reason: ProfileError }> {
  if (input.actor.role !== 'owner' && input.actor.role !== 'manager') {
    return { ok: false, reason: 'not_allowed' };
  }
  const checked = validateProfile(input.profile);
  if (!checked.ok) return checked;
  const next = checked.input;
  return db.transaction(async (tx) => {
    const [tech] = await tx
      .select({
        id: technicians.id,
        organizationId: technicians.organizationId,
        locationId: technicians.locationId,
      })
      .from(technicians)
      .where(eq(technicians.id, input.technicianId))
      .for('update');
    if (!tech) return { ok: false, reason: 'unknown_technician' };
    if (
      tech.organizationId !== input.actor.organizationId ||
      tech.locationId !== input.actor.locationId
    ) {
      return { ok: false, reason: 'wrong_location' };
    }
    if (next.skillCategoryIds) {
      const known = await tx
        .select({ id: serviceCategories.id })
        .from(serviceCategories)
        .where(
          and(
            eq(serviceCategories.locationId, tech.locationId),
            isNull(serviceCategories.archivedAt),
            inArray(serviceCategories.id, next.skillCategoryIds),
          ),
        );
      if (known.length !== next.skillCategoryIds.length) {
        return { ok: false, reason: 'unknown_category' };
      }
    }
    const before = (await loadProfiles(tx, tech.locationId)).get(tech.id) ?? EMPTY(tech.id);
    const base = { organizationId: tech.organizationId, locationId: tech.locationId };

    await tx.delete(technicianSkills).where(eq(technicianSkills.technicianId, tech.id));
    if (next.skillCategoryIds?.length) {
      await tx.insert(technicianSkills).values(
        next.skillCategoryIds.map((categoryId) => ({
          ...base,
          technicianId: tech.id,
          categoryId,
        })),
      );
    }
    await tx.delete(technicianTags).where(eq(technicianTags.technicianId, tech.id));
    if (next.tags.length) {
      await tx
        .insert(technicianTags)
        .values(next.tags.map((tag) => ({ ...base, technicianId: tech.id, tag })));
    }
    await tx.delete(technicianRestrictions).where(eq(technicianRestrictions.technicianId, tech.id));
    if (next.restrictions.length) {
      await tx.insert(technicianRestrictions).values(
        next.restrictions.map((r) => ({
          ...base,
          technicianId: tech.id,
          type: r.type,
          value: r.value,
          note: r.note,
        })),
      );
    }
    await writeAudit(tx, {
      organizationId: tech.organizationId,
      locationId: tech.locationId,
      actorUserId: input.actor.userId,
      entityType: 'technicians',
      entityId: tech.id,
      action: 'technician_profile_changed',
      before: {
        skillCategoryIds: before.skillCategoryIds,
        tags: before.tags,
        restrictions: before.restrictions,
      },
      after: {
        skillCategoryIds: next.skillCategoryIds ?? [],
        tags: next.tags,
        restrictions: next.restrictions,
      },
    });
    return { ok: true };
  });
}

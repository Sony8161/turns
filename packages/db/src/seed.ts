// Seeds Heavenly Nails main location: organization, location, service
// categories and rule_configs version 1. Values come from Turn System Design
// Doc.md (rule engine config, Heavenly's values).
//
// Seed rows have fixed ids and every insert is `on conflict do nothing`, so the
// seed is safe to run twice, concurrently, and after a rename.
// No users are seeded: people join through invite codes (Part 2).
// Usage: DATABASE_URL=... npm run db:seed
import { locations, organizations, ruleConfigs, serviceCategories } from './schema';
import { createDb } from './server';

export const HEAVENLY = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  locationId: '00000000-0000-4000-8000-000000000002',
  organization: 'Heavenly Nails & Spa',
  location: 'Heavenly Nails main',
  timezone: 'America/New_York',
} as const;

// Verbatim from the design doc. `null` = still to confirm with Phu.
export const HEAVENLY_RULE_CONFIG_V1 = {
  points: {
    default_service: 1.0,
    fill_or_full_set: 0.5,
    appointment_discount: -0.5,
    combined_services: 'sum',
    combined_fill_full_cap: 1.0,
    post_on: 'completion',
  },
  penalties: {
    deny: 1.0,
    out_over_minutes: 60,
    out_over_penalty: 1.0,
    late_tiers: [
      { after_minutes: 15, start_points: 0.5 },
      { after_minutes: 30, start_points: 1.0 },
      { after_minutes: 60, start_points: null },
    ],
  },
  queue: {
    reset: 'daily_at_open',
    sort: ['points_asc', 'had_appointment_last', 'check_in_asc'],
    auto_pass: false,
  },
  eligibility: {
    require_on_site: true,
    require_ready_checklist: true,
    upcoming_appointment_buffer_min: 30,
    honor_restrictions: true,
    skill_match: 'required',
  },
  requests: {
    requested_tech_bypasses_queue: true,
    requested_counts_points: null,
  },
} as const;

// Categories named in the design doc. Points per the doc: standard 1, fill or
// full set 0.5. The engine reads rule_config for the numbers; base_points here
// is the category's default that the rule builder edits (Part 5).
export const HEAVENLY_CATEGORIES = [
  { name: 'manicure', basePoints: '1.0', isFillOrFullSet: false },
  { name: 'pedicure', basePoints: '1.0', isFillOrFullSet: false },
  { name: 'fill', basePoints: '0.5', isFillOrFullSet: true },
  { name: 'full_set', basePoints: '0.5', isFillOrFullSet: true },
] as const;

export async function seedHeavenly(
  url: string,
): Promise<{ organizationId: string; locationId: string }> {
  const db = createDb(url);
  const { organizationId, locationId } = HEAVENLY;
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(organizations)
        .values({ id: organizationId, name: HEAVENLY.organization })
        .onConflictDoNothing();
      await tx
        .insert(locations)
        .values({
          id: locationId,
          organizationId,
          name: HEAVENLY.location,
          timezone: HEAVENLY.timezone,
        })
        .onConflictDoNothing();
      await tx
        .insert(serviceCategories)
        .values(
          HEAVENLY_CATEGORIES.map((c) => ({
            organizationId,
            locationId,
            name: c.name,
            basePoints: c.basePoints,
            isFillOrFullSet: c.isFillOrFullSet,
          })),
        )
        .onConflictDoNothing();
      await tx
        .insert(ruleConfigs)
        .values({ organizationId, locationId, version: 1, config: HEAVENLY_RULE_CONFIG_V1 })
        .onConflictDoNothing();
    });
    return { organizationId, locationId };
  } finally {
    await db.$client.end();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  seedHeavenly(url).then(
    (ids) => console.log('seeded Heavenly', ids),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

// Part 1 schema. Source of truth: Turn System Design Doc.md (data model) plus
// 13-Turn-System-GRC-Scoping.md section 6 (consent, retention, deletion).
//
// Every tenant table carries organization_id and location_id (where it applies)
// so row-level security can scope by membership. Row-level policies live in the
// hand-written migration drizzle/0001_rls.sql, not here.
//
// Two rules the shape enforces (code review, 2026-11-04):
//   - A location, category or config can never point at a location of another
//     salon: child tables reference (location_id, organization_id) together.
//   - Deleting a salon or location is deliberate: every reference is RESTRICT,
//     so rule_configs history and turn records cannot vanish by cascade.

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const roleEnum = pgEnum('role', ['owner', 'manager', 'receptionist', 'technician']);
export const languageEnum = pgEnum('language', ['en', 'vi']);

// Tenancy -------------------------------------------------------------------

export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  // Two-year promise in the design doc is a setting, not a constant (grc 6.4).
  auditRetentionDays: integer('audit_retention_days').notNull().default(730),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const locations = pgTable(
  'locations',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    address: text('address'),
    geofenceLat: doublePrecision('geofence_lat'),
    geofenceLng: doublePrecision('geofence_lng'),
    geofenceRadiusM: integer('geofence_radius_m'),
    timezone: text('timezone').notNull().default('America/New_York'),
    openTime: time('open_time'),
    closeTime: time('close_time'),
    // Customer phone and name are anonymised after this many days (grc 6.2).
    clientRetentionDays: integer('client_retention_days').notNull().default(365),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Target for the composite foreign keys below.
    unique('locations_id_organization').on(t.id, t.organizationId),
    unique('locations_organization_name').on(t.organizationId, t.name),
  ],
);

/** (location_id, organization_id) must match one locations row. */
const locationFk = (t: { locationId: AnyPgColumn; organizationId: AnyPgColumn }, name: string) =>
  foreignKey({
    columns: [t.locationId, t.organizationId],
    foreignColumns: [locations.id, locations.organizationId],
    name,
  }).onDelete('restrict');

// People --------------------------------------------------------------------

// One row per Supabase auth user. id = auth.users.id; the foreign key to the
// auth schema is added in drizzle/0001_rls.sql because drizzle-kit does not
// manage that schema.
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  email: text('email'),
  phone: text('phone'),
  displayName: text('display_name').notNull(),
  preferredLanguage: languageEnum('preferred_language').notNull().default('en'),
  // Consent record (grc 6.1): when, and which text.
  tosAcceptedAt: timestamp('tos_accepted_at', { withTimezone: true }),
  tosVersion: text('tos_version'),
  smsConsentAt: timestamp('sms_consent_at', { withTimezone: true }),
  locationConsentAt: timestamp('location_consent_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    role: roleEnum('role').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    locationFk(t, 'memberships_location_fk'),
    // A user can hold different roles at different locations, and two roles at
    // one location as separate rows (design doc: roles kept separate).
    unique('memberships_user_location_role').on(t.userId, t.locationId, t.role),
    // The row-level policy check runs once per row; this is its lookup.
    index('memberships_active_user_org')
      .on(t.userId, t.organizationId)
      .where(sql`active`),
  ],
);

export const technicians = pgTable(
  'technicians',
  {
    id: id(),
    // RESTRICT on purpose: a technician row anchors turn records. Staff who leave
    // are deactivated and their contact fields blanked (grc 6.3), not deleted.
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    displayName: text('display_name').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    locationFk(t, 'technicians_location_fk'),
    unique('technicians_user_location').on(t.userId, t.locationId),
  ],
);

// Services ------------------------------------------------------------------

export const serviceCategories = pgTable(
  'service_categories',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    name: text('name').notNull(),
    basePoints: numeric('base_points', { precision: 3, scale: 1 }).notNull(),
    isFillOrFullSet: boolean('is_fill_or_full_set').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    locationFk(t, 'service_categories_location_fk'),
    unique('service_categories_id_organization').on(t.id, t.organizationId),
    unique('service_categories_location_name').on(t.locationId, t.name),
  ],
);

export const services = pgTable(
  'services',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    categoryId: uuid('category_id').notNull(),
    name: text('name').notNull(),
    defaultDurationMin: integer('default_duration_min'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    locationFk(t, 'services_location_fk'),
    foreignKey({
      columns: [t.categoryId, t.organizationId],
      foreignColumns: [serviceCategories.id, serviceCategories.organizationId],
      name: 'services_category_fk',
    }).onDelete('restrict'),
  ],
);

// Rules ---------------------------------------------------------------------

// Versioned. A change to points is a new row, never an edit (design doc,
// working rules). The engine reads the latest active row for a location.
export const ruleConfigs = pgTable(
  'rule_configs',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    version: integer('version').notNull(),
    config: jsonb('config').notNull(),
    activeFrom: timestamp('active_from', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    locationFk(t, 'rule_configs_location_fk'),
    unique('rule_configs_location_version').on(t.locationId, t.version),
  ],
);

// Invites ------------------------------------------------------------------

// A code binds a new user to one location and one role (design doc,
// Authentication). Only the SHA-256 of the code is stored (threat model T9);
// the plain code is shown once to the owner who created it.
export const inviteCodes = pgTable(
  'invite_codes',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    role: roleEnum('role').notNull(),
    codeHash: text('code_hash').notNull().unique(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedBy: uuid('used_by').references(() => profiles.id, { onDelete: 'restrict' }),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [locationFk(t, 'invite_codes_location_fk')],
  // RLS on, no policies, no grants: app users never read codes; the server does.
).enableRLS();

// Daily operation (Part 3) --------------------------------------------------

// The six states the technician drives from their own phone (design doc,
// Technician status machine). The readiness checklist is recorded on the
// shift (ready_at), not as a state.
export const technicianStatusEnum = pgEnum('tech_state', [
  'off',
  'checked_in',
  'available',
  'in_service',
  'break',
  'out',
]);

export const shifts = pgTable(
  'shifts',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    technicianId: uuid('technician_id')
      .notNull()
      .references(() => technicians.id, { onDelete: 'restrict' }),
    // Local date at the location, so a late-night shift stays on one day.
    date: date('date').notNull(),
    scheduledStart: time('scheduled_start'),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }).notNull(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    lateMinutes: integer('late_minutes').notNull().default(0),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    locationFk(t, 'shifts_location_fk'),
    unique('shifts_technician_date').on(t.technicianId, t.date),
  ],
).enableRLS();

export const technicianStatus = pgTable(
  'technician_status',
  {
    technicianId: uuid('technician_id')
      .primaryKey()
      .references(() => technicians.id, { onDelete: 'restrict' }),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    status: technicianStatusEnum('status').notNull().default('off'),
    since: timestamp('since', { withTimezone: true }).notNull().defaultNow(),
    shiftId: uuid('shift_id').references(() => shifts.id, { onDelete: 'restrict' }),
    outStartedAt: timestamp('out_started_at', { withTimezone: true }),
    expectedBackAt: timestamp('expected_back_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [locationFk(t, 'technician_status_location_fk')],
).enableRLS();

export const ledgerReasonEnum = pgEnum('ledger_reason', [
  'visit',
  'deny',
  'out_over',
  'late',
  'manual',
]);

// Points are a ledger, never a stored total (design doc, Data model). The daily
// total is the sum of a shift's rows. visit_id gets its foreign key in Part 4.
export const turnLedger = pgTable(
  'turn_ledger',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    technicianId: uuid('technician_id')
      .notNull()
      .references(() => technicians.id, { onDelete: 'restrict' }),
    shiftId: uuid('shift_id')
      .notNull()
      .references(() => shifts.id, { onDelete: 'restrict' }),
    delta: numeric('delta', { precision: 4, scale: 1 }).notNull(),
    reasonType: ledgerReasonEnum('reason_type').notNull(),
    visitId: uuid('visit_id'),
    actorUserId: uuid('actor_user_id').references(() => profiles.id, { onDelete: 'restrict' }),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [locationFk(t, 'turn_ledger_location_fk'), index('turn_ledger_shift').on(t.shiftId)],
).enableRLS();

// Append-only: a trigger in the migration refuses update and delete, for every
// role including the service key (design doc, Audit log; threat model T17).
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    actorUserId: uuid('actor_user_id').references(() => profiles.id, { onDelete: 'restrict' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    action: text('action').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    locationFk(t, 'audit_log_location_fk'),
    index('audit_log_location_at').on(t.locationId, t.at),
  ],
).enableRLS();

// Salon setup codes ---------------------------------------------------------

// Made by the platform operator, not by a salon. Whoever redeems one creates a
// new organization with its first location and becomes its owner. Hashed and
// single use like invite codes. No app access.
export const setupCodes = pgTable('setup_codes', {
  id: id(),
  codeHash: text('code_hash').notNull().unique(),
  note: text('note'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedBy: uuid('used_by').references(() => profiles.id, { onDelete: 'restrict' }),
  usedAt: timestamp('used_at', { withTimezone: true }),
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'restrict',
  }),
  createdAt: createdAt(),
}).enableRLS();

// Rate limits -------------------------------------------------------------

// App-side limiter for sign-in and join (threat model T7). Supabase's own
// per-IP limits see only the server's IP, so they are one shared bucket.
// Key examples: "otp:contact:+18135550100", "otp:ip:203.0.113.9".
export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
}).enableRLS();

export const TENANT_TABLES = [
  'shifts',
  'technician_status',
  'turn_ledger',
  'audit_log',
  'setup_codes',
  'rate_limits',
  'invite_codes',
  'organizations',
  'locations',
  'profiles',
  'memberships',
  'technicians',
  'service_categories',
  'services',
  'rule_configs',
] as const;

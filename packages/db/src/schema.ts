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
  uniqueIndex,
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
    // Part 5 (Duong, 2026-11-04): the receptionist or manager switches on a
    // long-wait notice for customers (the kiosk shows it, Part 9).
    longWaitNotice: boolean('long_wait_notice').notNull().default(false),
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
    // Nothing is deleted, only archived (Duong, 2026-11-04).
    archivedAt: timestamp('archived_at', { withTimezone: true }),
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
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    locationFk(t, 'services_location_fk'),
    unique('services_location_name').on(t.locationId, t.name),
    foreignKey({
      columns: [t.categoryId, t.organizationId],
      foreignColumns: [serviceCategories.id, serviceCategories.organizationId],
      name: 'services_category_fk',
    }).onDelete('restrict'),
  ],
);

// Technician profile (Part 6) ----------------------------------------------

// Skills are per service category (Duong, 2026-11-04): a row says the
// technician does that category. A technician with no rows does every
// category (the common case; nothing to set up for a new salon). The engine
// reads these when eligibility.skill_match is not "off".
export const technicianSkills = pgTable(
  'technician_skills',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    technicianId: uuid('technician_id')
      .notNull()
      .references(() => technicians.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    locationFk(t, 'technician_skills_location_fk'),
    foreignKey({
      columns: [t.categoryId, t.organizationId],
      foreignColumns: [serviceCategories.id, serviceCategories.organizationId],
      name: 'technician_skills_category_fk',
    }).onDelete('restrict'),
    unique('technician_skills_technician_category').on(t.technicianId, t.categoryId),
    index('technician_skills_location').on(t.locationId),
  ],
).enableRLS();

// Free words the salon uses about a technician (fast, design, gel_x_specialist).
// Shown to the desk; the engine does not read them (design doc, open question).
export const technicianTags = pgTable(
  'technician_tags',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    technicianId: uuid('technician_id')
      .notNull()
      .references(() => technicians.id, { onDelete: 'restrict' }),
    tag: text('tag').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    locationFk(t, 'technician_tags_location_fk'),
    unique('technician_tags_technician_tag').on(t.technicianId, t.tag),
    index('technician_tags_location').on(t.locationId),
  ],
).enableRLS();

// The five restrictions from the design doc. One row per type per technician;
// min_client_age carries the age in `value`; custom carries text in `note` and
// is shown to the desk, never applied by the engine (it cannot read it).
export const restrictionTypeEnum = pgEnum('restriction_type', [
  'no_male_clients',
  'no_kids',
  'no_same_time',
  'min_client_age',
  'custom',
]);

export const technicianRestrictions = pgTable(
  'technician_restrictions',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    technicianId: uuid('technician_id')
      .notNull()
      .references(() => technicians.id, { onDelete: 'restrict' }),
    type: restrictionTypeEnum('type').notNull(),
    value: integer('value'),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    locationFk(t, 'technician_restrictions_location_fk'),
    unique('technician_restrictions_technician_type').on(t.technicianId, t.type),
    index('technician_restrictions_location').on(t.locationId),
  ],
).enableRLS();

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
    // Part 5: who saved this version and why. A row is never edited or removed
    // (trigger in drizzle/0014); the latest valid version is the active one.
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'restrict' }),
    note: text('note'),
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
  // Part 6: a manager excuses a penalty; the row reverses the one it names.
  'excuse',
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
    // Part 6: an "excuse" row names the penalty row it reverses. Unique, so a
    // penalty is excused at most once.
    reversesId: uuid('reverses_id').references((): AnyPgColumn => turnLedger.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    locationFk(t, 'turn_ledger_location_fk'),
    index('turn_ledger_shift').on(t.shiftId),
    unique('turn_ledger_reverses').on(t.reversesId),
  ],
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
    // The audit viewer (Part 8) filters by action over a date range.
    index('audit_log_location_action_at').on(t.locationId, t.action, t.at),
  ],
).enableRLS();

// Clients (Part 6) ------------------------------------------------------------

// Minimal: Fresha stays the client system (design doc). The phone, stored in
// E.164, is the match key so Fresha's client list can be imported later
// without duplicates (Duong, 2026-11-04). Name and phone are blanked after the
// location's client_retention_days (grc 6.2); the row stays for the visits.
export const clientGenderEnum = pgEnum('client_gender', ['female', 'male', 'unspecified']);

export const clients = pgTable(
  'clients',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    name: text('name'),
    phone: text('phone'),
    gender: clientGenderEnum('gender'),
    notes: text('notes'),
    anonymisedAt: timestamp('anonymised_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    locationFk(t, 'clients_location_fk'),
    uniqueIndex('clients_location_phone')
      .on(t.locationId, t.phone)
      .where(sql`${t.phone} is not null`),
  ],
).enableRLS();

// Visits and calls (Part 4) ----------------------------------------------------

export const visitSourceEnum = pgEnum('visit_source', [
  'walk_in',
  'appointment',
  'request',
  'self_checkin',
]);
export const visitStatusEnum = pgEnum('visit_status', [
  'waiting',
  'called',
  'in_service',
  'completed',
  'cancelled',
]);
export const callResponseEnum = pgEnum('call_response', [
  'accepted',
  'denied',
  'overridden',
  'expired',
]);

export const visits = pgTable(
  'visits',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    source: visitSourceEnum('source').notNull().default('walk_in'),
    status: visitStatusEnum('status').notNull().default('waiting'),
    // Part 6: who the client is (optional) and what the restrictions need to
    // know about this visit. Audit rows reference the visit, never the client.
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'restrict' }),
    // null = not asked. Only male triggers no_male_clients.
    clientGender: clientGenderEnum('client_gender'),
    clientIsKid: boolean('client_is_kid'),
    // Approximate age when the desk asked (for min_client_age); null = not asked.
    clientAge: integer('client_age'),
    // Two services at the same time: the visits of one client share a group
    // (design doc, Same-time services). Technicians with no_same_time are skipped.
    groupId: uuid('group_id'),
    requestedTechnicianId: uuid('requested_technician_id').references(() => technicians.id, {
      onDelete: 'restrict',
    }),
    assignedTechnicianId: uuid('assigned_technician_id').references(() => technicians.id, {
      onDelete: 'restrict',
    }),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'restrict' }),
    arrivedAt: timestamp('arrived_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    // Posted at completion; kept here for the report, the ledger is the record.
    pointsPosted: numeric('points_posted', { precision: 4, scale: 1 }),
    note: text('note'),
    // Part 9: a customer checked in on the kiosk. The desk confirms before the
    // engine may call anyone (threat model Q6); a trigger refuses a call while
    // needs_confirm is set. kiosk_name is the first name the customer typed,
    // shown to the desk only, never written to the audit log (T11, T12).
    kioskDeviceId: uuid('kiosk_device_id').references(() => kioskDevices.id, {
      onDelete: 'restrict',
    }),
    kioskName: text('kiosk_name'),
    // v0.9.1: the phone the customer typed (E.164), held on the visit until the
    // desk confirms; only then is it matched to a client row, and it is cleared
    // either way. Kiosk input never edits a stored client (review finding 1).
    kioskPhone: text('kiosk_phone'),
    needsConfirm: boolean('needs_confirm').notNull().default(false),
    confirmedBy: uuid('confirmed_by').references(() => profiles.id, { onDelete: 'restrict' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    locationFk(t, 'visits_location_fk'),
    index('visits_location_status').on(t.locationId, t.status),
    index('visits_client').on(t.clientId),
  ],
).enableRLS();

export const visitServices = pgTable(
  'visit_services',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    visitId: uuid('visit_id')
      .notNull()
      .references(() => visits.id, { onDelete: 'restrict' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
    // The points this service was worth under the rules at the time.
    pointsValueSnapshot: numeric('points_value_snapshot', { precision: 4, scale: 1 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('visit_services_visit_service').on(t.visitId, t.serviceId)],
).enableRLS();

// One call per visit per attempt. The partial unique indexes (migration) keep a
// technician to one open call and a visit to one open call (threat model T3).
export const turnCalls = pgTable(
  'turn_calls',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    visitId: uuid('visit_id')
      .notNull()
      .references(() => visits.id, { onDelete: 'restrict' }),
    technicianId: uuid('technician_id')
      .notNull()
      .references(() => technicians.id, { onDelete: 'restrict' }),
    calledAt: timestamp('called_at', { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    response: callResponseEnum('response'),
    denyReason: text('deny_reason'),
    excusedBy: uuid('excused_by').references(() => profiles.id, { onDelete: 'restrict' }),
    excusedAt: timestamp('excused_at', { withTimezone: true }),
    calledBy: uuid('called_by').references(() => profiles.id, { onDelete: 'restrict' }),
    // Who was ahead and why, at that second: the row that settles arguments.
    queueSnapshot: jsonb('queue_snapshot').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    locationFk(t, 'turn_calls_location_fk'),
    index('turn_calls_visit').on(t.visitId),
    index('turn_calls_technician').on(t.technicianId),
    // Open calls at a location (attention strip) and today's answered calls.
    index('turn_calls_location_responded').on(t.locationId, t.respondedAt),
  ],
).enableRLS();

// Appointments (table in Part 6, filled in Part 7) ----------------------------

// Calendar feeds (Part 7). Fresha gives one calendar link per team member
// (threat model Q5), so a feed belongs to one technician: the mapping
// technician <-> calendar is this row. The URL is a secret (T14): no app role
// has any grant on this table; only the server reads it, and the screens see
// `url_hint` (host and last four characters) and the sync state.
export const calendarFeeds = pgTable(
  'calendar_feeds',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    technicianId: uuid('technician_id')
      .notNull()
      .references(() => technicians.id, { onDelete: 'restrict' }),
    url: text('url').notNull(),
    urlHint: text('url_hint').notNull(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    // A short code (dns_refused, http_404, too_large, timeout, parse...), never the URL.
    lastError: text('last_error'),
    lastEventCount: integer('last_event_count'),
    // Removed by the owner: the URL is blanked, the row stays for the
    // appointments that came from it. Setting a feed again re-opens the row.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    locationFk(t, 'calendar_feeds_location_fk'),
    unique('calendar_feeds_technician').on(t.technicianId),
    index('calendar_feeds_location').on(t.locationId),
  ],
).enableRLS();

// The eligibility filter "no appointment starting within the buffer" reads
// this table; the manual entry and the calendar poll fill it (Part 7).
export const appointmentSourceEnum = pgEnum('appointment_source', ['ics', 'manual']);

export const appointments = pgTable(
  'appointments',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    technicianId: uuid('technician_id')
      .notNull()
      .references(() => technicians.id, { onDelete: 'restrict' }),
    // The calendar's own id, so a re-poll updates instead of duplicating.
    externalId: text('external_id'),
    clientName: text('client_name'),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    source: appointmentSourceEnum('source').notNull().default('manual'),
    // The feed an ics row came from: a re-poll cancels rows its feed dropped.
    feedId: uuid('feed_id').references(() => calendarFeeds.id, { onDelete: 'restrict' }),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    // "Client arrived": the visit it became. An arrived appointment no longer
    // holds its technician out of the queue (buffer filter).
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    visitId: uuid('visit_id').references(() => visits.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    locationFk(t, 'appointments_location_fk'),
    unique('appointments_visit').on(t.visitId),
    index('appointments_feed').on(t.feedId),
    index('appointments_technician_start').on(t.technicianId, t.startAt),
    // The buffer filter: a location's appointments around now.
    index('appointments_location_start').on(t.locationId, t.startAt),
    uniqueIndex('appointments_location_external')
      .on(t.locationId, t.externalId)
      .where(sql`${t.externalId} is not null`),
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

// Kiosk devices (Part 9) ----------------------------------------------------

// A salon-owned iPad at the front, registered by an owner or manager to one
// location (threat model T20, T25). The device holds a random token in an
// httpOnly cookie; only its SHA-256 is stored. The token can do one thing:
// create a waiting visit at its own location. Pairing is a one-time code that
// expires; revoking sets revoked_at and the token stops working at once. The
// 4-digit PIN (scrypt) unlocks the iPad into the staff sign-in. No app role
// reads this table; the server uses the service connection.
export const kioskDevices = pgTable(
  'kiosk_devices',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').unique(),
    pairingCodeHash: text('pairing_code_hash').unique(),
    pairingExpiresAt: timestamp('pairing_expires_at', { withTimezone: true }),
    pinHash: text('pin_hash').notNull(),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    pairedAt: timestamp('paired_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => profiles.id, { onDelete: 'restrict' }),
    // v0.9.1: the right PIN opens a short window in which this iPad may reach
    // the staff sign-in; the browser holds the random token, this its hash.
    unlockTokenHash: text('unlock_token_hash'),
    unlockExpiresAt: timestamp('unlock_expires_at', { withTimezone: true }),
  },
  (t) => [
    locationFk(t, 'kiosk_devices_location_fk'),
    index('kiosk_devices_location').on(t.locationId),
  ],
).enableRLS();

// Daily summaries (Part 8) ---------------------------------------------------

// The end-of-day summary for the owner, one row per location and local date.
// Written once (insert, never update), read on the owner's home and, once the
// phone app has push, sent from here. Counts and names of staff only: no
// client name, phone or feed address ever goes in `summary`.
export const dailySummaries = pgTable(
  'daily_summaries',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id').notNull(),
    date: date('date').notNull(),
    summary: jsonb('summary').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    locationFk(t, 'daily_summaries_location_fk'),
    unique('daily_summaries_location_date').on(t.locationId, t.date),
  ],
).enableRLS();

export const TENANT_TABLES = [
  'kiosk_devices',
  'daily_summaries',
  'technician_skills',
  'technician_tags',
  'technician_restrictions',
  'clients',
  'calendar_feeds',
  'appointments',
  'visits',
  'visit_services',
  'turn_calls',
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

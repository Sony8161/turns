// Rule config: the one place every number the engine reads lives (design doc,
// Rule engine; threat model T18). Validated on save, versioned, never edited:
// the database refuses an update or delete (drizzle/0014). The engine reads
// the newest version that validates, so a bad row can never stall the floor.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  ruleConfigs,
  serviceCategories,
  services,
  shifts,
  technicianStatus,
  technicians,
  turnLedger,
  visitServices,
  visits,
} from './schema';
import type { Db } from './server';
import { HAD_APPOINTMENT_LAST, writeAudit, type Actor } from './status';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type LateTier = { after_minutes: number; start_points: number | null };

/** Why a technician says no to a call. Lives here (not in the engine) so the
 *  rules can name the reasons that excuse themselves (v0.15.0). */
export const DENY_REASONS = [
  'not_my_service',
  'with_another_client',
  'break_needed',
  'personal',
  'client_issue',
  'other',
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

export type RuleConfig = {
  points: {
    default_service: number;
    fill_or_full_set: number;
    appointment_discount: number;
    combined_services: 'sum';
    /** null = no cap. */
    combined_fill_full_cap: number | null;
    post_on: 'completion';
    /** Points for one service category (by category id), overriding the two defaults. */
    by_category?: Record<string, number>;
    /** v0.16.0: points for one service (by service id), ahead of its category
     *  and the defaults. Heavenly: polish change 0, gel polish change 1, fix 0. */
    by_service?: Record<string, number>;
  };
  penalties: {
    deny: number;
    /** v0.15.0: deny reasons that excuse themselves: no points, no manager
     *  needed. Every other reason costs `deny` unless a manager excuses it. */
    deny_excused_reasons: DenyReason[];
    out_over_minutes: number;
    out_over_penalty: number;
    /** start_points null = unset: still to confirm with the owner. */
    late_tiers: LateTier[];
  };
  queue: {
    reset: 'daily_at_open';
    sort: string[];
    auto_pass: boolean;
  };
  eligibility: {
    require_on_site: boolean;
    require_ready_checklist: boolean;
    upcoming_appointment_buffer_min: number;
    honor_restrictions: boolean;
    skill_match: 'required' | 'preferred' | 'off';
  };
  requests: {
    requested_tech_bypasses_queue: boolean;
    /** Multiplier on a requested visit's points: 1 full, 0.5 half, 0 none; null = unset (counts in full). */
    requested_counts_points: number | null;
  };
  /** When the floor needs a person (Duong, 2026-11-04). */
  attention: {
    /** A call with no answer for this long is flagged to the receptionist and manager. */
    unanswered_call_min: number;
    /** An estimated wait of this long or more is a long wait (kiosk notice, board flag). */
    long_wait_min: number;
    /** Used for the wait estimate when a service has no duration of its own. */
    default_service_min: number;
    /** v0.15.0: a client waiting this long for the technician they asked for
     *  or booked is flagged to the desk (keep waiting, book for later, or
     *  send by turn). Missing in an older config = long_wait_min. */
    request_wait_min: number;
  };
  /** v0.16.0: nail fixes and repairs. Missing in an older config = the defaults. */
  fixes: {
    /** The desk is shown the client's visits from this many days back. Heavenly: 14 (or 7). */
    window_days: number;
    /** A fix entered by a receptionist waits for a manager or owner to approve it. */
    receptionist_needs_approval: boolean;
  };
  /** v0.16.0: people who come in together. */
  groups: {
    /** Most people in one group check-in. Heavenly: 8. */
    max_people: number;
  };
  /** v0.17.0 (FAIR-001): free ways to turn down a client. Missing in an older
   *  config = the defaults. */
  fairness: {
    /** A technician's "Client left": 'ask_desk' keeps the visit called until
     *  the desk confirms; 'direct' closes it at once (v0.16.0). Heavenly: ask_desk. */
    client_left_by_tech: 'ask_desk' | 'direct';
    /** The board flags a technician with this many free (auto-excused)
     *  denies today. 0 = no flag. Heavenly: 3. */
    free_deny_flag: number;
    /** Free denies a day before the next one costs the deny penalty.
     *  null = no limit (Duong: break and personal denies are free). */
    free_deny_daily_limit: number | null;
  };
  /** v0.17.0 (DAY-001, WALK-001): closing what the day left open. */
  closing: {
    /** A visit still in service when the day ends: 'finish' posts its points
     *  to that day's shift, marked auto-finished; 'close' closes it with no
     *  points. Heavenly: finish. */
    day_end_in_service: 'finish' | 'close';
    /** The desk may mark a booked client a no-show this many minutes after
     *  the start time. Heavenly: 0 (as soon as the time has passed). */
    no_show_after_min: number;
  };
};

/** v0.16.0 defaults, used when an older config has no such section. */
export const FIX_WINDOW_PRESETS = [7, 14] as const;
export const FIXES_DEFAULT: RuleConfig['fixes'] = {
  window_days: 14,
  receptionist_needs_approval: true,
};
export const GROUPS_DEFAULT: RuleConfig['groups'] = { max_people: 8 };
/** v0.17.0 defaults, used when an older config has no such section. */
export const CLIENT_LEFT_BY_TECH = ['ask_desk', 'direct'] as const;
export const DAY_END_IN_SERVICE = ['finish', 'close'] as const;
export const FAIRNESS_DEFAULT: RuleConfig['fairness'] = {
  client_left_by_tech: 'ask_desk',
  free_deny_flag: 3,
  free_deny_daily_limit: null,
};
export const CLOSING_DEFAULT: RuleConfig['closing'] = {
  day_end_in_service: 'finish',
  no_show_after_min: 0,
};
const FREE_DENY_MAX = 50;
export const GROUP_MAX_LIMIT = 8;
const FIX_WINDOW_MAX = 90;

export const SKILL_MATCH = ['required', 'preferred', 'off'] as const;
// 'double_zero_last' (v0.15.0, Duong 2026-11-12): at zero points only, a
// technician whose last visit was an appointment (shown 00) goes after a true
// 0; above zero the appointment makes no difference. 'had_appointment_last'
// is the same idea at every score, kept for a salon that wants it.
export const QUEUE_SORT = [
  'points_asc',
  'double_zero_last',
  'had_appointment_last',
  'check_in_asc',
] as const;

/** Queue order from the rules' `queue.sort` keys, in their order; check-in breaks a last tie. Pure. */
export function compareQueue(
  rules: Pick<RuleConfig, 'queue'>,
  a: { points: number; hadAppointmentLast: boolean; checkedInAt: Date | null },
  b: { points: number; hadAppointmentLast: boolean; checkedInAt: Date | null },
): number {
  const checkIn = (a.checkedInAt?.getTime() ?? 0) - (b.checkedInAt?.getTime() ?? 0);
  const appointment = Number(a.hadAppointmentLast) - Number(b.hadAppointmentLast);
  for (const key of rules.queue.sort) {
    const d =
      key === 'points_asc'
        ? a.points - b.points
        : key === 'had_appointment_last'
          ? appointment
          : key === 'double_zero_last'
            ? a.points === 0 && b.points === 0
              ? appointment
              : 0
            : checkIn;
    if (d !== 0) return d;
  }
  return checkIn;
}

export type RuleProblem =
  | 'missing'
  | 'not_a_number'
  | 'not_a_boolean'
  | 'not_a_half_step'
  | 'negative'
  | 'not_a_whole_number'
  | 'not_allowed'
  | 'not_in_order'
  | 'not_an_object'
  | 'unknown_category'
  | 'unknown_service';

export type RuleError = { path: string; problem: RuleProblem };

export type ValidationResult =
  { ok: true; config: RuleConfig } | { ok: false; errors: RuleError[] };

// Bounds, not rules: points move in halves (the board cannot show finer), and
// no timer in a salon day is longer than the day.
const POINTS_MIN = -20;
const POINTS_MAX = 20;
const MINUTES_MAX = 24 * 60;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Check {
  errors: RuleError[] = [];

  fail(path: string, problem: RuleProblem): undefined {
    this.errors.push({ path, problem });
    return undefined;
  }

  section(root: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
    const v = root[name];
    if (v === undefined) return this.fail(name, 'missing');
    if (!isRecord(v)) return this.fail(name, 'not_an_object');
    return v;
  }

  /** A point value: finite number in half steps, within a sane range. */
  points(obj: Record<string, unknown>, path: string, nullable = false): number | null | undefined {
    const v = obj[path.split('.').pop()!];
    if (v === undefined) return this.fail(path, 'missing');
    if (v === null) return nullable ? null : this.fail(path, 'not_a_number');
    if (typeof v !== 'number' || !Number.isFinite(v)) return this.fail(path, 'not_a_number');
    if (v < POINTS_MIN || v > POINTS_MAX) return this.fail(path, 'not_allowed');
    if (Math.round(v * 2) !== v * 2) return this.fail(path, 'not_a_half_step');
    return v;
  }

  /** A minute count: whole, zero or more, at most a day. */
  minutes(obj: Record<string, unknown>, path: string): number | undefined {
    const v = obj[path.split('.').pop()!];
    if (v === undefined) return this.fail(path, 'missing');
    if (typeof v !== 'number' || !Number.isFinite(v)) return this.fail(path, 'not_a_number');
    if (v < 0) return this.fail(path, 'negative');
    if (!Number.isInteger(v)) return this.fail(path, 'not_a_whole_number');
    if (v > MINUTES_MAX) return this.fail(path, 'not_allowed');
    return v;
  }

  bool(obj: Record<string, unknown>, path: string): boolean | undefined {
    const v = obj[path.split('.').pop()!];
    if (v === undefined) return this.fail(path, 'missing');
    if (typeof v !== 'boolean') return this.fail(path, 'not_a_boolean');
    return v;
  }

  choice<T extends string>(
    obj: Record<string, unknown>,
    path: string,
    allowed: readonly T[],
  ): T | undefined {
    const v = obj[path.split('.').pop()!];
    if (v === undefined) return this.fail(path, 'missing');
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      return this.fail(path, 'not_allowed');
    }
    return v as T;
  }
}

/** Shape check only: no database. Save adds the checks that need one. */
export function validateRuleConfig(input: unknown): ValidationResult {
  const c = new Check();
  if (!isRecord(input)) return { ok: false, errors: [{ path: '', problem: 'not_an_object' }] };

  const points = c.section(input, 'points');
  const penalties = c.section(input, 'penalties');
  const queue = c.section(input, 'queue');
  const eligibility = c.section(input, 'eligibility');
  const requests = c.section(input, 'requests');
  const attention = c.section(input, 'attention');
  if (!points || !penalties || !queue || !eligibility || !requests || !attention) {
    return { ok: false, errors: c.errors };
  }

  const out: RuleConfig = {
    points: {
      default_service: c.points(points, 'points.default_service')!,
      fill_or_full_set: c.points(points, 'points.fill_or_full_set')!,
      appointment_discount: c.points(points, 'points.appointment_discount')!,
      combined_services: c.choice(points, 'points.combined_services', ['sum'] as const)!,
      combined_fill_full_cap: c.points(points, 'points.combined_fill_full_cap', true) as
        number | null,
      post_on: c.choice(points, 'points.post_on', ['completion'] as const)!,
    },
    penalties: {
      deny: c.points(penalties, 'penalties.deny')!,
      deny_excused_reasons: [],
      out_over_minutes: c.minutes(penalties, 'penalties.out_over_minutes')!,
      out_over_penalty: c.points(penalties, 'penalties.out_over_penalty')!,
      late_tiers: [],
    },
    queue: {
      reset: c.choice(queue, 'queue.reset', ['daily_at_open'] as const)!,
      sort: [],
      auto_pass: c.bool(queue, 'queue.auto_pass')!,
    },
    eligibility: {
      require_on_site: c.bool(eligibility, 'eligibility.require_on_site')!,
      require_ready_checklist: c.bool(eligibility, 'eligibility.require_ready_checklist')!,
      upcoming_appointment_buffer_min: c.minutes(
        eligibility,
        'eligibility.upcoming_appointment_buffer_min',
      )!,
      honor_restrictions: c.bool(eligibility, 'eligibility.honor_restrictions')!,
      skill_match: c.choice(eligibility, 'eligibility.skill_match', SKILL_MATCH)!,
    },
    requests: {
      requested_tech_bypasses_queue: c.bool(requests, 'requests.requested_tech_bypasses_queue')!,
      requested_counts_points: c.points(requests, 'requests.requested_counts_points', true) as
        number | null,
    },
    attention: {
      unanswered_call_min: c.minutes(attention, 'attention.unanswered_call_min')!,
      long_wait_min: c.minutes(attention, 'attention.long_wait_min')!,
      default_service_min: c.minutes(attention, 'attention.default_service_min')!,
      // Filled in below: optional, so configs saved before v0.15.0 still validate.
      request_wait_min: 0,
    },
    fixes: { ...FIXES_DEFAULT },
    groups: { ...GROUPS_DEFAULT },
    fairness: { ...FAIRNESS_DEFAULT },
    closing: { ...CLOSING_DEFAULT },
  };

  // v0.17.0 sections: optional, so configs saved before v0.17.0 still validate.
  if (input['fairness'] !== undefined) {
    const f = c.section(input, 'fairness');
    if (f) {
      const mode = c.choice(f, 'fairness.client_left_by_tech', CLIENT_LEFT_BY_TECH);
      if (mode !== undefined) out.fairness.client_left_by_tech = mode;
      const flag = c.minutes(f, 'fairness.free_deny_flag');
      if (flag !== undefined) {
        if (flag > FREE_DENY_MAX) c.fail('fairness.free_deny_flag', 'not_allowed');
        else out.fairness.free_deny_flag = flag;
      }
      if (f['free_deny_daily_limit'] === null) out.fairness.free_deny_daily_limit = null;
      else {
        const limit = c.minutes(f, 'fairness.free_deny_daily_limit');
        if (limit !== undefined) {
          if (limit > FREE_DENY_MAX) c.fail('fairness.free_deny_daily_limit', 'not_allowed');
          else out.fairness.free_deny_daily_limit = limit;
        }
      }
    }
  }
  if (input['closing'] !== undefined) {
    const cl = c.section(input, 'closing');
    if (cl) {
      const mode = c.choice(cl, 'closing.day_end_in_service', DAY_END_IN_SERVICE);
      if (mode !== undefined) out.closing.day_end_in_service = mode;
      const after = c.minutes(cl, 'closing.no_show_after_min');
      if (after !== undefined) out.closing.no_show_after_min = after;
    }
  }

  // v0.16.0 sections: optional, so configs saved before v0.16.0 still validate.
  if (input['fixes'] !== undefined) {
    const fixes = c.section(input, 'fixes');
    if (fixes) {
      const days = c.minutes(fixes, 'fixes.window_days');
      if (days !== undefined) {
        if (days < 1 || days > FIX_WINDOW_MAX) c.fail('fixes.window_days', 'not_allowed');
        else out.fixes.window_days = days;
      }
      const approval = c.bool(fixes, 'fixes.receptionist_needs_approval');
      if (approval !== undefined) out.fixes.receptionist_needs_approval = approval;
    }
  }
  if (input['groups'] !== undefined) {
    const groups = c.section(input, 'groups');
    if (groups) {
      const max = c.minutes(groups, 'groups.max_people');
      if (max !== undefined) {
        if (max < 2 || max > GROUP_MAX_LIMIT) c.fail('groups.max_people', 'not_allowed');
        else out.groups.max_people = max;
      }
    }
  }

  const requestWait =
    attention['request_wait_min'] === undefined
      ? out.attention.long_wait_min
      : c.minutes(attention, 'attention.request_wait_min');
  if (requestWait !== undefined) out.attention.request_wait_min = requestWait;
  if (requestWait === 0) c.fail('attention.request_wait_min', 'not_allowed');

  // Deny reasons that excuse themselves: known reasons, each at most once.
  // Missing (a config saved before v0.15.0) = none, as it behaved then.
  const excused = penalties['deny_excused_reasons'];
  if (excused !== undefined) {
    if (!Array.isArray(excused)) c.fail('penalties.deny_excused_reasons', 'not_allowed');
    else {
      for (const r of excused) {
        if (typeof r !== 'string' || !(DENY_REASONS as readonly string[]).includes(r)) {
          c.fail('penalties.deny_excused_reasons', 'not_allowed');
        } else if (!out.penalties.deny_excused_reasons.includes(r as DenyReason)) {
          out.penalties.deny_excused_reasons.push(r as DenyReason);
        }
      }
    }
  }

  // Penalties for a deny or an overlong out are added to the total, never subtracted.
  if (out.penalties.deny < 0) c.fail('penalties.deny', 'negative');
  if (out.penalties.out_over_penalty < 0) c.fail('penalties.out_over_penalty', 'negative');
  const multiplier = out.requests.requested_counts_points;
  if (multiplier !== null && (multiplier < 0 || multiplier > 1)) {
    c.fail('requests.requested_counts_points', 'not_allowed');
  }
  if (out.attention.default_service_min === 0)
    c.fail('attention.default_service_min', 'not_allowed');
  // A call needs at least a minute before the desk may clear it.
  if (out.attention.unanswered_call_min === 0) {
    c.fail('attention.unanswered_call_min', 'not_allowed');
  }

  // Points per category: id -> points.
  const byCategory = points['by_category'];
  if (byCategory !== undefined) {
    if (!isRecord(byCategory)) c.fail('points.by_category', 'not_an_object');
    else {
      const table: Record<string, number> = {};
      for (const key of Object.keys(byCategory)) {
        const v = c.points(byCategory, `points.by_category.${key}`);
        if (v !== undefined && v !== null) table[key] = v;
      }
      out.points.by_category = table;
    }
  }
  // Points per service (v0.16.0): id -> points.
  const byService = points['by_service'];
  if (byService !== undefined) {
    if (!isRecord(byService)) c.fail('points.by_service', 'not_an_object');
    else {
      const table: Record<string, number> = {};
      for (const key of Object.keys(byService)) {
        const v = c.points(byService, `points.by_service.${key}`);
        if (v !== undefined && v !== null) table[key] = v;
      }
      out.points.by_service = table;
    }
  }

  // Late tiers: ascending minutes, each with start points or unset.
  const tiers = penalties['late_tiers'];
  if (!Array.isArray(tiers)) c.fail('penalties.late_tiers', 'missing');
  else {
    let last = -1;
    tiers.forEach((tier, i) => {
      if (!isRecord(tier)) return c.fail(`penalties.late_tiers.${i}`, 'not_an_object');
      const after = c.minutes(tier, `penalties.late_tiers.${i}.after_minutes`);
      const start = c.points(tier, `penalties.late_tiers.${i}.start_points`, true);
      if (after !== undefined && start !== undefined) {
        out.penalties.late_tiers.push({ after_minutes: after, start_points: start });
      }
      if (after !== undefined) {
        if (after <= last) c.fail('penalties.late_tiers', 'not_in_order');
        last = after;
      }
    });
  }

  // Queue sort: the known keys, each at most once.
  const sort = queue['sort'];
  if (!Array.isArray(sort)) c.fail('queue.sort', 'missing');
  else {
    for (const key of sort) {
      if (typeof key !== 'string' || !(QUEUE_SORT as readonly string[]).includes(key)) {
        c.fail('queue.sort', 'not_allowed');
      } else if (out.queue.sort.includes(key)) c.fail('queue.sort', 'not_allowed');
      else out.queue.sort.push(key);
    }
  }

  return c.errors.length ? { ok: false, errors: c.errors } : { ok: true, config: out };
}

/** The rules the engine runs under: the newest version that validates. */
export async function activeRules(db: Db | Tx, locationId: string): Promise<RuleConfig> {
  const rows = await db
    .select({ version: ruleConfigs.version, config: ruleConfigs.config })
    .from(ruleConfigs)
    .where(eq(ruleConfigs.locationId, locationId))
    .orderBy(desc(ruleConfigs.version));
  for (const row of rows) {
    const checked = validateRuleConfig(row.config);
    if (checked.ok) return checked.config;
  }
  throw new Error(`no valid rule_config for location ${locationId}`);
}

export type RuleVersion = {
  id: string;
  version: number;
  config: RuleConfig | null;
  valid: boolean;
  activeFrom: Date;
  createdBy: string | null;
  note: string | null;
};

/** Every version, newest first. A row that no longer validates says so. */
export async function ruleHistory(db: Db, locationId: string): Promise<RuleVersion[]> {
  const rows = await db
    .select()
    .from(ruleConfigs)
    .where(eq(ruleConfigs.locationId, locationId))
    .orderBy(desc(ruleConfigs.version));
  return rows.map((r) => {
    const checked = validateRuleConfig(r.config);
    return {
      id: r.id,
      version: r.version,
      config: checked.ok ? checked.config : null,
      valid: checked.ok,
      activeFrom: r.activeFrom,
      createdBy: r.createdBy,
      note: r.note,
    };
  });
}

export type SaveResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'invalid'; errors: RuleError[] }
  | { ok: false; reason: 'stale'; latestVersion: number };

/**
 * Saves a new version. Validates the shape, then checks that every category
 * override names a category of this location. Never touches an old row; the
 * trigger would refuse it anyway. The audit row carries both versions.
 */
export async function saveRuleConfig(
  db: Db,
  input: {
    organizationId: string;
    locationId: string;
    config: unknown;
    actor: Actor;
    note?: string | null;
    /** The version the editor started from; refused if a newer one exists. */
    expectedVersion?: number;
  },
): Promise<SaveResult> {
  const checked = validateRuleConfig(input.config);
  if (!checked.ok) return { ok: false, reason: 'invalid', errors: checked.errors };
  const config = checked.config;

  const note = input.note?.trim().slice(0, 300) || null;
  return db.transaction(async (tx) => {
    const ids = Object.keys(config.points.by_category ?? {});
    if (ids.length) {
      const known = await tx
        .select({ id: serviceCategories.id })
        .from(serviceCategories)
        .where(
          and(
            eq(serviceCategories.locationId, input.locationId),
            inArray(serviceCategories.id, ids),
          ),
        );
      if (known.length !== ids.length) {
        return {
          ok: false,
          reason: 'invalid',
          errors: [{ path: 'points.by_category', problem: 'unknown_category' }],
        };
      }
    }
    const serviceIds = Object.keys(config.points.by_service ?? {});
    if (serviceIds.length) {
      const known = await tx
        .select({ id: services.id })
        .from(services)
        .where(and(eq(services.locationId, input.locationId), inArray(services.id, serviceIds)));
      if (known.length !== serviceIds.length) {
        return {
          ok: false,
          reason: 'invalid',
          errors: [{ path: 'points.by_service', problem: 'unknown_service' }],
        };
      }
    }

    // One save at a time per location, so two owners cannot both take version n+1.
    // Two-key form: the first key names this use, so a future advisory lock
    // elsewhere cannot collide with it.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('rule_configs'), hashtext(${input.locationId}))`,
    );
    const [latest] = await tx
      .select({ version: ruleConfigs.version, config: ruleConfigs.config })
      .from(ruleConfigs)
      .where(eq(ruleConfigs.locationId, input.locationId))
      .orderBy(desc(ruleConfigs.version))
      .limit(1);
    const latestVersion = latest?.version ?? 0;
    if (input.expectedVersion !== undefined && latestVersion !== input.expectedVersion) {
      return { ok: false, reason: 'stale', latestVersion };
    }
    const version = latestVersion + 1;
    const [row] = await tx
      .insert(ruleConfigs)
      .values({
        organizationId: input.organizationId,
        locationId: input.locationId,
        version,
        config,
        createdBy: input.actor.userId,
        note,
      })
      .returning({ id: ruleConfigs.id });
    if (!row) throw new Error('rule_configs insert returned nothing');
    await writeAudit(tx, {
      organizationId: input.organizationId,
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      entityType: 'rule_configs',
      entityId: row.id,
      action: 'rule_config_changed',
      before: latest ? { version: latest.version, config: latest.config } : null,
      after: { version, config },
      reason: note,
    });
    return { ok: true, version };
  });
}

/** Points a visit is worth under a config. Pure, so tests and the preview can pin it.
 *  v0.17.1 (review #11): a nail fix is always 0, whatever the rules say (a
 *  fix is on a visit of its own, so the whole visit is 0). */
export function visitPointsUnder(
  rules: RuleConfig,
  items: { isFillOrFullSet: boolean; categoryId: string; serviceId?: string; isFix?: boolean }[],
  source: 'walk_in' | 'appointment' | 'request' | 'self_checkin',
): number {
  if (items.some((s) => s.isFix)) return 0;
  const overrides = rules.points.by_category ?? {};
  const perService = rules.points.by_service ?? {};
  let total = items.reduce((sum, s) => {
    // v0.16.0: a service's own points come first, then its category's.
    const mine = s.serviceId !== undefined ? perService[s.serviceId] : undefined;
    const own = mine !== undefined ? mine : overrides[s.categoryId];
    const value =
      own !== undefined
        ? own
        : s.isFillOrFullSet
          ? rules.points.fill_or_full_set
          : rules.points.default_service;
    return sum + value;
  }, 0);
  const cap = rules.points.combined_fill_full_cap;
  if (items.length > 1 && items.some((s) => s.isFillOrFullSet) && cap !== null) {
    total = Math.min(total, cap);
  }
  if (source === 'appointment') total += rules.points.appointment_discount;
  if (source === 'request' && rules.requests.requested_counts_points !== null) {
    total *= rules.requests.requested_counts_points;
  }
  return Math.round(total * 2) / 2;
}

export type PreviewRow = {
  technicianId: string;
  displayName: string;
  status: string;
  checkedInAt: Date | null;
  /** The last visit was an appointment (0 before 00), as posted. */
  hadAppointmentLast: boolean;
  /** Today's total as posted. */
  points: number;
  /** Today's total if every row had been posted under the candidate config. */
  previewPoints: number;
};

/**
 * Today's board re-scored under a candidate config: every visit row is
 * re-valued from its services, deny and out-over rows from the candidate
 * penalties; late and manual rows stay as posted. Nothing is written.
 */
export async function previewBoard(
  db: Db,
  locationId: string,
  candidate: RuleConfig,
): Promise<PreviewRow[]> {
  const techs = await db
    .select({
      technicianId: technicians.id,
      displayName: technicians.displayName,
      status: technicianStatus.status,
      shiftId: technicianStatus.shiftId,
      checkedInAt: shifts.checkedInAt,
      hadAppointmentLast: HAD_APPOINTMENT_LAST,
    })
    .from(technicians)
    .innerJoin(technicianStatus, eq(technicianStatus.technicianId, technicians.id))
    .leftJoin(shifts, eq(shifts.id, technicianStatus.shiftId))
    .where(and(eq(technicians.locationId, locationId), eq(technicians.active, true)));
  const onShift = techs.filter((t) => t.status !== 'off' && t.shiftId);
  const shiftIds = onShift.map((t) => t.shiftId!);
  if (shiftIds.length === 0) return [];

  const ledger = await db
    .select({
      shiftId: turnLedger.shiftId,
      delta: turnLedger.delta,
      reasonType: turnLedger.reasonType,
      note: turnLedger.note,
      visitId: turnLedger.visitId,
      id: turnLedger.id,
      reversesId: turnLedger.reversesId,
    })
    .from(turnLedger)
    .where(inArray(turnLedger.shiftId, shiftIds));
  const visitIds = [...new Set(ledger.map((l) => l.visitId).filter((v): v is string => !!v))];
  const items = visitIds.length
    ? await db
        .select({
          visitId: visitServices.visitId,
          source: visits.source,
          isFillOrFullSet: serviceCategories.isFillOrFullSet,
          categoryId: serviceCategories.id,
          serviceId: visitServices.serviceId,
          isFix: services.isFix,
        })
        .from(visitServices)
        .innerJoin(visits, eq(visits.id, visitServices.visitId))
        .innerJoin(services, eq(services.id, visitServices.serviceId))
        .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
        .where(inArray(visitServices.visitId, visitIds))
    : [];

  const rescore = (row: (typeof ledger)[number]): number => {
    const posted = Number(row.delta);
    switch (row.reasonType) {
      case 'visit': {
        const own = items.filter((i) => i.visitId === row.visitId);
        if (own.length === 0) return posted;
        return visitPointsUnder(candidate, own, own[0]!.source);
      }
      case 'deny':
        // The row's note is the deny reason: one the candidate excuses costs nothing.
        return (candidate.penalties.deny_excused_reasons as string[]).includes(row.note ?? '')
          ? 0
          : candidate.penalties.deny;
      case 'out_over':
        return candidate.penalties.out_over_penalty;
      case 'excuse': {
        // An excuse cancels its penalty under any config (v0.13.0: it used to
        // keep the posted amount, so a new deny value left a remainder).
        const reversed = ledger.find((l) => l.id === row.reversesId);
        return reversed ? -rescore(reversed) : posted;
      }
      default:
        return posted;
    }
  };

  return onShift
    .map((t) => {
      const rows = ledger.filter((l) => l.shiftId === t.shiftId);
      const points = rows.reduce((s, r) => s + Number(r.delta), 0);
      const previewPoints = rows.reduce((s, r) => s + rescore(r), 0);
      return {
        technicianId: t.technicianId,
        displayName: t.displayName,
        status: t.status,
        checkedInAt: t.checkedInAt,
        hadAppointmentLast: t.hadAppointmentLast === true,
        points,
        previewPoints,
      };
    })
    .sort((a, b) =>
      // The candidate's own order (0 before 00 and the rest of queue.sort).
      compareQueue(candidate, { ...a, points: a.previewPoints }, { ...b, points: b.previewPoints }),
    );
}

// Starting templates (v0.13.0, Duong 2026-11-12: "how the owner can make the
// turn system their own"). A template fills the rule builder; nothing is saved
// until the owner presses Save, after the preview. The salon's own attention
// timers and per-category points are kept.

export const RULE_TEMPLATES = ['standard', 'simple_rotation'] as const;
export type RuleTemplate = (typeof RULE_TEMPLATES)[number];

/** The standard rules: Heavenly Nails' (design doc). */
const STANDARD: Omit<RuleConfig, 'attention'> = {
  points: {
    default_service: 1,
    fill_or_full_set: 0.5,
    appointment_discount: -0.5,
    combined_services: 'sum',
    // v0.15.0 (Duong): services in one visit add up, no cap.
    combined_fill_full_cap: null,
    post_on: 'completion',
  },
  penalties: {
    deny: 1,
    deny_excused_reasons: ['break_needed', 'personal'],
    out_over_minutes: 60,
    out_over_penalty: 1,
    late_tiers: [
      { after_minutes: 15, start_points: 0.5 },
      { after_minutes: 30, start_points: 1 },
      { after_minutes: 60, start_points: null },
    ],
  },
  queue: {
    reset: 'daily_at_open',
    sort: ['points_asc', 'double_zero_last', 'check_in_asc'],
    auto_pass: false,
  },
  eligibility: {
    require_on_site: true,
    require_ready_checklist: true,
    upcoming_appointment_buffer_min: 30,
    honor_restrictions: true,
    skill_match: 'required',
  },
  // v0.16.0 (Duong): a request counts as a full normal turn.
  requests: { requested_tech_bypasses_queue: true, requested_counts_points: 1 },
  fixes: { ...FIXES_DEFAULT },
  groups: { ...GROUPS_DEFAULT },
  fairness: { ...FAIRNESS_DEFAULT },
  closing: { ...CLOSING_DEFAULT },
};

/** A template's config on top of the salon's current one. Pure. */
export function templateConfig(template: RuleTemplate, base: RuleConfig): RuleConfig {
  const standard: RuleConfig = structuredClone({
    ...STANDARD,
    attention: base.attention,
    // v0.16.0: the salon's fix window and group size are kept, like its timers.
    fixes: base.fixes,
    groups: base.groups,
    // v0.17.0: so are its fairness and closing choices.
    fairness: base.fairness,
    closing: base.closing,
  });
  if (base.points.by_category) standard.points.by_category = { ...base.points.by_category };
  if (base.points.by_service) standard.points.by_service = { ...base.points.by_service };
  if (template === 'standard') return standard;
  // Simple rotation: every service is one turn, appointments count like any
  // other visit, no cap; the line is points then check-in.
  return {
    ...standard,
    points: {
      ...standard.points,
      fill_or_full_set: 1,
      appointment_discount: 0,
      combined_fill_full_cap: null,
      by_category: undefined,
      // Per-service points stay (a free fix, a free polish change); the owner
      // edits them below the template like any other number.
    },
    // Every deny costs the same; a manager can still excuse one.
    penalties: { ...standard.penalties, deny_excused_reasons: [] },
    queue: { ...standard.queue, sort: ['points_asc', 'check_in_asc'] },
  };
}

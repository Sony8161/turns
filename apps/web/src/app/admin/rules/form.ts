// The rule builder's form fields to a candidate config. Pure: no database,
// no server. Values stay as typed when they are not numbers, so the
// validator (packages/db rules.ts) reports them field by field instead of
// this file guessing.
import type { DenyReason, RuleConfig } from '@turn/db/rules';

// The engine's deny reasons, repeated here as plain text: this file is also
// loaded by the browser, which must not pull in the database package
// (form.test.ts checks the two lists stay the same).
export const DENY_REASONS = [
  'not_my_service',
  'with_another_client',
  'break_needed',
  'personal',
  'client_issue',
  'other',
] as const satisfies readonly DenyReason[];

/** v0.15.0: where a technician whose last client was an appointment goes. */
export const APPOINTMENT_ORDER = {
  zero: 'double_zero_last',
  every: 'had_appointment_last',
  off: null,
} as const;
export type AppointmentOrder = keyof typeof APPOINTMENT_ORDER;

export function appointmentOrderFor(sort: readonly string[]): AppointmentOrder {
  if (sort.includes('had_appointment_last')) return 'every';
  if (sort.includes('double_zero_last')) return 'zero';
  return 'off';
}

/** queue.sort with the chosen appointment key right after the points. */
export function sortWith(base: readonly string[], order: AppointmentOrder): string[] {
  const rest = base.filter((k) => k !== 'double_zero_last' && k !== 'had_appointment_last');
  const key = APPOINTMENT_ORDER[order];
  if (!key) return rest;
  const at = rest.indexOf('points_asc') + 1;
  return [...rest.slice(0, at), key, ...rest.slice(at)];
}

/** Empty late-tier rows shown beyond the stored ones. */
export const TIER_SLOTS = 5;

export const COUNTS_CHOICES = {
  unset: null,
  full: 1,
  half: 0.5,
  none: 0,
} as const;
export type CountsChoice = keyof typeof COUNTS_CHOICES;

// Plain decimal numbers only, with a comma accepted as the decimal mark
// (Vietnamese keyboards). Hex, exponents and words stay text for the validator.
const NUMBER = /^-?\d+(\.\d+)?$/;

/** A number field: blank is "unset"; text that is not a number is kept as text. */
function num(raw: FormDataEntryValue | null): number | string | undefined {
  const s = String(raw ?? '').trim();
  if (s === '') return undefined;
  const normalized = s.replace(',', '.');
  return NUMBER.test(normalized) ? Number(normalized) : s;
}

function bool(raw: FormDataEntryValue | null): boolean {
  return raw === 'on' || raw === 'true';
}

export function countsChoiceFor(value: number | null): CountsChoice {
  for (const [key, v] of Object.entries(COUNTS_CHOICES)) {
    if (v === value) return key as CountsChoice;
  }
  return 'unset';
}

export type FormParse = {
  candidate: unknown;
  /** Compacted tier index -> the form slot it came from, for error messages. */
  tierSlots: number[];
};

/**
 * Builds the candidate from the form. Fields the form does not edit
 * (combined_services, post_on, queue.reset, the rest of queue.sort) and category
 * overrides for categories the form did not show (archived ones) are copied
 * from the base config so a save never silently drops them.
 */
export function configFromForm(fd: FormData, base: RuleConfig, categoryIds: string[]): FormParse {
  const byCategory: Record<string, unknown> = {};
  for (const [id, points] of Object.entries(base.points.by_category ?? {})) {
    if (!categoryIds.includes(id)) byCategory[id] = points;
  }
  for (const id of categoryIds) {
    const v = num(fd.get(`category.${id}`));
    if (v !== undefined) byCategory[id] = v;
  }
  const tiers: unknown[] = [];
  const tierSlots: number[] = [];
  const slots = Math.max(TIER_SLOTS, base.penalties.late_tiers.length + 1);
  for (let i = 0; i < slots; i++) {
    const after = num(fd.get(`tier.${i}.after`));
    const start = num(fd.get(`tier.${i}.start`));
    if (after === undefined && start === undefined) continue;
    // A row with points but no minutes is kept so the validator names the gap.
    tiers.push({ after_minutes: after, start_points: start === undefined ? null : start });
    tierSlots.push(i);
  }
  const counts = String(fd.get('requests.requested_counts_points') ?? 'unset');
  const order = String(fd.get('queue.appointment_order') ?? '');
  const requestWait = num(fd.get('attention.request_wait_min'));
  const cap = num(fd.get('points.combined_fill_full_cap'));
  const candidate = {
    points: {
      default_service: num(fd.get('points.default_service')),
      fill_or_full_set: num(fd.get('points.fill_or_full_set')),
      appointment_discount: num(fd.get('points.appointment_discount')),
      combined_services: base.points.combined_services,
      combined_fill_full_cap: cap === undefined ? null : cap,
      post_on: base.points.post_on,
      by_category: byCategory,
    },
    penalties: {
      deny: num(fd.get('penalties.deny')),
      deny_excused_reasons: DENY_REASONS.filter((r) => bool(fd.get(`deny_excused.${r}`))),
      out_over_minutes: num(fd.get('penalties.out_over_minutes')),
      out_over_penalty: num(fd.get('penalties.out_over_penalty')),
      late_tiers: tiers,
    },
    queue: {
      reset: base.queue.reset,
      sort:
        order in APPOINTMENT_ORDER
          ? sortWith(base.queue.sort, order as AppointmentOrder)
          : base.queue.sort,
      auto_pass: bool(fd.get('queue.auto_pass')),
    },
    eligibility: {
      require_on_site: bool(fd.get('eligibility.require_on_site')),
      require_ready_checklist: bool(fd.get('eligibility.require_ready_checklist')),
      upcoming_appointment_buffer_min: num(fd.get('eligibility.upcoming_appointment_buffer_min')),
      honor_restrictions: bool(fd.get('eligibility.honor_restrictions')),
      skill_match: String(fd.get('eligibility.skill_match') ?? ''),
    },
    requests: {
      requested_tech_bypasses_queue: bool(fd.get('requests.requested_tech_bypasses_queue')),
      requested_counts_points:
        counts in COUNTS_CHOICES ? COUNTS_CHOICES[counts as CountsChoice] : counts,
    },
    attention: {
      unanswered_call_min: num(fd.get('attention.unanswered_call_min')),
      long_wait_min: num(fd.get('attention.long_wait_min')),
      default_service_min: num(fd.get('attention.default_service_min')),
      // Blank = as long as a long wait (the validator's fallback).
      ...(requestWait === undefined ? {} : { request_wait_min: requestWait }),
    },
  };
  return { candidate, tierSlots };
}

/** The form field that a validator path points at, so the message lands under it. */
export function fieldFor(path: string, tierSlots: number[]): string {
  const category = /^points\.by_category\.(.+)$/.exec(path);
  if (category) return `category.${category[1]}`;
  const tier = /^penalties\.late_tiers\.(\d+)\.(after_minutes|start_points)$/.exec(path);
  if (tier) {
    const slot = tierSlots[Number(tier[1])] ?? Number(tier[1]);
    return `tier.${slot}.${tier[2] === 'after_minutes' ? 'after' : 'start'}`;
  }
  return path;
}

/** The form's field values for a config, so the form can show what is saved. */
export function formValues(config: RuleConfig): Record<string, string> {
  const v: Record<string, string> = {
    'points.default_service': String(config.points.default_service),
    'points.fill_or_full_set': String(config.points.fill_or_full_set),
    'points.appointment_discount': String(config.points.appointment_discount),
    'points.combined_fill_full_cap':
      config.points.combined_fill_full_cap === null
        ? ''
        : String(config.points.combined_fill_full_cap),
    'penalties.deny': String(config.penalties.deny),
    'penalties.out_over_minutes': String(config.penalties.out_over_minutes),
    'penalties.out_over_penalty': String(config.penalties.out_over_penalty),
    'queue.auto_pass': config.queue.auto_pass ? 'on' : '',
    'eligibility.require_on_site': config.eligibility.require_on_site ? 'on' : '',
    'eligibility.require_ready_checklist': config.eligibility.require_ready_checklist ? 'on' : '',
    'eligibility.upcoming_appointment_buffer_min': String(
      config.eligibility.upcoming_appointment_buffer_min,
    ),
    'eligibility.honor_restrictions': config.eligibility.honor_restrictions ? 'on' : '',
    'eligibility.skill_match': config.eligibility.skill_match,
    'requests.requested_tech_bypasses_queue': config.requests.requested_tech_bypasses_queue
      ? 'on'
      : '',
    'requests.requested_counts_points': countsChoiceFor(config.requests.requested_counts_points),
    'attention.unanswered_call_min': String(config.attention.unanswered_call_min),
    'attention.long_wait_min': String(config.attention.long_wait_min),
    'attention.default_service_min': String(config.attention.default_service_min),
    'attention.request_wait_min': String(config.attention.request_wait_min),
    'queue.appointment_order': appointmentOrderFor(config.queue.sort),
  };
  for (const r of DENY_REASONS) {
    v[`deny_excused.${r}`] = config.penalties.deny_excused_reasons.includes(r) ? 'on' : '';
  }
  for (const [id, points] of Object.entries(config.points.by_category ?? {})) {
    v[`category.${id}`] = String(points);
  }
  config.penalties.late_tiers.forEach((tier, i) => {
    v[`tier.${i}.after`] = String(tier.after_minutes);
    v[`tier.${i}.start`] = tier.start_points === null ? '' : String(tier.start_points);
  });
  return v;
}

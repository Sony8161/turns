// The rule builder round-trips: the form values of a config build the same
// config back, text in a number field survives to the validator, blank
// means unset where unset is allowed, and every validator path maps to the
// field that caused it.
import {
  DENY_REASONS as ENGINE_REASONS,
  validateRuleConfig,
  type RuleConfig,
} from '@turn/db/rules';
import { HEAVENLY_RULE_CONFIG_V1 } from '@turn/db/seed';
import { describe, expect, it } from 'vitest';
import {
  appointmentOrderFor,
  configFromForm,
  DENY_REASONS,
  fieldFor,
  formValues,
  placesMoved,
  sortWith,
} from './form';

const base: RuleConfig = HEAVENLY_RULE_CONFIG_V1;

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) if (v !== '') fd.set(k, v);
  return fd;
}

describe('rule builder form', () => {
  it("round-trips Heavenly's config, nulls included", () => {
    const { candidate } = configFromForm(form(formValues(base)), base, []);
    const checked = validateRuleConfig(candidate);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const gotPoints = { ...checked.config.points, by_category: undefined, by_service: undefined };
    const wantPoints = { ...base.points, by_category: undefined, by_service: undefined };
    expect({ ...checked.config, points: gotPoints }).toEqual({ ...base, points: wantPoints });
    expect(checked.config.penalties.late_tiers[2]?.start_points).toBeNull();
    // v0.16.0 (Duong): a request counts as a full normal turn.
    expect(checked.config.requests.requested_counts_points).toBe(1);
  });

  it('v0.16.0: points per service, the fix window and the group size round-trip', () => {
    const polish = '00000000-0000-4000-8000-0000000000a1';
    const hidden = '00000000-0000-4000-8000-0000000000a2';
    const withService: RuleConfig = {
      ...base,
      points: { ...base.points, by_service: { [polish]: 0, [hidden]: 2 } },
      fixes: { window_days: 7, receptionist_needs_approval: false },
      groups: { max_people: 5 },
    };
    const values = formValues(withService);
    expect(values[`service.${polish}`]).toBe('0');
    expect(values['fixes.window_days']).toBe('7');
    expect(values['fixes.receptionist_needs_approval']).toBe('');
    expect(values['groups.max_people']).toBe('5');
    // The form shows only `polish`; the other service's points are kept from the base.
    const { candidate } = configFromForm(form(values), withService, [], [polish]);
    const checked = validateRuleConfig(candidate);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.config.points.by_service).toEqual({ [polish]: 0, [hidden]: 2 });
    expect(checked.config.fixes).toEqual({ window_days: 7, receptionist_needs_approval: false });
    expect(checked.config.groups).toEqual({ max_people: 5 });
    // Blank clears a service's own points (its category's value applies).
    const cleared = configFromForm(
      form({ ...values, [`service.${polish}`]: '' }),
      withService,
      [],
      [polish],
    );
    const again = validateRuleConfig(cleared.candidate);
    expect(again.ok && again.config.points.by_service).toEqual({ [hidden]: 2 });
    expect(fieldFor(`points.by_service.${polish}`, [])).toBe(`service.${polish}`);
    // A group of one, or of nine, is refused.
    const nine = configFromForm(form({ ...values, 'groups.max_people': '9' }), withService, []);
    expect(validateRuleConfig(nine.candidate).ok).toBe(false);
  });

  it('keeps text in a number field so the validator names it; accepts a decimal comma', () => {
    const values = { ...formValues(base), 'penalties.deny': 'one' };
    const checked = validateRuleConfig(configFromForm(form(values), base, []).candidate);
    expect(checked).toMatchObject({
      ok: false,
      errors: [{ path: 'penalties.deny', problem: 'not_a_number' }],
    });
    const comma = { ...formValues(base), 'penalties.deny': '1,5' };
    const ok = validateRuleConfig(configFromForm(form(comma), base, []).candidate);
    expect(ok.ok && ok.config.penalties.deny).toBe(1.5);
    const hex = { ...formValues(base), 'penalties.deny': '0x10' };
    expect(validateRuleConfig(configFromForm(form(hex), base, []).candidate).ok).toBe(false);
  });

  it('reads category overrides, keeps overrides for categories not shown, and a cleared cap', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const archived = '22222222-2222-4222-8222-222222222222';
    const withArchived: RuleConfig = {
      ...base,
      points: { ...base.points, by_category: { [archived]: 2 } },
    };
    const values = {
      ...formValues(withArchived),
      [`category.${id}`]: '1.5',
      'requests.requested_counts_points': 'half',
      'points.combined_fill_full_cap': '',
    };
    const checked = validateRuleConfig(configFromForm(form(values), withArchived, [id]).candidate);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.config.points.by_category).toEqual({ [id]: 1.5, [archived]: 2 });
    expect(checked.config.requests.requested_counts_points).toBe(0.5);
    expect(checked.config.points.combined_fill_full_cap).toBeNull();
  });

  it('drops a blank late tier, reports one out of order, and names a tier with points but no minutes', () => {
    const values = {
      ...formValues(base),
      'tier.1.after': '',
      'tier.1.start': '',
      'tier.3.after': '20',
      'tier.3.start': '2',
    };
    const parsed = configFromForm(form(values), base, []);
    expect(parsed.tierSlots).toEqual([0, 2, 3]);
    expect(validateRuleConfig(parsed.candidate)).toMatchObject({
      ok: false,
      errors: [{ path: 'penalties.late_tiers', problem: 'not_in_order' }],
    });

    const noMinutes = { ...formValues(base), 'tier.4.start': '3' };
    const parsed2 = configFromForm(form(noMinutes), base, []);
    const checked = validateRuleConfig(parsed2.candidate);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    const path = checked.errors.find((e) => e.problem === 'missing')?.path;
    expect(path).toBe('penalties.late_tiers.3.after_minutes');
    expect(fieldFor(path!, parsed2.tierSlots)).toBe('tier.4.after');
  });

  // v0.15.0 -------------------------------------------------------------------
  it("lists the engine's deny reasons, and ticks the ones a config excuses", () => {
    expect([...DENY_REASONS]).toEqual([...ENGINE_REASONS]);
    const values = formValues(base);
    expect(values['deny_excused.break_needed']).toBe('on');
    expect(values['deny_excused.personal']).toBe('on');
    expect(values['deny_excused.other']).toBe('');
    // Untick "personal", tick "client_issue".
    const changed = { ...values, 'deny_excused.personal': '', 'deny_excused.client_issue': 'on' };
    const checked = validateRuleConfig(configFromForm(form(changed), base, []).candidate);
    expect(checked.ok && checked.config.penalties.deny_excused_reasons).toEqual([
      'break_needed',
      'client_issue',
    ]);
  });

  it('turns the appointment choice into the queue sort, keeping the other keys', () => {
    expect(appointmentOrderFor(base.queue.sort)).toBe('zero');
    expect(formValues(base)['queue.appointment_order']).toBe('zero');
    expect(sortWith(base.queue.sort, 'every')).toEqual([
      'points_asc',
      'had_appointment_last',
      'check_in_asc',
    ]);
    expect(sortWith(base.queue.sort, 'off')).toEqual(['points_asc', 'check_in_asc']);
    expect(sortWith(['points_asc', 'check_in_asc'], 'zero')).toEqual(base.queue.sort);
    const every = { ...formValues(base), 'queue.appointment_order': 'every' };
    const checked = validateRuleConfig(configFromForm(form(every), base, []).candidate);
    expect(checked.ok && checked.config.queue.sort).toEqual([
      'points_asc',
      'had_appointment_last',
      'check_in_asc',
    ]);
  });

  it('reads the request wait; blank falls back to the long wait', () => {
    const typed = { ...formValues(base), 'attention.request_wait_min': '5' };
    const a = validateRuleConfig(configFromForm(form(typed), base, []).candidate);
    expect(a.ok && a.config.attention.request_wait_min).toBe(5);
    const blank = { ...formValues(base), 'attention.request_wait_min': '' };
    const b = validateRuleConfig(configFromForm(form(blank), base, []).candidate);
    expect(b.ok && b.config.attention.request_wait_min).toBe(base.attention.long_wait_min);
  });

  it('maps validator paths to form fields', () => {
    expect(fieldFor('points.by_category.abc', [])).toBe('category.abc');
    expect(fieldFor('penalties.late_tiers.1.start_points', [0, 2])).toBe('tier.2.start');
    expect(fieldFor('penalties.deny', [])).toBe('penalties.deny');
  });
});

describe('placesMoved (v0.16.1: the preview marks who moves)', () => {
  const before = ['Thảo', 'Linh', 'Mai'];
  it('up is positive, down is negative, staying is 0', () => {
    expect(placesMoved(before, 'Mai', 0)).toBe(2);
    expect(placesMoved(before, 'Thảo', 1)).toBe(-1);
    expect(placesMoved(before, 'Linh', 1)).toBe(0);
  });
  it('a name not in the line before is not marked', () => {
    expect(placesMoved(before, 'Vân', 0)).toBe(0);
  });
});

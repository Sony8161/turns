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
    const gotPoints = { ...checked.config.points, by_category: undefined };
    const wantPoints = { ...base.points, by_category: undefined };
    expect({ ...checked.config, points: gotPoints }).toEqual({ ...base, points: wantPoints });
    expect(checked.config.penalties.late_tiers[2]?.start_points).toBeNull();
    expect(checked.config.requests.requested_counts_points).toBeNull();
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

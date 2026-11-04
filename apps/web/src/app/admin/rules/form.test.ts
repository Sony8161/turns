// The rule builder round-trips: the form values of a config build the same
// config back, text in a number field survives to the validator, blank
// means unset where unset is allowed, and every validator path maps to the
// field that caused it.
import { validateRuleConfig, type RuleConfig } from '@turn/db/rules';
import { HEAVENLY_RULE_CONFIG_V1 } from '@turn/db/seed';
import { describe, expect, it } from 'vitest';
import { configFromForm, fieldFor, formValues } from './form';

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

  it('maps validator paths to form fields', () => {
    expect(fieldFor('points.by_category.abc', [])).toBe('category.abc');
    expect(fieldFor('penalties.late_tiers.1.start_points', [0, 2])).toBe('tier.2.start');
    expect(fieldFor('penalties.deny', [])).toBe('penalties.deny');
  });
});

import { describe, expect, it } from 'vitest';
import { profileFromForm } from './profile-form';

function form(entries: [string, string][]): FormData {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

describe('profileFromForm', () => {
  it('"does everything" is null skills; "only these" keeps the ticked categories', () => {
    expect(
      profileFromForm(
        form([
          ['skillsMode', 'all'],
          ['skill', 'a'],
        ]),
      ).skillCategoryIds,
    ).toBeNull();
    expect(
      profileFromForm(
        form([
          ['skillsMode', 'some'],
          ['skill', 'a'],
          ['skill', 'b'],
        ]),
      ).skillCategoryIds,
    ).toEqual(['a', 'b']);
    expect(profileFromForm(form([['skillsMode', 'some']])).skillCategoryIds).toEqual([]);
  });

  it('splits tags on commas and builds one restriction per ticked box', () => {
    const p = profileFromForm(
      form([
        ['tags', ' fast, design ,, gel-x'],
        ['r.no_kids', 'on'],
        ['r.min_client_age', 'on'],
        ['minAge', '12'],
        ['r.custom', 'on'],
        ['customNote', 'prefers mornings'],
      ]),
    );
    expect(p.tags).toEqual(['fast', 'design', 'gel-x']);
    expect(p.restrictions).toEqual([
      { type: 'no_kids', value: null, note: null },
      { type: 'min_client_age', value: 12, note: null },
      { type: 'custom', value: null, note: 'prefers mornings' },
    ]);
  });

  it('a word for the age is kept as not-a-number for the validator', () => {
    const p = profileFromForm(
      form([
        ['r.min_client_age', 'on'],
        ['minAge', 'ten'],
      ]),
    );
    expect(Number.isNaN(p.restrictions[0]?.value)).toBe(true);
  });
});

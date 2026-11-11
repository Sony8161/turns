import { describe, expect, it } from 'vitest';
import { walkInFromForm } from './form';

function form(entries: [string, string][]): FormData {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

describe('walkInFromForm', () => {
  it('reads services, the request, the client and the attributes', () => {
    const w = walkInFromForm(
      form([
        ['service', 'a'],
        ['service', 'b'],
        ['requestedTechnician', 't1'],
        ['note', 'in a hurry'],
        ['clientName', '  Lan '],
        ['clientPhone', '(813) 555-0100'],
        ['gender', 'male'],
        ['kid', 'on'],
        ['age', '9'],
        ['sameTime', 'on'],
      ]),
    );
    expect(w).toEqual({
      serviceIds: ['a', 'b'],
      requestedTechnicianId: 't1',
      note: 'in a hurry',
      client: { name: 'Lan', phone: '(813) 555-0100' },
      attributes: { gender: 'male', isKid: true, age: 9 },
      sameTime: true,
    });
  });

  it('"not asked" is null; blanks are null; a word for an age is kept as not-a-number', () => {
    const w = walkInFromForm(
      form([
        ['service', 'a'],
        ['gender', 'unspecified'],
        ['age', 'nine'],
      ]),
    );
    expect(w.attributes.gender).toBeNull();
    expect(w.attributes.isKid).toBe(false);
    expect(Number.isNaN(w.attributes.age)).toBe(true);
    expect(w.client).toEqual({ name: null, phone: null });
    expect(w.requestedTechnicianId).toBeNull();
    expect(w.sameTime).toBe(false);
    expect(walkInFromForm(form([['age', '']])).attributes.age).toBeNull();
  });
});

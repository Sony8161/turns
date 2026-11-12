import { describe, expect, it } from 'vitest';
import { groupFromForm, walkInFromForm } from './form';

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

  it('reads first and last name separately (v0.13.0)', () => {
    const w = walkInFromForm(
      form([
        ['service', 'a'],
        ['clientFirstName', ' Lan '],
        ['clientLastName', 'Nguyen'],
        ['clientPhone', ''],
      ]),
    );
    expect(w.client).toEqual({ firstName: 'Lan', lastName: 'Nguyen', phone: null });
  });
});

describe('v0.16.0: groupFromForm', () => {
  it('reads each person in the order added, skipping removed slots', () => {
    const people = groupFromForm(
      form([
        ['p0.firstName', 'Hana'],
        ['p0.lastName', ' Le '],
        ['p0.service', 'a'],
        ['p0.note', 'Pink'],
        ['p2.firstName', 'Ivy'],
        ['p2.phone', '813 555 0100'],
        ['p2.service', 'b'],
        ['p2.service', 'c'],
        ['p2.requestedTechnician', 't1'],
      ]),
    );
    expect(people).toEqual([
      {
        firstName: 'Hana',
        lastName: 'Le',
        phone: null,
        serviceIds: ['a'],
        requestedTechnicianId: null,
        note: 'Pink',
      },
      {
        firstName: 'Ivy',
        lastName: null,
        phone: '813 555 0100',
        serviceIds: ['b', 'c'],
        requestedTechnicianId: 't1',
        note: null,
      },
    ]);
  });

  it('keeps a person with services but no name, so the engine names the problem', () => {
    const people = groupFromForm(
      form([
        ['p0.firstName', ''],
        ['p0.service', 'a'],
      ]),
    );
    expect(people.map((p) => p.firstName)).toEqual(['']);
  });
});

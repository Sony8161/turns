import { describe, expect, it } from 'vitest';
import { techniciansFor } from '@turn/db/kiosk';
import { kioskFromForm, kioskGroupFromForm, techsFor, type KioskTech } from './form';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function fd(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

describe('kiosk form', () => {
  it('reads a simple check-in', () => {
    expect(
      kioskFromForm(
        fd([
          ['name', 'Lan'],
          ['phone', '813 555 0142'],
          ['service', A],
          ['gender', 'female'],
        ]),
      ),
    ).toEqual({
      ok: true,
      name: 'Lan',
      lastName: null,
      phone: '813 555 0142',
      serviceIds: [A],
      requestedTechnicianId: null,
      attributes: { gender: 'female', isKid: false, age: null },
      sameTime: false,
      note: null,
    });
  });

  it('needs at least one real service id, and at most six', () => {
    expect(kioskFromForm(fd([['name', 'x']]))).toEqual({ ok: false, reason: 'no_services' });
    expect(kioskFromForm(fd([['service', "1' or 1=1"]]))).toEqual({
      ok: false,
      reason: 'unknown_service',
    });
    const many = Array.from({ length: 7 }, (_, i) => ['service', `${A.slice(0, -1)}${i}`]) as [
      string,
      string,
    ][];
    expect(kioskFromForm(fd(many))).toEqual({ ok: false, reason: 'unknown_service' });
  });

  it('refuses a technician id that is not an id', () => {
    expect(
      kioskFromForm(
        fd([
          ['service', A],
          ['requestedTechnician', 'abc'],
        ]),
      ),
    ).toEqual({ ok: false, reason: 'unknown_technician' });
  });

  it('a kid with an age; an adult ignores the age box', () => {
    const kid = kioskFromForm(
      fd([
        ['service', A],
        ['who', 'kid'],
        ['age', '9'],
      ]),
    );
    expect(kid.ok && kid.attributes).toEqual({ gender: null, isKid: true, age: 9 });
    const adult = kioskFromForm(
      fd([
        ['service', A],
        ['age', '9'],
      ]),
    );
    expect(adult.ok && adult.attributes).toEqual({ gender: null, isKid: false, age: null });
    expect(
      kioskFromForm(
        fd([
          ['service', A],
          ['who', 'kid'],
          ['age', 'ten'],
        ]),
      ),
    ).toEqual({ ok: false, reason: 'bad_age' });
  });

  it('same time only with two services', () => {
    const one = kioskFromForm(
      fd([
        ['service', A],
        ['sameTime', 'on'],
      ]),
    );
    expect(one.ok && one.sameTime).toBe(false);
    const two = kioskFromForm(
      fd([
        ['service', A],
        ['service', B],
        ['sameTime', 'on'],
      ]),
    );
    expect(two.ok && two.sameTime).toBe(true);
  });

  it('reads the optional design or special request', () => {
    const withNote = kioskFromForm(
      fd([
        ['service', A],
        ['note', '  french tip, short  '],
      ]),
    );
    expect(withNote.ok && withNote.note).toBe('french tip, short');
    const blank = kioskFromForm(
      fd([
        ['service', A],
        ['note', '   '],
      ]),
    );
    expect(blank.ok && blank.note).toBe(null);
  });
});

// v0.15.0: the technician step lists only who does every chosen service.
describe('kiosk technician list', () => {
  const techs: KioskTech[] = [
    { id: 'gel', name: 'Linh', serviceIds: [A, B] },
    { id: 'reg', name: 'Vân', serviceIds: [A] },
    { id: 'all', name: 'Hoa', serviceIds: null },
  ];
  const names = (ids: string[]) => techsFor(techs, ids).map((t) => t.name);

  it('narrows to the chosen services; nobody until a service is chosen', () => {
    expect(names([])).toEqual([]);
    expect(names([A])).toEqual(['Linh', 'Vân', 'Hoa']);
    expect(names([B])).toEqual(['Linh', 'Hoa']);
    expect(names([A, B])).toEqual(['Linh', 'Hoa']);
    expect(names(['33333333-3333-4333-8333-333333333333'])).toEqual(['Hoa']);
  });

  it('is the same rule the check-in enforces on the server', () => {
    for (const ids of [[], [A], [B], [A, B]]) {
      expect(techsFor(techs, ids)).toEqual(techniciansFor(techs, ids));
    }
  });
});

describe('v0.16.0: the kiosk group form', () => {
  const group = (people: unknown, phone = '') =>
    fd([
      ['people', JSON.stringify(people)],
      ['phone', phone],
    ]);

  it('reads each person with their own services, technician and note, and one phone', () => {
    expect(
      kioskGroupFromForm(
        group(
          [
            { name: 'Lan', lastName: 'Ng', serviceIds: [A], requestedTechnicianId: B, note: 'Red' },
            { name: 'Mai', serviceIds: [A, B] },
          ],
          '813 555 0142',
        ),
      ),
    ).toEqual({
      ok: true,
      phone: '813 555 0142',
      people: [
        { name: 'Lan', lastName: 'Ng', serviceIds: [A], requestedTechnicianId: B, note: 'Red' },
        {
          name: 'Mai',
          lastName: null,
          serviceIds: [A, B],
          requestedTechnicianId: null,
          note: null,
        },
      ],
    });
  });

  it('refuses a person with no name or no service, odd ids, and more than eight people', () => {
    expect(kioskGroupFromForm(group([{ name: ' ', serviceIds: [A] }]))).toEqual({
      ok: false,
      reason: 'bad_name',
    });
    expect(kioskGroupFromForm(group([{ name: 'A', serviceIds: [] }]))).toEqual({
      ok: false,
      reason: 'no_services',
    });
    expect(kioskGroupFromForm(group([{ name: 'A', serviceIds: ["1' or 1=1"] }]))).toEqual({
      ok: false,
      reason: 'unknown_service',
    });
    expect(
      kioskGroupFromForm(group([{ name: 'A', serviceIds: [A], requestedTechnicianId: 'x' }])),
    ).toEqual({ ok: false, reason: 'unknown_technician' });
    const nine = Array.from({ length: 9 }, () => ({ name: 'A', serviceIds: [A] }));
    expect(kioskGroupFromForm(group(nine))).toEqual({ ok: false, reason: 'party_too_big' });
    expect(kioskGroupFromForm(fd([['people', '{not json']]))).toEqual({
      ok: false,
      reason: 'bad_name',
    });
  });
});

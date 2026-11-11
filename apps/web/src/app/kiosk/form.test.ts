import { describe, expect, it } from 'vitest';
import { kioskFromForm } from './form';

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
      phone: '813 555 0142',
      serviceIds: [A],
      requestedTechnicianId: null,
      attributes: { gender: 'female', isKid: false, age: null },
      sameTime: false,
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
});

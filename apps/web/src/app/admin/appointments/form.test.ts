// Done-when (REQ-0c2b89ef, Part 7): a time typed at the desk is the salon's
// wall-clock time, whatever the iPad's or the server's zone.
import { describe, expect, it } from 'vitest';
import { appointmentFromForm, salonInput, salonTime } from './form';

const NY = 'America/New_York';
const TECH = '7b1f3c2a-1d4e-4f5a-8b6c-9d0e1f2a3b4c';

function form(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

describe('salonTime', () => {
  it('reads the salon clock in standard and daylight time', () => {
    expect(salonTime('2026-11-12T10:30', NY)?.toISOString()).toBe('2026-11-12T15:30:00.000Z');
    expect(salonTime('2026-07-01T10:30', NY)?.toISOString()).toBe('2026-07-01T14:30:00.000Z');
  });

  it('round-trips through the input value', () => {
    const at = new Date('2026-11-12T15:30:00Z');
    expect(salonInput(at, NY)).toBe('2026-11-12T10:30');
    expect(salonTime(salonInput(at, NY), NY)?.toISOString()).toBe(at.toISOString());
  });

  it('refuses what is not a time', () => {
    for (const v of ['', 'tomorrow', '2026-13-01T10:00', '2026-11-12 10:00', '2026-11-12T25:00']) {
      expect(salonTime(v, NY), v).toBeNull();
    }
    expect(salonTime(null, NY)).toBeNull();
  });
});

describe('appointmentFromForm', () => {
  it('reads technician, start, minutes and an optional name', () => {
    const r = appointmentFromForm(
      form({ technicianId: TECH, start: '2026-11-12T10:00', minutes: '75', clientName: ' Lan ' }),
      NY,
    );
    expect(r).toEqual({
      ok: true,
      technicianId: TECH,
      startAt: new Date('2026-11-12T15:00:00Z'),
      endAt: new Date('2026-11-12T16:15:00Z'),
      clientName: 'Lan',
    });
  });

  it('says what is wrong', () => {
    expect(
      appointmentFromForm(
        form({ technicianId: 'x', start: '2026-11-12T10:00', minutes: '30' }),
        NY,
      ),
    ).toEqual({
      ok: false,
      error: 'unknown_technician',
    });
    expect(appointmentFromForm(form({ technicianId: TECH, start: '', minutes: '30' }), NY)).toEqual(
      {
        ok: false,
        error: 'bad_time',
      },
    );
    for (const minutes of ['', '0', '4', '721', '1.5', '-30', 'abc']) {
      expect(
        appointmentFromForm(form({ technicianId: TECH, start: '2026-11-12T10:00', minutes }), NY),
        minutes,
      ).toEqual({ ok: false, error: 'bad_minutes' });
    }
  });
});

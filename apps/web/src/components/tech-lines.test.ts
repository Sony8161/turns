import { describe, expect, it } from 'vitest';
import { dictionaries } from '@/i18n/dictionary';
import { lineText, signedPoints } from './tech-lines';

const en = dictionaries.en;
const line = (over: Partial<Parameters<typeof lineText>[0]>) => ({
  delta: 1,
  kind: 'visit' as const,
  services: ['Gel manicure'],
  source: 'walk_in' as const,
  note: null,
  at: new Date(0),
  ...over,
});

describe('tech card lines', () => {
  it('signs points with halves', () => {
    expect(signedPoints(1)).toBe('+1');
    expect(signedPoints(0.5)).toBe('+½');
    expect(signedPoints(-1)).toBe('−1');
    expect(signedPoints(1.5)).toBe('+1½');
  });

  it('says what each ledger row was', () => {
    const t = en.techBoard;
    const r = en.me.call.reasons;
    expect(lineText(line({}), t, r)).toBe('Gel manicure');
    expect(lineText(line({ source: 'appointment', delta: 0.5 }), t, r)).toBe(
      'Gel manicure (appointment: −½ included)',
    );
    expect(lineText(line({ kind: 'deny', note: 'break_needed', services: [] }), t, r)).toBe(
      'Denied a call: Need a break',
    );
    expect(lineText(line({ kind: 'late', note: '17 min late' }), t, r)).toBe('Late start, 17 min');
    expect(lineText(line({ kind: 'out_over', note: 'out over 60 min' }), t, r)).toBe(
      'Out longer than 60 min',
    );
    expect(lineText(line({ kind: 'excuse', delta: -1 }), t, r)).toBe('Deny excused by a manager');
  });
});

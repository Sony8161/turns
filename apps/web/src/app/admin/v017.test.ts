// v0.17.0 on the web side: plain words for what is new, in both languages.
import { readableParts } from '@turn/db/reports';
import { describe, expect, it } from 'vitest';
import { pointsWord } from '@/components/Board';
import { dictionaries, fill } from '@/i18n/dictionary';
import { formatReadable } from './log/readable';

const TECH = '22222222-2222-4222-8222-222222222222';

describe('"1 point", not "1 points" (leftover)', () => {
  it('reads in the singular only at one', () => {
    const en = dictionaries.en.board;
    expect(pointsWord(1, false, en)).toBe('1 point');
    expect(pointsWord(0, false, en)).toBe('0 points');
    expect(pointsWord(0, true, en)).toBe('00 points');
    expect(pointsWord(1.5, false, en)).toBe('1½ points');
    expect(pointsWord(1, false, dictionaries.vi.board)).toBe('1 điểm');
    expect(
      fill(dictionaries.en.log.queueLine, {
        n: 1,
        name: 'Linh',
        points: pointsWord(1, false, en),
        status: 'available',
      }),
    ).toBe('1. Linh: 1 point, available');
  });
});

describe('the log says who the desk acted for', () => {
  it('a call accepted for her names her, never an id', () => {
    const parts = readableParts(
      {
        action: 'call_accepted',
        entityType: 'turn_calls',
        entityId: null,
        before: null,
        after: { actedFor: TECH, by: 'desk' },
        responseSeconds: null,
      },
      { people: new Map([[TECH, 'Linh']]), services: new Map() },
    );
    const lines = formatReadable(parts, {
      t: dictionaries.en,
      timezone: 'America/New_York',
      lang: 'en',
      visits: new Map(),
    });
    expect(lines).toEqual(['Done for: Linh', 'Marked by: the desk']);
  });

  it('every new event has words in English and Vietnamese', () => {
    for (const a of [
      'client_left_claimed',
      'client_left_rejected',
      'left_without_service',
      'appointment_no_show',
      'visit_closed_day_end',
      'visit_auto_finished',
      'call_closed_day_end',
      'help_closed_day_end',
      'act_for_setting',
    ]) {
      expect((dictionaries.en.log.actions as Record<string, string>)[a]).toBeTruthy();
      expect((dictionaries.vi.log.actions as Record<string, string>)[a]).toBeTruthy();
    }
  });
});

describe('the slip says "is doing" until her part is finished (leftover)', () => {
  it('desk and phone wording', () => {
    expect(fill(dictionaries.en.desk.slipDoing, { name: 'Linh', services: 'Basic pedicure' })).toBe(
      'Linh is doing Basic pedicure',
    );
    expect(fill(dictionaries.en.desk.slipPart, { name: 'Linh', services: 'Basic pedicure' })).toBe(
      'Linh did Basic pedicure',
    );
    expect(dictionaries.vi.me.call.slipDoing).toContain('đang làm');
  });
});

describe('the kiosk pairing screen shows the real expiry (leftover)', () => {
  it('no fixed minutes left in the words', () => {
    for (const lang of ['en', 'vi'] as const) {
      const d = dictionaries[lang];
      expect(d.kioskAdmin.codeHint).toContain('{time}');
      expect(d.kioskAdmin.codeHint).not.toMatch(/15|\{minutes\}/);
      expect(d.kiosk.pairLead).not.toMatch(/15/);
      expect(d.kiosk.errors['bad_code']).not.toMatch(/15/);
    }
  });
});

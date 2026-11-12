import { describe, expect, it } from 'vitest';
import { dictionaries } from '@/i18n/dictionary';
import { formatReadable, visitIdsOf, type ReadableContext } from './readable';

const VISIT = '11111111-1111-4111-8111-111111111111';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const ctx = (lang: 'en' | 'vi', known = true): ReadableContext => ({
  t: dictionaries[lang],
  timezone: 'America/New_York',
  lang,
  visits: known
    ? new Map([[VISIT, { client: 'Jenny K.', services: ['Gel manicure', 'Spa pedicure'] }]])
    : new Map(),
});

describe('the log Details column in words (v0.16.1)', () => {
  it('a call reads as the client and services, never a raw id', () => {
    const lines = formatReadable(
      [
        { key: 'visit', value: { kind: 'visit', id: VISIT } },
        { key: 'response', value: { kind: 'seconds', n: 12 } },
      ],
      ctx('en'),
    );
    expect(lines).toEqual(['Client: Jenny K. · Gel manicure, Spa pedicure', 'Answered in: 12 s']);
    expect(lines.join(' ')).not.toMatch(UUID);
  });

  it('an unknown visit falls back to a short label, not its id', () => {
    const lines = formatReadable(
      [{ key: 'visit', value: { kind: 'visit', id: VISIT } }],
      ctx('en', false),
    );
    expect(lines).toEqual(['Client: a visit']);
  });

  it('changes read before → after, points with half points and signs', () => {
    const lines = formatReadable(
      [
        {
          key: 'points',
          value: { kind: 'points', n: 1.5 },
          was: { kind: 'points', n: 0.5 },
        },
        { key: 'change', value: { kind: 'points', n: 1, signed: true } },
        {
          key: 'status',
          value: { kind: 'code', group: 'status', code: 'break' },
          was: { kind: 'code', group: 'status', code: 'available' },
        },
        { key: 'reason_type', value: { kind: 'code', group: 'reason', code: 'visit' } },
      ],
      ctx('en'),
    );
    expect(lines).toEqual([
      'Points: ½ → 1½',
      'Change: +1',
      'Status: available → break',
      'For: a service',
    ]);
  });

  it('Vietnamese uses the Vietnamese labels', () => {
    const lines = formatReadable(
      [
        { key: 'visit', value: { kind: 'visit', id: VISIT } },
        { key: 'in_window', value: { kind: 'bool', value: true } },
      ],
      ctx('vi'),
    );
    expect(lines).toEqual(['Khách: Jenny K. · Gel manicure, Spa pedicure', 'Trong hạn sửa: có']);
  });

  it('collects every visit id once for the lookup', () => {
    expect(
      visitIdsOf([
        { readable: [{ key: 'visit', value: { kind: 'visit', id: VISIT } }] },
        { readable: [{ key: 'fix_of', value: { kind: 'visit', id: VISIT } }] },
      ]),
    ).toEqual([VISIT]);
  });
});

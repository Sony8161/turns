import { describe, expect, it } from 'vitest';
import { filterQuery, parseLogFilters } from './filters';

const NOW = new Date('2026-11-11T15:00:00Z');
const TZ = 'America/New_York';

describe('parseLogFilters', () => {
  it('defaults to today at the location', () => {
    expect(parseLogFilters({}, TZ, NOW)).toEqual({
      from: '2026-11-11',
      to: '2026-11-11',
      technicianId: null,
      action: null,
      clamped: false,
    });
  });

  it('swaps a backwards range and clamps one over 31 days', () => {
    expect(parseLogFilters({ from: '2026-11-10', to: '2026-11-01' }, TZ, NOW)).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-10',
      clamped: true,
    });
    expect(parseLogFilters({ from: '2026-01-01', to: '2026-11-10' }, TZ, NOW)).toMatchObject({
      from: '2026-10-11',
      to: '2026-11-10',
      clamped: true,
    });
  });

  it('drops a technician that is not an id and an action that is not known', () => {
    const f = parseLogFilters({ technician: "1' or 1=1", action: 'drop_table' }, TZ, NOW);
    expect(f.technicianId).toBeNull();
    expect(f.action).toBeNull();
    expect(parseLogFilters({ action: 'call_denied' }, TZ, NOW).action).toBe('call_denied');
  });

  it('round-trips through the CSV link', () => {
    const f = parseLogFilters(
      { from: '2026-11-01', to: '2026-11-05', action: 'call_sent' },
      TZ,
      NOW,
    );
    expect(
      parseLogFilters(Object.fromEntries(new URLSearchParams(filterQuery(f))), TZ, NOW),
    ).toEqual(f);
  });
});

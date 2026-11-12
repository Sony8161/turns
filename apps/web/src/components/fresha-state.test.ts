// Connect Fresha (v0.11.0): every way a link can fail reads as a sentence in
// both languages, and the state line never shows more than a time or an error.
import { describe, expect, it } from 'vitest';
import { dictionaries } from '@/i18n/dictionary';
import { stateLine } from './fresha-state';

// Every reason the db layer can give for a test or a save (checkFreshaUrl,
// safeFetchText, parseIcs, setFeed and the action's own).
const REASONS = [
  'not_fresha',
  'not_a_url',
  'not_https',
  'has_credentials',
  'bad_port',
  'too_long',
  'private_address',
  'dns_failed',
  'timeout',
  'connect_failed',
  'too_large',
  'http_401',
  'http_403',
  'http_404',
  'too_many_redirects',
  'bad_redirect',
  'not_a_calendar',
  'truncated',
  'read_failed',
  'too_many_events',
  'not_allowed',
  'unknown_technician',
  'no_feed',
  'too_many',
  'server',
];

describe('Connect Fresha strings', () => {
  it('names every failure in English and Vietnamese', () => {
    for (const lang of ['en', 'vi'] as const) {
      for (const r of REASONS) {
        expect({ lang, r, has: !!dictionaries[lang].fresha.errors[r] }).toEqual({
          lang,
          r,
          has: true,
        });
      }
    }
  });

  it('says what state a calendar is in', () => {
    const t = dictionaries.en.fresha;
    expect(stateLine(t, { kind: 'none' })).toBe('Not connected');
    expect(stateLine(t, { kind: 'never' })).toBe('Connected, not synced yet');
    expect(stateLine(t, { kind: 'ok', time: 'Thu 9:15 AM' })).toBe(
      'Connected, last synced Thu 9:15 AM',
    );
    expect(stateLine(t, { kind: 'stale', time: 'Thu 9:15 AM' })).toContain('no sync since');
    expect(stateLine(t, { kind: 'failing', error: 'Fresha did not answer' })).toBe(
      'Sync failing: Fresha did not answer',
    );
  });

  it('the log has a label for the new event in both languages', () => {
    expect(dictionaries.en.log.actions.feed_tested).toBeTruthy();
    expect(dictionaries.vi.log.actions.feed_tested).toBeTruthy();
  });
});

// v0.17.1 "Review fixes" on the web side: the small wording fixes and the
// new log events, in both languages.
import { readableParts } from '@turn/db/reports';
import { describe, expect, it } from 'vitest';
import { stateLine } from '@/components/fresha-state';
import { dictionaries, fill } from '@/i18n/dictionary';
import { calledText } from './called-text';
import { formatReadable } from './log/readable';

const ctx = (lang: 'en' | 'vi') => ({
  t: dictionaries[lang],
  timezone: 'America/New_York',
  lang,
  visits: new Map(),
});

describe('a call just made says "just now", not "no answer for 0:00"', () => {
  it('for the first minute, then the clock', () => {
    const en = dictionaries.en.desk;
    expect(calledText(en, 'turn', 'Linh', 0)).toBe('Linh called just now');
    expect(calledText(en, 'turn', 'Linh', 59)).toBe('Linh called just now');
    expect(calledText(en, 'turn', 'Linh', 60)).toBe('Linh called, no answer for 1:00');
    expect(calledText(en, 'offer', 'Hoa', 5)).toBe('Asked Hoa, just now');
    expect(calledText(en, 'desk_pick', 'Hoa', 125)).toBe('Picked Hoa, 2:05');
    expect(calledText(dictionaries.vi.desk, 'turn', 'Linh', 3)).toBe('Vừa gọi Linh');
  });
});

describe('Pick a tech: a tech held for her appointment says so', () => {
  it('"Held: 2:30 PM appt", not "available"', () => {
    expect(fill(dictionaries.en.desk.heldForAppt, { time: '2:30 PM' })).toBe('Held: 2:30 PM appt');
    expect(fill(dictionaries.vi.desk.heldForAppt, { time: '14:30' })).toContain('14:30');
  });
});

describe('client pages', () => {
  it('"1 visit", not "1 visits"', () => {
    expect(dictionaries.en.clients.visitsOne).toBe('1 visit');
    expect(fill(dictionaries.en.clients.visits, { n: 2 })).toBe('2 visits');
    expect(dictionaries.vi.clients.visitsOne).toBeTruthy();
  });
  it('the search asks for 4 digits or 3 letters', () => {
    expect(dictionaries.en.clients.tooShort).toContain('4 digits');
    expect(dictionaries.en.clients.tooShort).toContain('3 letters');
  });
});

describe("a technician's own Fresha link", () => {
  it('waiting for approval reads as such on her phone and the owner card', () => {
    expect(stateLine(dictionaries.en.fresha, { kind: 'pending' })).toBe(
      'Waiting for the owner or a manager to approve',
    );
    expect(stateLine(dictionaries.vi.fresha, { kind: 'pending' })).toBeTruthy();
  });
  it('every choice and refusal has words in both languages', () => {
    for (const lang of ['en', 'vi'] as const) {
      const f = dictionaries[lang].fresha;
      for (const c of ['owner_approves', 'name_must_match', 'open'])
        expect(f.techLinks[c]).toBeTruthy();
      for (const e of ['calendar_name', 'not_pending', 'bad_value'])
        expect(f.errors[e]).toBeTruthy();
    }
  });
  it('the setting reads in words in the log, with no link', () => {
    const parts = readableParts(
      {
        action: 'tech_calendar_links_setting',
        entityType: 'locations',
        entityId: null,
        before: { techCalendarLinks: 'owner_approves' },
        after: { techCalendarLinks: 'open' },
        responseSeconds: null,
      },
      { people: new Map(), services: new Map() },
    );
    expect(formatReadable(parts, ctx('en'))).toEqual([
      "Technicians' own calendar links: the owner or a manager approves it first → used right away",
    ]);
  });
});

describe('the log has words for every new event', () => {
  it('in English and Vietnamese', () => {
    for (const a of [
      'client_phone_shown',
      'feed_approved',
      'feed_declined',
      'tech_calendar_links_setting',
    ]) {
      expect((dictionaries.en.log.actions as Record<string, string>)[a]).toBeTruthy();
      expect((dictionaries.vi.log.actions as Record<string, string>)[a]).toBeTruthy();
    }
  });
});

describe('the rules page', () => {
  it('says a fix is always 0', () => {
    expect(dictionaries.en.rules.fixAlwaysZero).toBe('0 points, always');
    expect(dictionaries.en.rules.servicesLead).toContain('A nail fix is always 0');
  });
});

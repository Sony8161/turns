// v0.18.0 "Simplify the desk": the board's words and choices, and the nav
// by role. Pure: the components get these from model.ts and nav-model.ts.
import { describe, expect, it } from 'vitest';
import { moreItemsFor, tabOf, tabsFor } from '@/components/nav-model';
import { dictionaries, fill } from '@/i18n/dictionary';
import {
  categoryLabel,
  firstCallable,
  floorStatus,
  groupTiles,
  nextLine,
  notHereAction,
  pickOptions,
  rowTitle,
  tileGroup,
  timeText,
  type QueueEntry,
} from './floor/model';

const en = dictionaries.en.floor;
const vi = dictionaries.vi.floor;

describe('four tabs, and More by role (B13, C4)', () => {
  it('every desk role gets Board, Appointments, Clients, More; a technician none', () => {
    for (const r of ['owner', 'manager', 'receptionist'] as const) {
      expect(tabsFor(r)).toEqual(['board', 'appointments', 'clients', 'more']);
    }
    expect(tabsFor('technician')).toEqual([]);
  });
  it('More holds only what the role may open', () => {
    expect(moreItemsFor('owner')).toEqual(['reports', 'team', 'rules', 'devices']);
    // A manager cannot change rules: levels by turn instead.
    expect(moreItemsFor('manager')).toEqual(['reports', 'team', 'levels', 'devices']);
    // A receptionist sees nothing she could not see before: More is sign out and language.
    expect(moreItemsFor('receptionist')).toEqual([]);
    expect(moreItemsFor('technician')).toEqual([]);
  });
  it('the old pages live under More', () => {
    for (const p of ['staff', 'rules', 'manage', 'log', 'reports', 'kiosk', 'levels'] as const) {
      expect(tabOf(p)).toBe('more');
    }
    expect(tabOf('board')).toBe('board');
    expect(tabOf('clients')).toBe('clients');
  });
});

describe('one set of status words (B3) and labelled times (B4)', () => {
  it('a tech held for her appointment never reads "available"', () => {
    expect(floorStatus('available', true)).toBe('held');
    expect(floorStatus('available', false, 'appointment_soon')).toBe('held');
    expect(floorStatus('available', false, 'available')).toBe('available');
    expect(floorStatus('called', false)).toBe('called');
    expect(floorStatus('in_service', false)).toBe('in_service');
    expect(en.status.held).toBe('Held for appointment');
    for (const s of ['available', 'held', 'called', 'in_service', 'break', 'out']) {
      expect(en.status[s]).toBeTruthy();
      expect(vi.status[s]).toBeTruthy();
    }
    expect(
      ['available', 'held', 'called', 'in_service', 'break', 'out'].map((s) => en.status[s]),
    ).toEqual(['Available', 'Held for appointment', 'Called', 'With client', 'Break', 'Out']);
  });
  it('times say what they are', () => {
    expect(timeText(en, 'available', 64)).toBe('free 64 min');
    expect(timeText(en, 'available', 0)).toBe('free just now');
    expect(timeText(en, 'called', 0)).toBe('called just now');
    expect(timeText(en, 'called', 3)).toBe('called 3 min');
    expect(timeText(en, 'in_service', 12)).toBe('with client 12 min');
    expect(timeText(en, 'break', 5)).toBe('on break 5 min');
    expect(timeText(en, 'out', 72, { over: true, limit: 60 })).toBe('out 72 min, over 60');
    expect(timeText(en, 'held', 0, { heldAt: '2:30 PM' })).toBe('appt 2:30 PM');
    expect(timeText(vi, 'available', 64)).toContain('64');
  });
});

describe('who is next (B2)', () => {
  it('"Next: Vân", or nobody and why in a few words', () => {
    expect(nextLine(en, 'Vân', []).title).toBe('Next: Vân');
    expect(nextLine(en, null, [])).toEqual({ title: en.nobodyNext, why: en.nobodyCheckedIn });
    const why = nextLine(en, null, [
      { status: 'in_service' },
      { status: 'in_service' },
      { status: 'break' },
      { status: 'held' },
    ]).why;
    expect(why).toBe('2 with a client, 1 held for an appointment, 1 on break');
  });
});

describe('client rows (B9, C2)', () => {
  it('titled by the person, then the service, then the wait', () => {
    expect(
      rowTitle(en, { clientName: 'Thu P.', kioskName: null, services: ['Gel manicure'] }, 13).title,
    ).toBe('Thu P. · Gel manicure · 13 min');
    expect(
      rowTitle(en, { clientName: null, kioskName: null, services: ['Gel manicure'] }, null).title,
    ).toBe('Walk-in · Gel manicure');
    expect(
      rowTitle(en, { clientName: null, kioskName: 'Jenny T.', services: ['A', 'B'] }, 0).title,
    ).toBe('Jenny T. · A + B · just now');
  });
  it('one "Client isn\'t here", sent to the same action as before by where the visit stands', () => {
    expect(notHereAction({ status: 'waiting', needsConfirm: true })).toBe('kiosk_decline');
    expect(notHereAction({ status: 'waiting', needsConfirm: false })).toBe('walked_out');
    expect(notHereAction({ status: 'called', needsConfirm: false })).toBe('client_left');
    // Her own "client left" waits for the desk: those two buttons, not this one.
    expect(
      notHereAction({ status: 'called', needsConfirm: false, leftClaimPending: true }),
    ).toBeNull();
    expect(notHereAction({ status: 'in_service', needsConfirm: false })).toBeNull();
    expect(en.notHere).toBe("Client isn't here");
  });
  it('"Call next" acts on the first client who can be called by turn', () => {
    const base = {
      status: 'waiting',
      needsConfirm: false,
      needsApproval: false,
      deskPicks: false,
      held: null,
      hold: null,
    };
    const rows = [
      { ...base, id: 'kiosk', needsConfirm: true },
      { ...base, id: 'fix', needsApproval: true },
      { ...base, id: 'art', deskPicks: true },
      { ...base, id: 'hold', hold: {} },
      { ...base, id: 'part', held: {} },
      { ...base, id: 'called', status: 'called' },
      { ...base, id: 'plain' },
      { ...base, id: 'later' },
    ];
    expect(firstCallable(rows)?.id).toBe('plain');
    expect(firstCallable(rows.slice(0, 6))).toBeUndefined();
  });
});

describe('the walk-in tiles (B7)', () => {
  const s = (id: string, name: string, category: string, extra = {}) => ({
    id,
    name,
    category,
    ...extra,
  });
  const menu = [
    s('1', 'Basic manicure', 'manicure'),
    s('2', 'Gel manicure', 'manicure'),
    s('3', 'Basic pedicure', 'pedicure'),
    s('4', 'Gel fill', 'fill', { isFillOrFullSet: true }),
    s('5', 'Gel-X full set', 'full_set', { isFillOrFullSet: true }),
    s('6', 'Nail art / design', 'manicure', { deskPicks: true }),
    s('7', 'Nail fix / repair', 'manicure', { deskPicks: true, isFix: true }),
    s('8', 'Acrylic fill', 'fill', { isFillOrFullSet: true }),
  ];
  it('Hands, Feet, Enhancements, Add-ons; a fix has its own choice', () => {
    expect(menu.map((m) => tileGroup(m))).toEqual([
      'hands',
      'hands',
      'feet',
      'enhancements',
      'enhancements',
      'addons',
      'fix',
      'enhancements',
    ]);
  });
  it('most used first over the last 30 days, ties by name; empty groups left out', () => {
    const g = groupTiles(menu, { '2': 9, '1': 3, '5': 4 });
    expect(g.map((x) => x.group)).toEqual(['hands', 'feet', 'enhancements', 'addons']);
    expect(g[0]!.services.map((x) => x.name)).toEqual(['Gel manicure', 'Basic manicure']);
    expect(g[2]!.services.map((x) => x.name)).toEqual([
      'Gel-X full set',
      'Acrylic fill',
      'Gel fill',
    ]);
    expect(groupTiles(menu.slice(0, 2), {}).map((x) => x.group)).toEqual(['hands']);
  });
  it('never shows a raw code like full_set', () => {
    for (const lang of ['en', 'vi'] as const) {
      const labels = dictionaries[lang].floor.category;
      for (const c of ['manicure', 'pedicure', 'fill', 'full_set']) {
        expect(categoryLabel(c, labels)).not.toMatch(/_/);
      }
    }
    expect(categoryLabel('full_set', en.category)).toBe('Full set');
    expect(categoryLabel('nail_care', en.category)).toBe('nail care');
  });
});

describe('one "Pick someone" sheet (C1, B12)', () => {
  const q = (name: string, eligible: boolean, why: string, extra: Partial<QueueEntry> = {}) => ({
    technicianId: name,
    displayName: name,
    eligible,
    why,
    skilled: true,
    ...extra,
  });
  const clock = () => '2:30 PM';

  it('by turn: the first free tech is "next by turn", suggested, and Call sends callNext', () => {
    const o = pickOptions(
      en,
      {
        deskPicks: false,
        originalTechnicianId: null,
        queue: [
          q('Thảo', false, 'appointment_soon', { appointmentAt: '2026-11-13T19:30:00Z' }),
          q('Hoa', false, 'in_service'),
          q('Vân', true, 'available'),
          q('Mai', true, 'available'),
          q('Linh', false, 'not_by_turn'),
          q('Tâm', false, 'no_skill', { skilled: false }),
        ],
      },
      { canReassign: false, clock },
    );
    expect(o.map((x) => x.name)).toEqual(['Thảo', 'Hoa', 'Vân', 'Mai', 'Linh']);
    expect(o.find((x) => x.name === 'Vân')).toMatchObject({
      label: 'next by turn',
      action: 'call_next',
      suggested: true,
    });
    expect(o.find((x) => x.name === 'Thảo')).toMatchObject({
      label: 'held for 2:30 PM appt',
      action: null,
    });
    expect(o.find((x) => x.name === 'Hoa')).toMatchObject({ label: 'with a client', action: null });
    // A receptionist cannot send someone out of turn: greyed with why.
    expect(o.find((x) => x.name === 'Mai')).toMatchObject({
      label: 'after Vân by turn',
      action: null,
    });
    // A higher level is not asked while someone gets it by turn.
    expect(o.find((x) => x.name === 'Linh')).toMatchObject({
      label: 'higher level; Vân is free by turn',
      action: null,
    });
  });

  it('owners and managers can send a free tech out of turn (reassign, with a reason)', () => {
    const o = pickOptions(
      en,
      {
        deskPicks: false,
        originalTechnicianId: null,
        queue: [q('Vân', true, 'available'), q('Mai', true, 'available')],
      },
      { canReassign: true, clock },
    );
    expect(o[1]).toMatchObject({ name: 'Mai', action: 'reassign', suggested: false });
  });

  it('nobody free by turn: a higher level can be asked and can say no', () => {
    const o = pickOptions(
      en,
      {
        deskPicks: false,
        originalTechnicianId: null,
        queue: [q('Hoa', false, 'in_service'), q('Linh', false, 'not_by_turn')],
      },
      { canReassign: false, clock },
    );
    expect(o[1]).toMatchObject({
      label: 'higher level, can say no',
      action: 'offer',
      suggested: true,
    });
  });

  it('a desk-pick service: anyone free who does it; the tech who did the original work first', () => {
    const o = pickOptions(
      en,
      {
        deskPicks: true,
        originalTechnicianId: 'Mai',
        queue: [
          q('Vân', true, 'available'),
          q('Mai', true, 'available'),
          q('Hoa', false, 'already_called'),
          q('Linh', false, 'no_male_clients'),
        ],
      },
      { canReassign: false, clock },
    );
    expect(o.find((x) => x.name === 'Mai')).toMatchObject({
      label: 'did the original work',
      action: 'desk_pick',
      suggested: true,
    });
    expect(o.find((x) => x.name === 'Vân')).toMatchObject({
      action: 'desk_pick',
      suggested: false,
    });
    expect(o.find((x) => x.name === 'Hoa')).toMatchObject({
      label: 'waiting for her answer',
      action: null,
    });
    expect(o.find((x) => x.name === 'Linh')).toMatchObject({
      label: 'no male clients',
      action: null,
    });
    // The original tech with a call open: still named, greyed, not suggested.
    const busy = pickOptions(
      en,
      {
        deskPicks: true,
        originalTechnicianId: 'Hoa',
        queue: [q('Vân', true, 'available'), q('Hoa', false, 'already_called')],
      },
      { canReassign: false, clock },
    );
    expect(busy[1]).toMatchObject({
      label: 'did the original work; waiting for her answer',
      action: null,
      suggested: false,
    });
    expect(busy[0]).toMatchObject({ name: 'Vân', suggested: true });
  });
});

describe('words', () => {
  it('no screen says "engine"', () => {
    const leaves = (o: unknown): string[] =>
      typeof o === 'string'
        ? [o]
        : typeof o === 'object' && o
          ? Object.values(o).flatMap(leaves)
          : [];
    for (const lang of ['en', 'vi'] as const) {
      expect(leaves(dictionaries[lang]).filter((x) => /\bengine\b/i.test(x))).toEqual([]);
    }
  });
  it('the board strings exist in both languages', () => {
    expect(fill(vi.next, { name: 'Vân' })).toContain('Vân');
    expect(vi.walkIn).toBeTruthy();
    expect(vi.toCheckOut).toBeTruthy();
    expect(dictionaries.vi.nav.more).toBeTruthy();
  });
  it('the checkout is never called "Paid"', () => {
    expect(en.checkedOut).toBe('Checked out');
    expect(JSON.stringify(en)).not.toMatch(/\bPaid\b/);
  });
});

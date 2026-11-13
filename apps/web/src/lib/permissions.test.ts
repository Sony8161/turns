// The roles table as Duong set it on 2026-11-04 is a test matrix.
import { describe, expect, it } from 'vitest';
import { allowedWith, can, canInvite, type Capability } from './permissions';

type Role = 'owner' | 'manager' | 'receptionist' | 'technician';
const ROLES: Role[] = ['owner', 'manager', 'receptionist', 'technician'];

const O = { owner: true, manager: false, receptionist: false, technician: false };
const OM = { owner: true, manager: true, receptionist: false, technician: false };
const OMR = { owner: true, manager: true, receptionist: true, technician: false };
const T = { owner: false, manager: false, receptionist: false, technician: true };
const NOBODY = { owner: false, manager: false, receptionist: false, technician: false };

const TABLE: Record<Capability, Record<Role, boolean>> = {
  manage_rules: O,
  manage_locations: O,
  invite_staff: OM,
  // v0.17.1: receptionists while the owner's switch is on (the server checks
  // it with allowedAt; @turn/db test v0171 holds the switch side).
  edit_technicians: OMR,
  manage_levels: OM,
  view_board: OMR,
  enter_walkins: OMR,
  call_technician: OMR,
  override_queue: OM,
  reassign_visit: OM,
  adjust_points: OMR,
  archive_records: OM,
  view_archived: OM,
  message_technicians: OM,
  view_audit: OM,
  export_data: O,
  manage_kiosks: OM,
  // v0.16.0 (Duong): a receptionist's fix waits for a manager or owner.
  approve_fixes: OM,
  // v0.17.1: a technician's own Fresha link waits for one of these.
  approve_calendar_links: OM,
  // v0.17.1: receptionists see the last four digits and tap Show (audited).
  // v0.18.0 (Duong, 2026-11-13): receptionists too, while the owner's switch is on.
  see_client_phone: OMR,
  // v0.17.0: the desk accepts, denies and finishes for a technician. A
  // receptionist only while the owner's switch is on (act-for.ts checks it).
  act_for_technician: OMR,
  technician_actions: T,
  view_own_schedule: T,
  delete_records: NOBODY,
};

describe('can()', () => {
  for (const [capability, row] of Object.entries(TABLE) as [Capability, Record<Role, boolean>][]) {
    for (const role of ROLES) {
      it(`${role} ${row[role] ? 'can' : 'cannot'} ${capability}`, () => {
        expect(can(role, capability)).toBe(row[role]);
      });
    }
  }
});

describe('principles', () => {
  it('nobody can delete; archiving is the only removal', () => {
    for (const r of ROLES) expect(can(r, 'delete_records')).toBe(false);
    expect(can('owner', 'archive_records')).toBe(true);
  });
  it('receptionists run the queue, and what the owner switches allow', () => {
    const allowed = (Object.keys(TABLE) as Capability[]).filter((c) => can('receptionist', c));
    // v0.17.0: answering a call or finishing for a tech is part of running the
    // queue. v0.17.1: the table now says what the owner's two switches allow
    // (both on by default); with a switch off, allowedWith says no.
    expect(allowed.sort()).toEqual([
      'act_for_technician',
      'adjust_points',
      'call_technician',
      'edit_technicians',
      'enter_walkins',
      'see_client_phone',
      'view_board',
    ]);
  });
  it("a receptionist's switched rights follow the owner's switches", () => {
    const on = {
      receptionistEditsTechnicians: true,
      receptionistActsForTechnicians: true,
      receptionistSeesClientPhone: true,
    };
    const off = {
      receptionistEditsTechnicians: false,
      receptionistActsForTechnicians: false,
      receptionistSeesClientPhone: false,
    };
    for (const c of [
      'edit_technicians',
      'adjust_points',
      'act_for_technician',
      // v0.18.0 (Duong, 2026-11-13): the whole client phone, on by default.
      'see_client_phone',
    ] as const) {
      expect(allowedWith('receptionist', c, on)).toBe(true);
      expect(allowedWith('receptionist', c, off)).toBe(false);
      expect(allowedWith('manager', c, off)).toBe(true);
      expect(allowedWith('technician', c, on)).toBe(false);
    }
    expect(
      allowedWith('receptionist', 'adjust_points', { ...off, receptionistEditsTechnicians: true }),
    ).toBe(true);
    expect(
      allowedWith('receptionist', 'act_for_technician', {
        ...off,
        receptionistEditsTechnicians: true,
      }),
    ).toBe(false);
  });
  it('the client phone switch is its own: the other two do not open it', () => {
    const off = {
      receptionistEditsTechnicians: true,
      receptionistActsForTechnicians: true,
      receptionistSeesClientPhone: false,
    };
    expect(allowedWith('receptionist', 'see_client_phone', off)).toBe(false);
    expect(allowedWith('owner', 'see_client_phone', off)).toBe(true);
    expect(allowedWith('manager', 'see_client_phone', off)).toBe(true);
    expect(
      allowedWith('technician', 'see_client_phone', { ...off, receptionistSeesClientPhone: true }),
    ).toBe(false);
  });
  it('technicians never see the board or the archive', () => {
    expect(can('technician', 'view_board')).toBe(false);
    expect(can('technician', 'view_archived')).toBe(false);
  });
});

describe('canInvite()', () => {
  it('owner invites every role', () => {
    for (const r of ROLES) expect(canInvite('owner', r)).toBe(true);
  });
  it('manager invites managers and below, never an owner', () => {
    expect(canInvite('manager', 'owner')).toBe(false);
    expect(canInvite('manager', 'manager')).toBe(true);
    expect(canInvite('manager', 'receptionist')).toBe(true);
    expect(canInvite('manager', 'technician')).toBe(true);
  });
  it('receptionists and technicians invite nobody', () => {
    for (const r of ROLES) {
      expect(canInvite('receptionist', r)).toBe(false);
      expect(canInvite('technician', r)).toBe(false);
    }
  });
});

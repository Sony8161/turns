// The roles table as Duong set it on 2026-11-04 is a test matrix.
import { describe, expect, it } from 'vitest';
import { can, canInvite, type Capability } from './permissions';

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
  edit_technicians: OM,
  view_board: OMR,
  enter_walkins: OMR,
  call_technician: OMR,
  override_queue: OM,
  reassign_visit: OM,
  adjust_points: OM,
  archive_records: OM,
  view_archived: OM,
  message_technicians: OM,
  view_audit: OM,
  export_data: O,
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
  it('receptionists only run the queue', () => {
    const allowed = (Object.keys(TABLE) as Capability[]).filter((c) => can('receptionist', c));
    expect(allowed.sort()).toEqual(['call_technician', 'enter_walkins', 'view_board']);
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

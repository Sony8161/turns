// Done-when (REQ-a5e7a172): the design doc's permissions table is a test matrix.
import { describe, expect, it } from 'vitest';
import { can, canInvite, type Capability } from './permissions';

type Role = 'owner' | 'manager' | 'receptionist' | 'technician';
const ROLES: Role[] = ['owner', 'manager', 'receptionist', 'technician'];

// Rows copied from "Roles and permissions" in Turn System Design Doc.md.
const DOC: Record<Capability, Record<Role, boolean>> = {
  manage_rules: { owner: true, manager: false, receptionist: false, technician: false },
  edit_technicians: { owner: true, manager: true, receptionist: false, technician: false },
  view_board: { owner: true, manager: true, receptionist: true, technician: false },
  enter_walkins: { owner: true, manager: true, receptionist: true, technician: false },
  override_queue: { owner: true, manager: true, receptionist: false, technician: false },
  message_technicians: { owner: true, manager: true, receptionist: true, technician: false },
  technician_actions: { owner: false, manager: false, receptionist: false, technician: true },
  view_audit: { owner: true, manager: true, receptionist: false, technician: false },
  export_data: { owner: true, manager: false, receptionist: false, technician: false },
};

describe('can()', () => {
  for (const [capability, row] of Object.entries(DOC) as [Capability, Record<Role, boolean>][]) {
    for (const role of ROLES) {
      it(`${role} ${row[role] ? 'can' : 'cannot'} ${capability}`, () => {
        expect(can(role, capability)).toBe(row[role]);
      });
    }
  }
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

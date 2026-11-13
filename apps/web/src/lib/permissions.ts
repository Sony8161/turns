// Roles and what each may do. Set by Duong on 2026-11-04; one place, so every
// page and action asks the same question. The test is the table itself.
//
// Principles:
//   - Nothing is deleted, only archived. No role has a delete right.
//   - Owners do everything. Managers run the floor and the staff, see archived
//     records and their location's audit log, but do not change salon rules or
//     export. Receptionists only run the queue. Technicians only see their own
//     day: calls, appointments, points; they accept, deny (with the penalty
//     shown first) and mark a service finished.
import type { Role } from '@turn/db/invites';

export type Capability =
  | 'manage_rules' // salon rules and settings
  | 'manage_locations'
  | 'invite_staff'
  | 'edit_technicians' // skills, services, tags, restrictions, status overrides
  | 'view_board'
  | 'enter_walkins'
  | 'call_technician'
  | 'override_queue' // excuse a deny, skip, re-order
  | 'reassign_visit' // move a visit to another technician (called wrong, appointment, client issue)
  | 'adjust_points'
  | 'archive_records'
  | 'view_archived'
  | 'message_technicians'
  | 'view_audit' // managers: own location only, enforced by scoping
  | 'export_data'
  | 'manage_kiosks' // pair, re-pair and revoke the customer check-in iPads (Part 9)
  | 'approve_fixes' // v0.16.0: approve or decline a nail fix a receptionist entered
  | 'act_for_technician' // v0.17.0: accept, deny, finish for a tech (receptionist: owner switch)
  | 'technician_actions' // own status, accept, deny, finish
  | 'view_own_schedule' // own calls and upcoming appointments
  | 'delete_records'; // nobody, on purpose

const TABLE: Record<Capability, readonly Role[]> = {
  manage_rules: ['owner'],
  manage_locations: ['owner'],
  invite_staff: ['owner', 'manager'],
  edit_technicians: ['owner', 'manager'],
  view_board: ['owner', 'manager', 'receptionist'],
  enter_walkins: ['owner', 'manager', 'receptionist'],
  call_technician: ['owner', 'manager', 'receptionist'],
  override_queue: ['owner', 'manager'],
  reassign_visit: ['owner', 'manager'],
  adjust_points: ['owner', 'manager'],
  archive_records: ['owner', 'manager'],
  view_archived: ['owner', 'manager'],
  message_technicians: ['owner', 'manager'],
  view_audit: ['owner', 'manager'],
  export_data: ['owner'],
  manage_kiosks: ['owner', 'manager'],
  approve_fixes: ['owner', 'manager'],
  // v0.17.0: the most a role may have. A receptionist also needs the owner's
  // switch on (Staff page, default on); @turn/db/act-for checks it next to
  // the write, as tech-settings does for edits.
  act_for_technician: ['owner', 'manager', 'receptionist'],
  technician_actions: ['technician'],
  view_own_schedule: ['technician'],
  delete_records: [],
};

export function can(role: Role, capability: Capability): boolean {
  return TABLE[capability].includes(role);
}

/** Owners invite anyone; managers invite managers and below; nobody else invites. */
export function canInvite(actor: Role, target: Role): boolean {
  if (actor === 'owner') return true;
  if (actor === 'manager') return target !== 'owner';
  return false;
}

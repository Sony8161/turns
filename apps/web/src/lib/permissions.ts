// The roles table from Turn System Design Doc.md, as code. One place, so every
// page and action asks the same question. The test is the table itself.
import type { Role } from '@turn/db/invites';

export type Capability =
  | 'manage_rules'
  | 'edit_technicians'
  | 'view_board'
  | 'enter_walkins'
  | 'override_queue'
  | 'message_technicians'
  | 'technician_actions'
  | 'view_audit'
  | 'export_data';

const TABLE: Record<Capability, readonly Role[]> = {
  manage_rules: ['owner'],
  edit_technicians: ['owner', 'manager'],
  view_board: ['owner', 'manager', 'receptionist'], // technicians see own position only
  enter_walkins: ['owner', 'manager', 'receptionist'],
  override_queue: ['owner', 'manager'],
  message_technicians: ['owner', 'manager', 'receptionist'],
  technician_actions: ['technician'],
  view_audit: ['owner', 'manager'], // manager: own location, enforced by scoping
  export_data: ['owner'],
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

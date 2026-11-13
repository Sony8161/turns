// Roles and what each may do (Duong, 2026-11-04). One table, shared by the
// web app (which pages and buttons show) and the server functions here (which
// writes are allowed), so the two can never disagree (v0.17.1).
//
// Principles:
//   - Nothing is deleted, only archived. No role has a delete right.
//   - Owners do everything. Managers run the floor and the staff, see archived
//     records and their location's audit log, but do not change salon rules or
//     export. Receptionists run the queue, and, while the owner leaves the
//     switches on (Staff page, both on by default), change a technician's
//     status, points, skills and restrictions, and accept, deny and finish for
//     her. Technicians only see their own day.
//
// `can` is the most a role may ever have. A receptionist's switched rights
// also need the location's switch: `allowedAt` checks both, and every server
// function that writes such a change calls it next to the write.
import { eq } from 'drizzle-orm';
import type { Role } from './invites';
import { locations } from './schema';
import type { Db } from './server';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type Capability =
  | 'manage_rules' // salon rules and settings
  | 'manage_locations'
  | 'invite_staff'
  | 'edit_technicians' // a tech's status today, skills, tags, restrictions (receptionist: switch)
  | 'manage_levels' // v0.17.1: skill levels and the services each level gets
  | 'view_board'
  | 'enter_walkins'
  | 'call_technician'
  | 'override_queue' // excuse a deny, skip, re-order
  | 'reassign_visit' // move a visit to another technician (called wrong, appointment, client issue)
  | 'adjust_points' // add or remove points with a reason (receptionist: switch)
  | 'archive_records'
  | 'view_archived'
  | 'message_technicians'
  | 'view_audit' // managers: own location only, enforced by scoping
  | 'export_data'
  | 'manage_kiosks' // pair, re-pair and revoke the customer check-in iPads (Part 9)
  | 'approve_fixes' // v0.16.0: approve or decline a nail fix a receptionist entered
  | 'approve_calendar_links' // v0.17.1: approve or decline a tech's own Fresha link
  | 'see_client_phone' // v0.17.1: the full phone; others see the last 4 and "Show"
  | 'act_for_technician' // v0.17.0: accept, deny, finish for a tech (receptionist: switch)
  | 'technician_actions' // own status, accept, deny, finish
  | 'view_own_schedule' // own calls and upcoming appointments
  | 'delete_records'; // nobody, on purpose

export const ROLE_TABLE: Record<Capability, readonly Role[]> = {
  manage_rules: ['owner'],
  manage_locations: ['owner'],
  invite_staff: ['owner', 'manager'],
  edit_technicians: ['owner', 'manager', 'receptionist'],
  manage_levels: ['owner', 'manager'],
  view_board: ['owner', 'manager', 'receptionist'],
  enter_walkins: ['owner', 'manager', 'receptionist'],
  call_technician: ['owner', 'manager', 'receptionist'],
  override_queue: ['owner', 'manager'],
  reassign_visit: ['owner', 'manager'],
  adjust_points: ['owner', 'manager', 'receptionist'],
  archive_records: ['owner', 'manager'],
  view_archived: ['owner', 'manager'],
  message_technicians: ['owner', 'manager'],
  view_audit: ['owner', 'manager'],
  export_data: ['owner'],
  manage_kiosks: ['owner', 'manager'],
  approve_fixes: ['owner', 'manager'],
  approve_calendar_links: ['owner', 'manager'],
  see_client_phone: ['owner', 'manager'],
  act_for_technician: ['owner', 'manager', 'receptionist'],
  technician_actions: ['technician'],
  view_own_schedule: ['technician'],
  delete_records: [],
};

/** The owner's switches (Staff page) a receptionist's right depends on. */
export const RECEPTIONIST_SWITCH = {
  edit_technicians: 'receptionistEditsTechnicians',
  adjust_points: 'receptionistEditsTechnicians',
  act_for_technician: 'receptionistActsForTechnicians',
} as const;

type Switched = keyof typeof RECEPTIONIST_SWITCH;
const isSwitched = (c: Capability): c is Switched => c in RECEPTIONIST_SWITCH;

/** The most this role may ever do. Pages use it for what to show; a
 *  receptionist's switched rights also need `allowedAt`. */
export function can(role: Role, capability: Capability): boolean {
  return ROLE_TABLE[capability].includes(role);
}

export type Switches = {
  receptionistEditsTechnicians: boolean;
  receptionistActsForTechnicians: boolean;
};

/** The two switches of one location (both off when the location is unknown). */
export async function switchesAt(db: Db | Tx, locationId: string): Promise<Switches> {
  const [row] = await db
    .select({
      receptionistEditsTechnicians: locations.receptionistEditsTechnicians,
      receptionistActsForTechnicians: locations.receptionistActsForTechnicians,
    })
    .from(locations)
    .where(eq(locations.id, locationId));
  return row ?? { receptionistEditsTechnicians: false, receptionistActsForTechnicians: false };
}

/** The role table and the location's switches together. Pure. */
export function allowedWith(role: Role, capability: Capability, switches: Switches): boolean {
  if (!can(role, capability)) return false;
  if (role !== 'receptionist' || !isSwitched(capability)) return true;
  return switches[RECEPTIONIST_SWITCH[capability]];
}

/** May this person do this here, right now? The one server-side check. */
export async function allowedAt(
  db: Db | Tx,
  actor: { role: Role; locationId: string },
  capability: Capability,
): Promise<boolean> {
  if (!can(actor.role, capability)) return false;
  if (actor.role !== 'receptionist' || !isSwitched(capability)) return true;
  return allowedWith(actor.role, capability, await switchesAt(db, actor.locationId));
}

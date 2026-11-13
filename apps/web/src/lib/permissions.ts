// Roles and what each may do. Set by Duong on 2026-11-04. v0.17.1: the table
// itself lives in @turn/db/permissions, so the pages here and the server
// functions there read one source; the test is the table itself.
//
// `can` is the most a role may ever have. A receptionist's switched rights
// (edit technicians, adjust points, act for a technician) also need the
// owner's switch: the server checks it next to every write (`allowedAt`), and
// pages ask `allowedAt` too before they show the button.
import type { Role } from '@turn/db/invites';
export { allowedAt, allowedWith, can, type Capability } from '@turn/db/permissions';

/** Owners invite anyone; managers invite managers and below; nobody else invites. */
export function canInvite(actor: Role, target: Role): boolean {
  if (actor === 'owner') return true;
  if (actor === 'manager') return target !== 'owner';
  return false;
}

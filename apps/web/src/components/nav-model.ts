// v0.18.0 (B13, C4): four tabs, Board, Appointments, Clients, More; the rest
// lives under More, each item only for the roles that may open it. Pure, so
// the test pins what each role sees. Every page still checks on its own.
import type { Role } from '@turn/db/invites';
import { can } from '@turn/db/permissions';

export type Tab = 'board' | 'appointments' | 'clients' | 'more';

export const TAB_HREF: Record<Tab, string> = {
  board: '/admin',
  appointments: '/admin/appointments',
  clients: '/admin/clients',
  more: '/admin/more',
};

/** The pages before v0.18.0, and the tab each one lives under now. */
export type Page = Tab | 'staff' | 'rules' | 'manage' | 'log' | 'reports' | 'kiosk' | 'levels';

export function tabOf(page: Page): Tab {
  return page === 'board' || page === 'appointments' || page === 'clients' ? page : 'more';
}

/** Technicians have no admin tabs (they use /me). */
export function tabsFor(role: Role): Tab[] {
  if (!can(role, 'view_board')) return [];
  return ['board', 'appointments', 'clients', 'more'];
}

export type MoreItem = 'reports' | 'team' | 'rules' | 'levels' | 'devices';

export const MORE_HREF: Record<MoreItem, string> = {
  reports: '/admin/reports',
  team: '/admin/staff',
  rules: '/admin/rules',
  levels: '/admin/levels',
  devices: '/admin/kiosk',
};

/** What "More" holds for a role. Reports and history = Reports + the Log;
 *  Team = Staff (each tech's level on her page); Services and rules = Rules
 *  with levels by turn (a manager, who cannot change rules, gets levels by
 *  turn alone); Devices = the kiosks. A receptionist gets none of them. */
export function moreItemsFor(role: Role): MoreItem[] {
  const out: MoreItem[] = [];
  if (can(role, 'view_audit')) out.push('reports');
  if (can(role, 'invite_staff')) out.push('team');
  if (can(role, 'manage_rules')) out.push('rules');
  else if (can(role, 'manage_levels')) out.push('levels');
  if (can(role, 'manage_kiosks')) out.push('devices');
  return out;
}

import Link from 'next/link';
import type { Dictionary } from '@/i18n/dictionary';
import { LocationSwitch } from './LocationSwitch';

type Item = { href: string; label: string };

/** Admin navigation (design plan: Board, Staff, Rules, Log, Settings; Part 6
 *  adds Overrides). Only the pages this role may open are listed; each page
 *  checks again on its own. */
export function AdminNav({
  t,
  current,
  canStaff,
  canRules,
  canManage = false,
  canAppointments = true,
  canLog = false,
  canKiosk,
  canClients,
}: {
  t: Dictionary['nav'];
  current:
    | 'board'
    | 'staff'
    | 'rules'
    | 'manage'
    | 'appointments'
    | 'clients'
    | 'log'
    | 'reports'
    | 'kiosk';
  canStaff: boolean;
  canRules: boolean;
  canManage?: boolean;
  /** Every staff role that sees the board sees appointments (Part 7). */
  canAppointments?: boolean;
  /** Owners and managers: the audit log and reports (Part 8). */
  canLog?: boolean;
  /** Owners and managers: the check-in iPads (Part 9). Same roles as staff by default. */
  canKiosk?: boolean;
  /** Owner, managers, the front desk: client search (v0.13.0). Same as appointments by default. */
  canClients?: boolean;
}) {
  const items: Item[] = [{ href: '/admin', label: t.board }];
  if (canAppointments) items.push({ href: '/admin/appointments', label: t.appointments });
  if (canClients ?? canAppointments) items.push({ href: '/admin/clients', label: t.clients });
  if (canManage) items.push({ href: '/admin/manage', label: t.manage });
  if (canStaff) items.push({ href: '/admin/staff', label: t.staff });
  if (canRules) items.push({ href: '/admin/rules', label: t.rules });
  if (canKiosk ?? canStaff) items.push({ href: '/admin/kiosk', label: t.kiosk });
  if (canLog) {
    items.push({ href: '/admin/log', label: t.log });
    items.push({ href: '/admin/reports', label: t.reports });
  }
  const active = {
    board: '/admin',
    staff: '/admin/staff',
    rules: '/admin/rules',
    manage: '/admin/manage',
    appointments: '/admin/appointments',
    clients: '/admin/clients',
    log: '/admin/log',
    reports: '/admin/reports',
    kiosk: '/admin/kiosk',
  }[current];
  return (
    <nav aria-label="Admin" className="flex flex-wrap items-center gap-2">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={i.href === active ? 'page' : undefined}
          className={`inline-flex min-h-11 items-center rounded-control px-4 font-semibold ${
            i.href === active ? 'bg-navy text-board' : 'text-slate hover:bg-board'
          }`}
        >
          {i.label}
        </Link>
      ))}
      <LocationSwitch t={t} />
    </nav>
  );
}

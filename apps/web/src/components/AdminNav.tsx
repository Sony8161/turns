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
}: {
  t: Dictionary['nav'];
  current: 'board' | 'staff' | 'rules' | 'manage' | 'appointments' | 'log' | 'reports';
  canStaff: boolean;
  canRules: boolean;
  canManage?: boolean;
  /** Every staff role that sees the board sees appointments (Part 7). */
  canAppointments?: boolean;
  /** Owners and managers: the audit log and reports (Part 8). */
  canLog?: boolean;
}) {
  const items: Item[] = [{ href: '/admin', label: t.board }];
  if (canAppointments) items.push({ href: '/admin/appointments', label: t.appointments });
  if (canManage) items.push({ href: '/admin/manage', label: t.manage });
  if (canStaff) items.push({ href: '/admin/staff', label: t.staff });
  if (canRules) items.push({ href: '/admin/rules', label: t.rules });
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
    log: '/admin/log',
    reports: '/admin/reports',
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

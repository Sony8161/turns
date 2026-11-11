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
}: {
  t: Dictionary['nav'];
  current: 'board' | 'staff' | 'rules' | 'manage' | 'appointments';
  canStaff: boolean;
  canRules: boolean;
  canManage?: boolean;
  /** Every staff role that sees the board sees appointments (Part 7). */
  canAppointments?: boolean;
}) {
  const items: Item[] = [{ href: '/admin', label: t.board }];
  if (canAppointments) items.push({ href: '/admin/appointments', label: t.appointments });
  if (canManage) items.push({ href: '/admin/manage', label: t.manage });
  if (canStaff) items.push({ href: '/admin/staff', label: t.staff });
  if (canRules) items.push({ href: '/admin/rules', label: t.rules });
  const active = {
    board: '/admin',
    staff: '/admin/staff',
    rules: '/admin/rules',
    manage: '/admin/manage',
    appointments: '/admin/appointments',
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

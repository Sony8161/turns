// The audit viewer's filters, read from the URL. Pure, so the page and the CSV
// download read them the same way and show the same rows (REQ-4114d3aa).
// The location is never in here: it comes from the verified session (T10).
import { AUDIT_ACTIONS, AUDIT_MAX_DAYS, localDate, parseDate } from '@turn/db/reports';

export type LogFilters = {
  from: string;
  to: string;
  technicianId: string | null;
  action: string | null;
  /** The range asked for was too long or backwards; it was clamped. */
  clamped: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function parseLogFilters(
  params: Record<string, string | string[] | undefined>,
  timezone: string,
  now = new Date(),
): LogFilters {
  const today = localDate(now, timezone);
  let to = parseDate(one(params['to'])) ?? today;
  let from = parseDate(one(params['from'])) ?? to;
  let clamped = false;
  if (from > to) {
    [from, to] = [to, from];
    clamped = true;
  }
  if (from < addDays(to, -(AUDIT_MAX_DAYS - 1))) {
    from = addDays(to, -(AUDIT_MAX_DAYS - 1));
    clamped = true;
  }
  const tech = one(params['technician']);
  const action = one(params['action']);
  return {
    from,
    to,
    technicianId: tech && UUID.test(tech) ? tech : null,
    action: action && (AUDIT_ACTIONS as readonly string[]).includes(action) ? action : null,
    clamped,
  };
}

/** The same filters as a query string, for the CSV link. Pure. */
export function filterQuery(f: LogFilters): string {
  const q = new URLSearchParams({ from: f.from, to: f.to });
  if (f.technicianId) q.set('technician', f.technicianId);
  if (f.action) q.set('action', f.action);
  return q.toString();
}

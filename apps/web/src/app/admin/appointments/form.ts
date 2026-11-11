// Reads the appointment form. The desk types a wall-clock time at the salon
// (an <input type="datetime-local">), which means the location's time zone,
// not the iPad's and not the server's.
import { zonedToUtc } from '@turn/db/feeds';
import { uuidOf } from '@/lib/ids';

export type AppointmentForm =
  | { ok: true; technicianId: string; startAt: Date; endAt: Date; clientName: string | null }
  | { ok: false; error: string };

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** "2026-11-12T10:30" at the salon, as an instant; null when it is not one. */
export function salonTime(value: unknown, timezone: string): Date | null {
  const m = typeof value === 'string' ? value.match(LOCAL) : null;
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const at = zonedToUtc(y, mo, d, h, mi, 0, timezone);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The same instant written back for a datetime-local field at the salon. */
export function salonInput(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const n = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${n('year')}-${n('month')}-${n('day')}T${n('hour')}:${n('minute')}`;
}

export function appointmentFromForm(formData: FormData, timezone: string): AppointmentForm {
  const technicianId = uuidOf(formData.get('technicianId'));
  if (!technicianId) return { ok: false, error: 'unknown_technician' };
  const startAt = salonTime(formData.get('start'), timezone);
  if (!startAt) return { ok: false, error: 'bad_time' };
  const minutesRaw = String(formData.get('minutes') ?? '').trim();
  const minutes = /^\d{1,3}$/.test(minutesRaw) ? Number(minutesRaw) : NaN;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 720) {
    return { ok: false, error: 'bad_minutes' };
  }
  const name = String(formData.get('clientName') ?? '').trim();
  return {
    ok: true,
    technicianId,
    startAt,
    endAt: new Date(startAt.getTime() + minutes * 60_000),
    clientName: name ? name.slice(0, 120) : null,
  };
}

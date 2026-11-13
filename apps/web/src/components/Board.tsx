import type { Dictionary } from '@/i18n/dictionary';

export type BoardStatus = 'checked_in' | 'available' | 'called' | 'in_service' | 'break' | 'out';

export type BoardRow = {
  id: string;
  name: string;
  /** Points as the ledger sums them. Display turns 0.5 into ½. */
  points: number;
  /** True when the last visit was an appointment at equal points (shows 00). */
  hadAppointmentLast?: boolean;
  status: BoardStatus;
  /** Service for called or in_service rows. */
  service?: string;
  /** Seconds in the current status, or seconds a call has waited. */
  seconds: number;
};

// Status colour, always paired with the status word (never colour alone).
const BAR: Record<BoardStatus, string> = {
  checked_in: 'bg-pumice',
  available: 'bg-teal',
  called: 'bg-polish',
  in_service: 'bg-slate',
  break: 'bg-amber',
  out: 'bg-amber',
};

export function splitPoints(
  points: number,
  hadAppointmentLast = false,
): { whole: string; half: boolean } {
  const safe = Math.max(0, points);
  if (safe === 0) return { whole: hadAppointmentLast ? '00' : '0', half: false };
  const whole = Math.floor(safe);
  return { whole: whole === 0 ? '' : String(whole), half: safe - whole >= 0.5 };
}

/** Plain-text form for labels and tests: 0, 00, ½, 1, 1½. */
export function formatPoints(points: number, hadAppointmentLast = false): string {
  const { whole, half } = splitPoints(points, hadAppointmentLast);
  return half ? `${whole}½` : whole;
}

/** v0.17.0: "1 point", "2 points", "00 points" (Vietnamese has one form). Pure. */
export function pointsWord(
  points: number,
  hadAppointmentLast: boolean,
  t: { pointOne: string; pointMany: string },
): string {
  const n = formatPoints(points, hadAppointmentLast);
  return (n === '1' ? t.pointOne : t.pointMany).replace('{n}', n);
}

/** Whole seconds since a timestamp, never negative. Kept out of component
 *  bodies so the render stays pure. */
export function secondsSince(at: Date | null | undefined): number {
  if (!at) return 0;
  return Math.max(0, Math.floor((Date.now() - at.getTime()) / 1000));
}

export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** The half sits beside the whole number at a smaller size; the font's own ½
 *  glyph is as tall as a digit and crowds the row. */
function Points({ points, hadAppointmentLast }: { points: number; hadAppointmentLast?: boolean }) {
  const { whole, half } = splitPoints(points, hadAppointmentLast);
  return (
    <>
      {whole}
      {half ? (
        <span className="relative -top-[0.22em] inline-block">
          <span className="text-[0.55em]">½</span>
        </span>
      ) : null}
    </>
  );
}

/**
 * The turn board. One column in queue order; the left bar is the status.
 * Sized for an iPad in landscape read from across the room.
 */
export function Board({
  rows,
  t,
  compact = false,
}: {
  rows: BoardRow[];
  t: Dictionary;
  compact?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="bg-board px-8 py-16 text-center text-lead text-slate/70">{t.board.empty}</p>
    );
  }
  return (
    <ol className="bg-board">
      {rows.map((row) => {
        const right =
          row.status === 'called'
            ? `${t.board.waiting} ${formatClock(row.seconds)}`
            : row.status === 'break' || row.status === 'out'
              ? `${t.board.backIn} ${formatClock(row.seconds)}`
              : formatClock(row.seconds);
        const statusText = row.service
          ? `${t.board.status[row.status]}, ${row.service}`
          : t.board.status[row.status];
        return (
          <li
            key={row.id}
            className={`board-row flex items-center gap-6 border-b border-pumice ${compact ? 'py-2 pr-4' : 'py-4 pr-8'}`}
          >
            <span
              aria-hidden
              className={`self-stretch ${compact ? 'w-2' : 'w-3'} ${BAR[row.status]}`}
            />
            <span
              className={`points w-[1.4em] text-right text-slate ${compact ? 'text-[56px]' : ''}`}
            >
              <span aria-hidden>
                <Points points={row.points} hadAppointmentLast={row.hadAppointmentLast} />
              </span>
              <span className="sr-only">
                {formatPoints(row.points, row.hadAppointmentLast)} {t.board.points}
              </span>
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={`truncate font-semibold ${compact ? 'text-heading' : 'text-name'}`}>
                {row.name}
              </span>
              <span
                className={`${compact ? 'text-body' : 'text-status'} font-medium text-slate/80`}
              >
                {statusText}
              </span>
            </span>
            <span
              className={`${compact ? 'text-body' : 'text-status'} font-medium ${row.status === 'called' ? 'text-polish' : 'text-slate/70'}`}
            >
              {right}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

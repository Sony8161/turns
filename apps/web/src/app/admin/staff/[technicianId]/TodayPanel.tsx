'use client';

import { useActionState } from 'react';
import { formatPoints } from '@/components/Board';
import { ErrorRef } from '@/components/ErrorRef';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { techTodayAction, type TodayState } from './today-actions';

type Move = 'checked_in' | 'available' | 'break' | 'out' | 'off';

/** Which moves the desk can make from a status (status.ts TRANSITIONS; in
 *  service is the engine's). */
const MOVES: Record<string, Move[]> = {
  off: ['checked_in'],
  checked_in: ['available', 'off'],
  available: ['break', 'out', 'off'],
  in_service: [],
  break: ['available', 'off'],
  out: ['available', 'off'],
};

/** Today, for one technician: status buttons and a points adjustment with a
 *  reason (v0.13.0). Every press is audited with who did it. */
export function TodayPanel({
  technicianId,
  name,
  status,
  points,
  hadAppointmentLast,
  t,
  board,
}: {
  technicianId: string;
  name: string;
  status: string;
  points: number;
  hadAppointmentLast: boolean;
  t: Dictionary['techSettings'];
  board: Dictionary['board'];
}) {
  const [state, action, pending] = useActionState<TodayState, FormData>(techTodayAction, {});
  const moves = MOVES[status] ?? [];
  const field = 'min-h-12 rounded-control border-2 border-slate/30 bg-board px-3 text-lead';
  return (
    <section className="flex flex-col gap-4 bg-board p-5" aria-labelledby="today">
      <h2 id="today" className="text-heading font-semibold">
        {t.todayTitle}
      </h2>
      <p className="text-lead">
        {fill(t.statusLine, {
          name,
          status: board.status[status as keyof typeof board.status] ?? status,
          points: formatPoints(points, hadAppointmentLast),
        })}
      </p>
      {state.done ? (
        <p role="status" className="font-semibold text-teal">
          {state.done === 'status' ? t.statusSaved : t.adjustSaved}
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="font-semibold text-polish">
          {t.errors[state.error] ?? t.errors.server}
          <ErrorRef refId={state.ref} />
        </p>
      ) : null}

      <form action={action} className="flex flex-col gap-2">
        <input type="hidden" name="technicianId" value={technicianId} />
        <input type="hidden" name="intent" value="status" />
        <span className="font-medium">{t.setStatus}</span>
        {moves.length === 0 ? (
          <span className="text-slate/80">{t.inServiceNote}</span>
        ) : (
          <div className="flex flex-wrap gap-2">
            {moves.map((to) => (
              <Button key={to} type="submit" name="to" value={to} tone="quiet" disabled={pending}>
                {t.moves[to]}
              </Button>
            ))}
          </div>
        )}
      </form>

      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="technicianId" value={technicianId} />
        <input type="hidden" name="intent" value="adjust" />
        <span className="font-medium">{t.adjustTitle}</span>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-small font-medium">{t.delta}</span>
            <select name="delta" defaultValue="0.5" className={`${field} w-32`}>
              {['-2', '-1.5', '-1', '-0.5', '0.5', '1', '1.5', '2'].map((d) => (
                <option key={d} value={d}>
                  {Number(d) > 0 ? `+${formatPoints(Number(d))}` : `−${formatPoints(-Number(d))}`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
            <span className="text-small font-medium">{t.reason}</span>
            <input name="reason" required maxLength={300} className={field} />
          </label>
          <Button type="submit" disabled={pending}>
            {t.adjust}
          </Button>
        </div>
      </form>
    </section>
  );
}

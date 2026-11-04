'use client';

import { useActionState } from 'react';
import { formatClock } from '@/components/Board';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { callNextFor, enterWalkIn, type DeskState } from './actions';

type Service = { id: string; name: string; category: string };
type Waiting = {
  id: string;
  status: string;
  services: string[];
  waitSeconds: number;
  calledTechnician: string | null;
  calledSeconds: number | null;
  requestedTechnician: string | null;
  note: string | null;
};

/** The front desk: enter a walk-in, see who is waiting, call the next technician. */
export function Desk({
  services,
  technicians,
  waiting,
  t,
}: {
  services: Service[];
  technicians: { id: string; name: string }[];
  waiting: Waiting[];
  t: Dictionary['desk'];
}) {
  const [entry, enter, entering] = useActionState<DeskState, FormData>(enterWalkIn, {});
  const [callState, call, calling] = useActionState<DeskState, FormData>(callNextFor, {});

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <form action={enter} className="flex flex-col gap-4 bg-board p-5">
        <h2 className="text-heading font-semibold">{t.walkIn}</h2>
        <p className="text-slate/80">{t.pickServices}</p>
        <div className="flex flex-col gap-2">
          {services.map((s) => (
            <label key={s.id} className="flex min-h-11 items-center gap-3 text-lead">
              <input type="checkbox" name="service" value={s.id} className="h-6 w-6" />
              <span>{s.name}</span>
              <span className="text-small text-slate/60">{s.category}</span>
            </label>
          ))}
        </div>
        <label className="flex flex-col gap-2">
          <span className="font-medium">{t.requestedTech}</span>
          <select
            name="requestedTechnician"
            className="min-h-12 rounded-control border-2 border-slate/30 bg-board px-3 text-lead"
          >
            <option value="">{t.anyTech}</option>
            {technicians.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-2">
          <span className="font-medium">{t.note}</span>
          <textarea
            name="note"
            maxLength={300}
            rows={2}
            placeholder={t.notePlaceholder}
            className="rounded-control border-2 border-slate/30 bg-board px-3 py-2 text-lead"
          />
        </label>
        {entry.error ? <p className="text-polish">{t.errors[entry.error] ?? entry.error}</p> : null}
        <Button type="submit" disabled={entering}>
          {t.addWalkIn}
        </Button>
      </form>

      <section className="flex flex-col gap-3">
        <h2 className="text-heading font-semibold">{t.waiting}</h2>
        {waiting.length === 0 ? <p className="text-slate/70">{t.nobodyWaiting}</p> : null}
        {callState.error ? (
          <p className="text-polish">
            {t.errors[callState.error] ?? callState.error}
            {callState.detail ? ` (${callState.detail})` : ''}
          </p>
        ) : null}
        <ol className="flex flex-col gap-2">
          {waiting.map((v) => (
            <li key={v.id} className="flex items-center gap-4 bg-board px-4 py-3">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold">
                  {v.services.join(', ')}
                  {v.requestedTechnician
                    ? ` · ${fill(t.forTech, { name: v.requestedTechnician })}`
                    : ''}
                </span>
                {v.note ? <span className="text-small text-slate/80">{v.note}</span> : null}
                <span className="text-small text-slate/70">
                  {v.status === 'called' && v.calledTechnician
                    ? fill(t.calledLine, {
                        name: v.calledTechnician,
                        time: formatClock(v.calledSeconds ?? 0),
                      })
                    : v.status === 'in_service'
                      ? t.inService
                      : fill(t.waitingLine, { time: formatClock(v.waitSeconds) })}
                </span>
              </span>
              {v.status === 'waiting' ? (
                <form action={call}>
                  <input type="hidden" name="visitId" value={v.id} />
                  <Button type="submit" disabled={calling}>
                    {t.callNext}
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

'use client';

import { ErrorRef } from '@/components/ErrorRef';
import { useActionState } from 'react';
import { formatPoints } from '@/components/Board';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { skipText } from '../chips';
import { manageAction, type ManageState } from './actions';

export type OpenVisit = {
  id: string;
  status: string;
  services: string[];
  holder: string | null;
  chips: string[];
};
export type Penalty = {
  ledgerId: string;
  technicianName: string;
  points: number;
  kind: 'deny' | 'out_over' | 'late';
  note: string | null;
  excused: boolean;
};
export type OnShift = { id: string; name: string; points: number };

const DELTAS = ['-2', '-1.5', '-1', '-0.5', '0.5', '1', '1.5', '2'] as const;

/** Reassign, excuse, adjust: every form needs a reason; the server checks the
 *  role and the location again. */
export function ManagePanel({
  visits,
  penalties,
  technicians,
  t,
  skip,
}: {
  visits: OpenVisit[];
  penalties: Penalty[];
  technicians: OnShift[];
  t: Dictionary['manage'];
  skip: Dictionary['desk']['skip'];
}) {
  const [state, action, pending] = useActionState<ManageState, FormData>(manageAction, {});
  const field = 'min-h-11 rounded-control border-2 border-slate/30 bg-board px-3';
  const message = state.error ? (
    <p className="text-polish">
      {fill(t.errors[state.error] ?? state.error, {
        detail: state.skipped?.[0]
          ? skipText(state.skipped[0], skip)
          : (skip[state.detail ?? ''] ?? state.detail ?? ''),
      })}
      <ErrorRef refId={state.ref} />
    </p>
  ) : state.done ? (
    <p className="font-semibold text-teal">{t.done[state.done]}</p>
  ) : null;

  return (
    <div className="flex flex-col gap-8">
      {message}

      <section className="flex flex-col gap-3">
        <h2 className="text-heading font-semibold">{t.visits}</h2>
        {visits.length === 0 ? <p className="text-slate/70">{t.noVisits}</p> : null}
        <ol className="flex flex-col gap-2">
          {visits.map((v) => (
            <li key={v.id} className="flex flex-col gap-3 bg-board px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-lead font-semibold">{v.services.join(', ')}</span>
                <span className="text-slate/80">
                  {v.holder ? `${v.status}, ${v.holder}` : v.status}
                </span>
                {v.chips.map((c) => (
                  <span key={c} className="rounded-control bg-pumice px-2 py-0.5 text-small">
                    {c}
                  </span>
                ))}
              </div>
              <form action={action} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="intent" value="reassign" />
                <input type="hidden" name="visitId" value={v.id} />
                <label className="flex flex-col gap-1">
                  <span className="text-small font-medium">{t.reassign}</span>
                  <select name="technicianId" required defaultValue="" className={field}>
                    <option value="">{t.pickTech}</option>
                    {technicians.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name} ({formatPoints(x.points)})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-small font-medium">{t.reason}</span>
                  <input name="reason" required maxLength={300} className={`${field} w-56`} />
                </label>
                <label className="flex min-h-11 items-center gap-2">
                  <input type="checkbox" name="penalizeFirst" className="h-5 w-5" />
                  <span className="text-small">{t.penalizeFirst}</span>
                </label>
                <label className="flex min-h-11 items-center gap-2">
                  <input type="checkbox" name="force" className="h-5 w-5" />
                  <span className="text-small">{t.force}</span>
                </label>
                <Button type="submit" tone="quiet" disabled={pending}>
                  {t.reassignButton}
                </Button>
              </form>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-heading font-semibold">{t.penalties}</h2>
        {penalties.length === 0 ? <p className="text-slate/70">{t.noPenalties}</p> : null}
        <ol className="flex flex-col gap-2">
          {penalties.map((p) => (
            <li
              key={p.ledgerId}
              className={`flex flex-wrap items-end gap-3 bg-board px-4 py-3 ${p.excused ? 'opacity-70' : ''}`}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold">
                  {fill(t.penaltyLine, {
                    name: p.technicianName,
                    points: formatPoints(p.points),
                    kind: t.penalty[p.kind] ?? p.kind,
                  })}
                </span>
                {p.note ? <span className="text-small text-slate/70">{p.note}</span> : null}
              </span>
              {p.excused ? (
                <span className="font-semibold text-teal">{t.excused}</span>
              ) : (
                <form action={action} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="intent" value="excuse" />
                  <input type="hidden" name="ledgerId" value={p.ledgerId} />
                  <label className="flex flex-col gap-1">
                    <span className="text-small font-medium">{t.reason}</span>
                    <input name="reason" required maxLength={300} className={`${field} w-56`} />
                  </label>
                  <Button type="submit" tone="quiet" disabled={pending}>
                    {t.excuse}
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-heading font-semibold">{t.adjust}</h2>
        <p className="text-slate/80">{t.adjustLead}</p>
        <ol className="flex flex-col gap-2">
          {technicians.map((x) => (
            <li key={x.id} className="flex flex-wrap items-end gap-3 bg-board px-4 py-3">
              <span className="min-w-40 text-lead font-semibold">
                {x.name} · {formatPoints(x.points)}
              </span>
              <form action={action} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="intent" value="adjust" />
                <input type="hidden" name="technicianId" value={x.id} />
                <label className="flex flex-col gap-1">
                  <span className="text-small font-medium">{t.delta}</span>
                  <select name="delta" defaultValue="0.5" className={field}>
                    {DELTAS.map((d) => (
                      <option key={d} value={d}>
                        {Number(d) > 0 ? `+${d}` : d}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-small font-medium">{t.reason}</span>
                  <input name="reason" required maxLength={300} className={`${field} w-56`} />
                </label>
                <Button type="submit" tone="quiet" disabled={pending}>
                  {t.adjustButton}
                </Button>
              </form>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

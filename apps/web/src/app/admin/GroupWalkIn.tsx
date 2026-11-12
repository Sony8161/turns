'use client';

// v0.16.0: the desk's "A group" walk-in. People are added one at a time: first
// name (required), last name and phone (optional), their own services,
// technician and request note. One submit makes one visit per person, linked
// by a party id; each is called by turn on its own.
import { useActionState, useState } from 'react';
import { ErrorRef } from '@/components/ErrorRef';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { enterGroup, type DeskState } from './actions';

type Service = { id: string; name: string; category: string; isFix?: boolean };

export function GroupWalkIn({
  t,
  services,
  technicians,
  max,
}: {
  t: Dictionary['desk'];
  services: Service[];
  technicians: { id: string; name: string }[];
  /** The rules' most people in one group. */
  max: number;
}) {
  const [state, action, pending] = useActionState<DeskState, FormData>(enterGroup, {});
  // Slot numbers, so a removed person's fields go with them.
  const [slots, setSlots] = useState<number[]>([0, 1]);
  const [round, setRound] = useState(0);
  // A group was added: start over with two empty people. Done while
  // rendering when the answer changes (React: adjusting state on a prop
  // change), not in an effect.
  const [seen, setSeen] = useState(state.done);
  if (seen !== state.done) {
    setSeen(state.done);
    if (state.done) {
      setSlots([0, 1]);
      setRound((r) => r + 1);
    }
  }
  const field = 'min-h-12 rounded-control border-2 border-slate/30 bg-board px-3 text-lead';
  // A fix is entered on its own (one client), never in a group.
  const menu = services.filter((s) => !s.isFix);

  return (
    <form key={round} action={action} className="flex flex-col gap-4">
      <p className="text-slate/80">{fill(t.groupLead, { max })}</p>
      {slots.map((slot, i) => (
        <fieldset key={slot} className="flex flex-col gap-3 border-t-4 border-pumice pt-3">
          <legend className="flex w-full items-center justify-between gap-3 font-semibold">
            <span>{fill(t.groupPerson, { n: i + 1 })}</span>
          </legend>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-small font-medium">{t.groupFirstName}</span>
              <input
                name={`p${slot}.firstName`}
                required
                maxLength={60}
                className={`${field} w-40`}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-small font-medium">{t.clientLastName}</span>
              <input name={`p${slot}.lastName`} maxLength={60} className={`${field} w-40`} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-small font-medium">{t.clientPhone}</span>
              <input
                name={`p${slot}.phone`}
                inputMode="tel"
                maxLength={32}
                className={`${field} w-44`}
              />
            </label>
          </div>
          <div className="grid gap-1 sm:grid-cols-2">
            {menu.map((s) => (
              <label key={s.id} className="flex min-h-11 items-center gap-3">
                <input type="checkbox" name={`p${slot}.service`} value={s.id} className="h-6 w-6" />
                <span>{s.name}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-small font-medium">{t.requestedTech}</span>
              <select name={`p${slot}.requestedTechnician`} className={field}>
                <option value="">{t.anyTech}</option>
                {technicians.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-small font-medium">{t.note}</span>
              <input name={`p${slot}.note`} maxLength={300} className={`${field} min-w-48`} />
            </label>
          </div>
          {slots.length > 2 ? (
            <Button
              type="button"
              tone="quiet"
              className="w-fit"
              onClick={() => setSlots((s) => s.filter((x) => x !== slot))}
            >
              {t.groupRemove}
            </Button>
          ) : null}
        </fieldset>
      ))}
      {slots.length < max ? (
        <Button
          type="button"
          tone="quiet"
          className="w-fit"
          onClick={() => setSlots((s) => [...s, Math.max(...s) + 1])}
        >
          {t.groupAdd}
        </Button>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-polish">
          {state.detail ? `${fill(t.groupPerson, { n: state.detail })}: ` : ''}
          {t.errors[state.error] ?? state.error}
          <ErrorRef refId={state.ref} />
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {fill(t.groupSubmit, { n: slots.length })}
      </Button>
    </form>
  );
}

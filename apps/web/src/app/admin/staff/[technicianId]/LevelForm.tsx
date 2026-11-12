'use client';

import { useActionState, useState } from 'react';
import { ErrorRef } from '@/components/ErrorRef';
import { Button } from '@/components/ui';
import type { Dictionary } from '@/i18n/dictionary';
import { saveTechnicianLevel, type LevelState } from '../../levels/actions';

const LEVELS = ['regular', 'gel', 'dip', 'acrylic'] as const;
const rank = (l: string) => LEVELS.indexOf(l as (typeof LEVELS)[number]);

/** A technician's level and the services ticked for them (v0.14.0). Owners
 *  and managers. Picking a level ticks everything at or below it on the
 *  screen; the ticks that are saved are what the engine uses. */
export function LevelForm({
  technicianId,
  level,
  serviceIds,
  services,
  t,
}: {
  technicianId: string;
  level: string | null;
  serviceIds: string[];
  services: { id: string; name: string; minLevel: string }[];
  t: Dictionary['levels'];
}) {
  const [state, action, pending] = useActionState<LevelState, FormData>(saveTechnicianLevel, {});
  const [chosen, setChosen] = useState(level ?? '');
  const [ticked, setTicked] = useState(() => new Set(serviceIds));
  const fill = (l: string) =>
    setTicked(new Set(services.filter((s) => rank(s.minLevel) <= rank(l)).map((s) => s.id)));

  return (
    <form action={action} className="flex flex-col gap-4 bg-board p-5">
      <input type="hidden" name="technicianId" value={technicianId} />
      <h2 className="text-heading font-semibold">{t.techTitle}</h2>
      <p className="max-w-[70ch] text-slate/80">{t.techLead}</p>
      <label className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{t.level}</span>
        <select
          name="level"
          value={chosen}
          onChange={(e) => {
            setChosen(e.target.value);
            if (e.target.value) fill(e.target.value);
          }}
          className="min-h-11 rounded-control border-2 border-slate/30 bg-board px-3 text-lead"
        >
          <option value="">{t.notSet}</option>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {t.name[l]}
            </option>
          ))}
        </select>
      </label>
      {chosen ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 font-medium">{t.services}</legend>
          <div className="grid gap-x-6 sm:grid-cols-2">
            {services.map((s) => (
              <label key={s.id} className="flex min-h-11 items-center gap-3 text-lead">
                <input
                  type="checkbox"
                  name="service"
                  value={s.id}
                  checked={ticked.has(s.id)}
                  onChange={(e) => {
                    const next = new Set(ticked);
                    if (e.target.checked) next.add(s.id);
                    else next.delete(s.id);
                    setTicked(next);
                  }}
                  className="h-6 w-6"
                />
                <span>
                  {s.name} <span className="text-small text-slate/70">({t.name[s.minLevel]})</span>
                </span>
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={() => fill(chosen)}
            className="min-h-11 self-start underline"
          >
            {t.fillLevel}
          </button>
        </fieldset>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {t.saveTech}
        </Button>
        {state.saved ? <span className="font-semibold text-teal">{t.saved}</span> : null}
        {state.error ? (
          <span role="alert" className="text-polish">
            {t.errors[state.error] ?? state.error}
            <ErrorRef refId={state.ref} />
          </span>
        ) : null}
      </div>
    </form>
  );
}

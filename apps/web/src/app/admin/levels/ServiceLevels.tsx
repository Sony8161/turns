'use client';

import { useActionState } from 'react';
import { ErrorRef } from '@/components/ErrorRef';
import { Button } from '@/components/ui';
import type { Dictionary } from '@/i18n/dictionary';
import { saveServiceLevels, type LevelState } from './actions';

const LEVELS = ['regular', 'gel', 'dip', 'acrylic'] as const;

export type ServiceRow = {
  id: string;
  name: string;
  minLevel: string;
  /** null = every level. */
  turnLevels: string[] | null;
  deskPicks: boolean;
};

/** One service: who gets it by turn, in plain words (v0.14.0). */
function Row({ s, t }: { s: ServiceRow; t: Dictionary['levels'] }) {
  const [state, action, pending] = useActionState<LevelState, FormData>(saveServiceLevels, {});
  return (
    <li className="bg-board p-4">
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="serviceId" value={s.id} />
        <h3 className="text-lead font-semibold">{s.name}</h3>
        <fieldset className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <legend className="font-medium">{t.byTurn}</legend>
          {LEVELS.map((l) => (
            <label key={l} className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                name={`turn.${l}`}
                defaultChecked={s.turnLevels === null || s.turnLevels.includes(l)}
                className="h-6 w-6"
              />
              <span>{t.name[l]}</span>
            </label>
          ))}
        </fieldset>
        <label className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{t.lowest}</span>
          <select
            name="minLevel"
            defaultValue={s.minLevel}
            className="min-h-11 rounded-control border-2 border-slate/30 bg-board px-3"
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {t.name[l]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            name="deskPicks"
            defaultChecked={s.deskPicks}
            className="h-6 w-6"
          />
          <span>{t.deskPicks}</span>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" tone="quiet" disabled={pending} aria-label={`${t.save}: ${s.name}`}>
            {t.save}
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
    </li>
  );
}

export function ServiceLevels({
  services,
  t,
}: {
  services: ServiceRow[];
  t: Dictionary['levels'];
}) {
  return (
    <ul className="flex flex-col gap-3">
      {services.map((s) => (
        <Row
          key={`${s.id}:${s.minLevel}:${s.turnLevels?.join() ?? 'all'}:${s.deskPicks}`}
          s={s}
          t={t}
        />
      ))}
    </ul>
  );
}

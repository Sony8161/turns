'use client';

// v0.18.0 (B7, B8, B18): the walk-in sheet. Big service tiles in groups
// (Hands, Feet, Enhancements, Add-ons), most used first. Tap one or more,
// tap Add: that is a plain walk-in. Everything else is folded under "Add
// details". "A group" and "Nail fix" are choices at the top and keep their
// existing flows (GroupWalkIn, FixLookup).
import { useActionState, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { enterWalkIn, type DeskState } from '../actions';
import { FixLookup } from '../FixLookup';
import { GroupWalkIn } from '../GroupWalkIn';
import type { TileGroup } from './model';
import { Problem, useWords } from './ui';

export type Tile = { id: string; name: string; category: string; isFix?: boolean };

const field = 'min-h-12 rounded-control border-2 border-slate/30 bg-board px-3 text-lead';

export function WalkInSheet({
  groups,
  fixes,
  allServices,
  technicians,
  fixWindowDays,
  fixNeedsApproval,
  groupMax,
  onDone,
}: {
  groups: { group: TileGroup; services: Tile[] }[];
  fixes: Tile[];
  allServices: Tile[];
  technicians: { id: string; name: string }[];
  fixWindowDays: number;
  fixNeedsApproval: boolean;
  groupMax: number;
  onDone: () => void;
}) {
  const w = useWords();
  const f = w.floor;
  const d = w.desk;
  const [mode, setMode] = useState<'one' | 'group' | 'fix'>('one');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const formRef = useRef<HTMLFormElement>(null);
  const [state, submit, pending] = useActionState<DeskState, FormData>(async (prev, fd) => {
    const next = await enterWalkIn(prev, fd);
    if (next.done) {
      formRef.current?.reset();
      setPicked(new Set());
      onDone();
    }
    return next;
  }, {});
  const toggle = (id: string, on: boolean) =>
    setPicked((p) => {
      const n = new Set(p);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const tiles = (list: Tile[]) => (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {list.map((s) => (
        <label
          key={s.id}
          className={`flex min-h-16 cursor-pointer items-center rounded-control border-2 px-3 py-2 text-lead font-semibold leading-tight ${
            picked.has(s.id) ? 'border-navy bg-navy text-board' : 'border-slate/30 bg-board'
          }`}
        >
          <input
            type="checkbox"
            name="service"
            value={s.id}
            className="sr-only"
            onChange={(e) => toggle(s.id, e.target.checked)}
          />
          <span aria-hidden className="mr-2 inline-block w-5 text-center">
            {picked.has(s.id) ? '✓' : ''}
          </span>
          {s.name}
        </label>
      ))}
    </div>
  );
  const fixPicked = fixes.some((s) => picked.has(s.id));

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label={f.sheetTitle} className="flex flex-wrap gap-2">
        {(['one', 'group', 'fix'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={mode === k}
            onClick={() => {
              setMode(k);
              setPicked(new Set());
            }}
            className={`min-h-12 flex-1 rounded-control border-2 px-4 font-semibold ${
              mode === k ? 'border-navy bg-navy text-board' : 'border-slate/30 bg-board text-slate'
            }`}
          >
            {k === 'one' ? f.oneClient : k === 'group' ? f.aGroup : f.nailFix}
          </button>
        ))}
      </div>

      {mode === 'group' ? (
        <GroupWalkIn t={d} services={allServices} technicians={technicians} max={groupMax} />
      ) : (
        <form ref={formRef} action={submit} className="flex flex-col gap-4">
          <p className="text-slate/80">{f.pickOneOrMore}</p>
          {mode === 'fix' ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="pb-1 font-semibold">{f.groups.fix}</legend>
              {tiles(fixes)}
              {fixPicked ? (
                <FixLookup t={d} windowDays={fixWindowDays} needsApproval={fixNeedsApproval} />
              ) : null}
            </fieldset>
          ) : null}
          {groups.map((g) => (
            <fieldset key={g.group} className="flex flex-col gap-2">
              <legend className="pb-1 font-semibold">{f.groups[g.group]}</legend>
              {tiles(g.services)}
            </fieldset>
          ))}

          <details className="bg-board p-4">
            <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
              {f.addDetails}
            </summary>
            <div className="flex flex-col gap-4 pt-3">
              <div className="flex flex-wrap gap-4">
                <label className="flex flex-col gap-1">
                  <span className="text-small font-medium">{d.clientFirstName}</span>
                  <input name="clientFirstName" maxLength={60} className={`${field} w-44`} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-small font-medium">{d.clientLastName}</span>
                  <input name="clientLastName" maxLength={60} className={`${field} w-44`} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-small font-medium">{d.clientPhone}</span>
                  <input
                    name="clientPhone"
                    inputMode="tel"
                    maxLength={32}
                    className={`${field} w-52`}
                  />
                </label>
              </div>
              <div
                role="radiogroup"
                aria-labelledby="walkin-gender"
                className="flex flex-wrap items-center gap-4"
              >
                <span id="walkin-gender" className="font-medium">
                  {d.gender}
                </span>
                {(['unspecified', 'female', 'male'] as const).map((g) => (
                  <label key={g} className="flex min-h-11 items-center gap-2">
                    <input
                      type="radio"
                      name="gender"
                      value={g}
                      defaultChecked={g === 'unspecified'}
                      className="h-5 w-5"
                    />
                    <span>{d.genders[g]}</span>
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-4">
                <label className="flex min-h-11 items-center gap-3">
                  <input type="checkbox" name="kid" className="h-6 w-6" />
                  <span>{d.kid}</span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-small font-medium">{d.age}</span>
                  <input name="age" inputMode="numeric" maxLength={3} className={`${field} w-24`} />
                </label>
              </div>
              <label className="flex flex-col gap-1">
                <span className="font-medium">{d.requestedTech}</span>
                <select name="requestedTechnician" className={field}>
                  <option value="">{d.anyTech}</option>
                  {technicians.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-medium">{d.note}</span>
                <textarea
                  name="note"
                  maxLength={300}
                  rows={2}
                  placeholder={d.notePlaceholder}
                  className="rounded-control border-2 border-slate/30 bg-board px-3 py-2 text-lead"
                />
              </label>
              <label className="flex min-h-11 items-center gap-3">
                <input type="checkbox" name="sameTime" className="h-6 w-6" />
                <span>{d.sameTime}</span>
              </label>
            </div>
          </details>

          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 bg-pumice py-2">
            <span aria-live="polite" className="font-medium">
              {picked.size ? fill(f.picked, { n: picked.size }) : f.nonePicked}
            </span>
            <Button
              type="submit"
              disabled={pending || picked.size === 0}
              className="ml-auto min-h-14 px-10 text-lead"
            >
              {f.add}
            </Button>
          </div>
          <Problem state={state} />
        </form>
      )}
    </div>
  );
}

'use client';

// v0.16.0: "We're a group" on the kiosk. People are added one at a time:
// first name (required), last name (optional), their own services, their own
// technician choice (only who is in today and does all of them, "Anyone"
// first) and their own request note. Up to the rules' group size, then one
// submit. One optional phone for the whole group. Nothing typed is shown back
// after the check-in, and the screen clears itself (T12).
import { useActionState, useEffect, useState } from 'react';
import { ErrorRef } from '@/components/ErrorRef';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { groupCheckInAction, type KioskState } from './actions';
import { techsFor, type KioskTech } from './form';

type Service = { id: string; name: string; category: string };
type Person = {
  name: string;
  lastName: string;
  serviceIds: string[];
  requestedTechnicianId: string;
  note: string;
};

const EMPTY: Person = {
  name: '',
  lastName: '',
  serviceIds: [],
  requestedTechnicianId: '',
  note: '',
};
const DONE_SECONDS = 12;

export function KioskGroup({
  t,
  services,
  technicians,
  max,
  onBack,
  onReset,
  choice,
  input,
}: {
  t: Dictionary['kiosk'];
  services: Service[];
  technicians: KioskTech[];
  max: number;
  onBack: () => void;
  onReset: () => void;
  choice: (on: boolean) => string;
  input: string;
}) {
  const [state, action, pending] = useActionState<KioskState, FormData>(groupCheckInAction, {});
  const [people, setPeople] = useState<Person[]>([]);
  const [draft, setDraft] = useState<Person>(EMPTY);
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.done) return;
    const id = setTimeout(onReset, DONE_SECONDS * 1000);
    return () => clearTimeout(id);
  }, [state.done, onReset]);

  if (state.done) {
    return (
      <section aria-live="polite" className="flex flex-1 flex-col justify-center gap-6 text-center">
        <h1 className="text-name font-semibold">{t.doneTitleNoName}</h1>
        <p className="text-kiosk-button">{t.groupDoneBody}</p>
        <button type="button" onClick={onReset} className={choice(false)}>
          {t.startOver}
        </button>
      </section>
    );
  }

  const full = people.length >= max;
  const offered = techsFor(technicians, draft.serviceIds);
  const add = () => {
    if (!draft.name.trim()) return setError(t.errors.bad_name ?? null);
    if (draft.serviceIds.length === 0) return setError(t.errors.no_services ?? null);
    setError(null);
    setPeople((p) => [...p, draft]);
    setDraft(EMPTY);
  };
  const toggle = (id: string) =>
    setDraft((d) => {
      const has = d.serviceIds.includes(id);
      const serviceIds = has ? d.serviceIds.filter((x) => x !== id) : [...d.serviceIds, id];
      // A new choice of services starts the technician again from "Anyone".
      return { ...d, serviceIds, requestedTechnicianId: '' };
    });
  const serverError = state.error ? (t.errors[state.error] ?? t.errors.too_many) : null;

  return (
    <form action={action} className="flex flex-1 flex-col gap-6">
      <input
        type="hidden"
        name="people"
        value={JSON.stringify(
          people.map((p) => ({
            name: p.name,
            lastName: p.lastName,
            serviceIds: p.serviceIds,
            requestedTechnicianId: p.requestedTechnicianId,
            note: p.note,
          })),
        )}
      />
      <h1 className="text-name font-semibold">{t.groupTitle}</h1>
      <p className="text-lead text-slate/70">{fill(t.groupLead, { max })}</p>

      {people.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-lead font-semibold">{t.groupPeople}</h2>
          <ul className="flex flex-col gap-2">
            {people.map((p, i) => (
              <li
                key={`${p.name}-${i}`}
                className="flex items-center justify-between gap-3 rounded-control border-4 border-pumice px-4 py-3 text-lead"
              >
                <span>
                  <span className="font-semibold">{p.name}</span>
                  {' · '}
                  {p.serviceIds
                    .map((id) => services.find((s) => s.id === id)?.name ?? '')
                    .join(', ')}
                </span>
                <button
                  type="button"
                  onClick={() => setPeople((all) => all.filter((_, j) => j !== i))}
                  className="min-h-14 rounded-control border-4 border-slate px-5 font-semibold"
                >
                  {t.groupRemove}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {full ? (
        <p className="text-lead font-semibold">{t.groupFull}</p>
      ) : (
        <section className="flex flex-col gap-4 border-t-4 border-pumice pt-4">
          <h2 className="text-heading font-semibold">
            {fill(t.groupPersonTitle, { n: people.length + 1 })}
          </h2>
          <label className="flex flex-col gap-2">
            <span className="text-lead font-medium">{t.nameLabel}</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              autoComplete="off"
              autoCorrect="off"
              maxLength={40}
              className={input}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-lead font-medium">{t.lastNameLabel}</span>
            <input
              value={draft.lastName}
              onChange={(e) => setDraft({ ...draft, lastName: e.target.value })}
              autoComplete="off"
              autoCorrect="off"
              maxLength={40}
              className={input}
            />
          </label>
          <span className="text-lead font-medium">{t.groupPersonServices}</span>
          <div className="grid gap-3 sm:grid-cols-2">
            {services.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={draft.serviceIds.includes(s.id)}
                onClick={() => toggle(s.id)}
                className={choice(draft.serviceIds.includes(s.id))}
              >
                {s.name}
              </button>
            ))}
          </div>
          {draft.serviceIds.length > 0 ? (
            <>
              <span className="text-lead font-medium">{t.groupPersonTech}</span>
              <div className="grid gap-3 sm:grid-cols-2">
                {[{ id: '', name: t.anyTech }, ...offered].map((x) => (
                  <button
                    key={x.id || 'any'}
                    type="button"
                    aria-pressed={draft.requestedTechnicianId === x.id}
                    onClick={() => setDraft({ ...draft, requestedTechnicianId: x.id })}
                    className={choice(draft.requestedTechnicianId === x.id)}
                  >
                    {x.name}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          <label className="flex flex-col gap-2">
            <span className="text-lead font-medium">{t.noteLabel}</span>
            <input
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              autoComplete="off"
              autoCorrect="off"
              maxLength={200}
              className={input}
            />
          </label>
          <button
            type="button"
            onClick={add}
            className="min-h-20 rounded-control bg-navy px-10 text-kiosk-button font-semibold text-board"
          >
            {t.groupAddPerson}
          </button>
        </section>
      )}

      <label className="flex flex-col gap-2 border-t-4 border-pumice pt-4">
        <span className="text-lead font-medium">{t.groupPhoneLabel}</span>
        <input
          name="phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="tel"
          autoComplete="off"
          maxLength={20}
          className={input}
        />
        <span className="text-body text-slate/70">{t.phoneHint}</span>
      </label>

      {error || serverError ? (
        <p role="alert" className="text-lead font-semibold text-polish">
          {error ?? serverError}
          <ErrorRef refId={error ? undefined : state.ref} />
        </p>
      ) : null}
      {people.length < 2 ? <p className="text-lead text-slate/70">{t.groupNeedTwo}</p> : null}

      <div className="mt-auto flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={onBack}
          className="min-h-20 rounded-control border-4 border-slate px-8 text-kiosk-button font-semibold text-slate"
        >
          {t.back}
        </button>
        <button
          type="submit"
          disabled={pending || people.length < 2}
          className="min-h-20 rounded-control bg-teal px-10 text-kiosk-button font-semibold text-board disabled:opacity-50"
        >
          {fill(t.groupSubmit, { n: people.length })}
        </button>
      </div>
    </form>
  );
}

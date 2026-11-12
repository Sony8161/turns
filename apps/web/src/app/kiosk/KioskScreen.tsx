'use client';

// The check-in iPad (design plan, Kiosk): one question per screen, big
// answers, "Back" bottom left, language top right, "2 of 4" in words. The
// screen clears itself after every check-in and after a minute untouched
// (threat model T12). Nothing typed is ever shown back except the first name
// on the thank-you screen.
import { ErrorRef } from '@/components/ErrorRef';
import { useRouter } from 'next/navigation';
import { useActionState, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { checkInAction, unlockAction, type KioskState } from './actions';
import { techsFor, type KioskTech } from './form';

export const IDLE_SECONDS = 60;
const DONE_SECONDS = 12;
const LOGO_TAPS = 5;
const STEPS = 5;
const STEP_OF_ERROR: Record<string, number> = {
  bad_name: 1,
  bad_phone: 1,
  no_services: 2,
  unknown_service: 2,
  bad_age: 3,
  unknown_technician: 4,
};

type Service = { id: string; name: string; category: string };

export function KioskScreen(props: {
  t: Dictionary['kiosk'];
  locationName: string;
  services: Service[];
  /** v0.15.0: only who is in today; serviceIds narrows it to the chosen services. */
  technicians: KioskTech[];
  notice: { show: false } | { show: true; minutes: number | null };
  languageToggle: ReactNode;
}) {
  // A new round remounts the form: every field, choice and step is gone.
  const [round, setRound] = useState(0);
  const router = useRouter();
  // Each new customer also gets a fresh menu and wait notice from the server.
  const reset = useCallback(() => {
    setRound((r) => r + 1);
    router.refresh();
  }, [router]);
  return <KioskRound key={round} {...props} onReset={reset} />;
}

function KioskRound({
  t,
  locationName,
  services,
  technicians,
  notice,
  languageToggle,
  onReset,
}: Parameters<typeof KioskScreen>[0] & { onReset: () => void }) {
  const [state, action, pending] = useActionState<KioskState, FormData>(checkInAction, {});
  const [step, setStep] = useState(1);
  const [stepError, setStepError] = useState<string | null>(null);
  const [who, setWho] = useState<'adult' | 'kid'>('adult');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [unlocking, setUnlocking] = useState(false);
  const taps = useRef<number[]>([]);
  const form = useRef<HTMLFormElement>(null);

  // Untouched for a minute: start over, blank (T12).
  useEffect(() => {
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'input'] as const;
    for (const e of events) window.addEventListener(e, touch);
    const id = setInterval(() => {
      if (Date.now() - last > IDLE_SECONDS * 1000) onReset();
    }, 5000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      clearInterval(id);
    };
  }, [onReset]);

  // A new question: move focus to it, so a screen reader reads it and the
  // keyboard starts there (Part 10 accessibility pass). Not on first render.
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    form.current?.querySelector<HTMLElement>(`fieldset[data-step="${step}"]`)?.focus();
  }, [step]);

  // After a check-in, the thank-you stays a few seconds, then the next customer.
  useEffect(() => {
    if (!state.done) return;
    const id = setTimeout(onReset, DONE_SECONDS * 1000);
    return () => clearTimeout(id);
  }, [state.done, onReset]);

  // A server refusal sends the customer back to the step it is about. Done
  // while rendering, when the answer changes (React: adjusting state on a prop
  // change), not in an effect.
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    const back = state.error ? STEP_OF_ERROR[state.error] : undefined;
    if (back) setStep(back);
  }

  function tapLogo() {
    const now = Date.now();
    taps.current = [...taps.current.filter((x) => now - x < 3000), now];
    if (taps.current.length >= LOGO_TAPS) {
      taps.current = [];
      setUnlocking(true);
    }
  }

  function next() {
    const fd = form.current ? new FormData(form.current) : null;
    if (step === 1 && !String(fd?.get('name') ?? '').trim()) {
      setStepError(t.errors.bad_name ?? null);
      return;
    }
    if (step === 2 && picked.size === 0) {
      setStepError(t.errors.no_services ?? null);
      return;
    }
    setStepError(null);
    setStep((s) => Math.min(STEPS, s + 1));
  }

  const big =
    'flex min-h-20 w-full items-center justify-center rounded-control border-4 px-6 text-kiosk-button font-semibold';
  const choice = (on: boolean) =>
    `${big} ${on ? 'border-navy bg-navy text-board' : 'border-slate/30 bg-board text-slate'}`;
  const input =
    'min-h-20 w-full rounded-control border-4 border-slate/30 bg-board px-5 text-kiosk-button';
  const error = stepError ?? (state.error ? (t.errors[state.error] ?? t.errors.too_many) : null);

  if (unlocking) return <Unlock t={t} onCancel={() => setUnlocking(false)} />;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-8 bg-board px-6 py-6 select-none sm:px-10">
      <header className="flex items-center justify-between gap-4">
        {/* Five quick taps open the staff PIN. No visible hint, on purpose. */}
        <button
          type="button"
          onClick={tapLogo}
          className="min-h-11 text-lead font-semibold text-slate"
          aria-label={locationName}
        >
          {locationName}
        </button>
        {languageToggle}
      </header>

      {state.done ? (
        <section
          aria-live="polite"
          className="flex flex-1 flex-col justify-center gap-6 text-center"
        >
          <h1 className="text-name font-semibold">
            {state.name ? fill(t.doneTitle, { name: state.name }) : t.doneTitleNoName}
          </h1>
          <p className="text-kiosk-button">{t.doneBody}</p>
          {notice.show ? (
            <p className="text-lead font-semibold text-polish">
              {notice.minutes ? fill(t.noticeMinutes, { minutes: notice.minutes }) : t.notice}
            </p>
          ) : null}
          <button type="button" onClick={onReset} className={choice(false)}>
            {t.startOver}
          </button>
        </section>
      ) : (
        <form
          ref={form}
          action={action}
          onKeyDown={(e) => {
            // Return on the keyboard moves to the next question, never submits early.
            if (e.key === 'Enter' && step < STEPS) {
              e.preventDefault();
              next();
            }
          }}
          className="flex flex-1 flex-col gap-6"
        >
          <p aria-live="polite" className="text-lead text-slate/70">
            {fill(t.stepOf, { step, total: STEPS })}
          </p>

          <fieldset data-step={1} tabIndex={-1} hidden={step !== 1} className="flex flex-col gap-6">
            <legend className="mb-6 text-name font-semibold">{t.nameQuestion}</legend>
            <label className="flex flex-col gap-2">
              <span className="text-lead font-medium">{t.nameLabel}</span>
              <input
                name="name"
                autoComplete="off"
                autoCorrect="off"
                maxLength={40}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-lead font-medium">{t.lastNameLabel}</span>
              <input
                name="lastName"
                autoComplete="off"
                autoCorrect="off"
                maxLength={40}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-lead font-medium">{t.phoneLabel}</span>
              <input
                name="phone"
                inputMode="tel"
                autoComplete="off"
                maxLength={20}
                className={input}
              />
              <span className="text-body text-slate/70">{t.phoneHint}</span>
            </label>
          </fieldset>

          <fieldset data-step={2} tabIndex={-1} hidden={step !== 2} className="flex flex-col gap-4">
            <legend className="mb-6 text-name font-semibold">{t.servicesQuestion}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {services.map((s) => (
                <label key={s.id} className={choice(picked.has(s.id))}>
                  <input
                    type="checkbox"
                    name="service"
                    value={s.id}
                    className="sr-only"
                    checked={picked.has(s.id)}
                    onChange={(e) => {
                      const nextSet = new Set(picked);
                      if (e.target.checked) nextSet.add(s.id);
                      else nextSet.delete(s.id);
                      setPicked(nextSet);
                    }}
                  />
                  <span className="text-center">{s.name}</span>
                </label>
              ))}
            </div>
            {picked.size >= 2 ? (
              <label className="flex min-h-16 items-center gap-4 text-lead">
                <input type="checkbox" name="sameTime" className="h-8 w-8" />
                <span>{t.sameTime}</span>
              </label>
            ) : null}
          </fieldset>

          <fieldset data-step={3} tabIndex={-1} hidden={step !== 3} className="flex flex-col gap-4">
            <legend className="mb-6 text-name font-semibold">{t.whoQuestion}</legend>
            <div className="grid grid-cols-2 gap-3">
              {(['adult', 'kid'] as const).map((w) => (
                <label key={w} className={choice(who === w)}>
                  <input
                    type="radio"
                    name="who"
                    value={w}
                    className="sr-only"
                    checked={who === w}
                    onChange={() => setWho(w)}
                  />
                  {t.who[w]}
                </label>
              ))}
            </div>
            {who === 'kid' ? (
              <label className="flex flex-col gap-2">
                <span className="text-lead font-medium">{t.ageLabel}</span>
                <input name="age" inputMode="numeric" maxLength={2} className={`${input} w-40`} />
              </label>
            ) : null}
            <GenderChoice t={t} choice={choice} />
          </fieldset>

          <fieldset data-step={4} tabIndex={-1} hidden={step !== 4} className="flex flex-col gap-4">
            <legend className="mb-6 text-name font-semibold">{t.techQuestion}</legend>
            <p className="text-lead text-slate/70">{t.techHint}</p>
            <TechChoice
              // The list depends on the services: a new choice of services
              // starts again from "Anyone".
              key={[...picked].sort().join(',')}
              t={t}
              technicians={techsFor(technicians, [...picked])}
              choice={choice}
            />
          </fieldset>

          <fieldset data-step={5} tabIndex={-1} hidden={step !== 5} className="flex flex-col gap-4">
            <legend className="mb-6 text-name font-semibold">{t.noteQuestion}</legend>
            <label className="flex flex-col gap-2">
              <span className="text-lead font-medium">{t.noteLabel}</span>
              <textarea
                name="note"
                rows={3}
                maxLength={200}
                autoComplete="off"
                autoCorrect="off"
                className="min-h-32 w-full rounded-control border-4 border-slate/30 bg-board px-5 py-4 text-kiosk-button"
              />
              <span className="text-body text-slate/70">{t.noteHint}</span>
            </label>
          </fieldset>

          {error ? (
            <p role="alert" className="text-lead font-semibold text-polish">
              {error}
              <ErrorRef refId={stepError ? undefined : state.ref} />
            </p>
          ) : null}

          <div className="mt-auto flex items-center justify-between gap-4">
            {step > 1 ? (
              <button
                type="button"
                onClick={() => {
                  setStepError(null);
                  setStep((s) => s - 1);
                }}
                className="min-h-20 rounded-control border-4 border-slate px-8 text-kiosk-button font-semibold text-slate"
              >
                {t.back}
              </button>
            ) : (
              <span />
            )}
            {/* Distinct keys: one reused <button> flipped to type=submit during the
                tap on Next and sent the form a step early (v0.10.2). */}
            {step < STEPS ? (
              <button
                key="next"
                type="button"
                onClick={next}
                className="min-h-20 rounded-control bg-navy px-10 text-kiosk-button font-semibold text-board"
              >
                {t.next}
              </button>
            ) : (
              <button
                key="submit"
                type="submit"
                disabled={pending}
                className="min-h-20 rounded-control bg-teal px-10 text-kiosk-button font-semibold text-board disabled:opacity-50"
              >
                {t.submit}
              </button>
            )}
          </div>
        </form>
      )}
    </main>
  );
}

function GenderChoice({ t, choice }: { t: Dictionary['kiosk']; choice: (on: boolean) => string }) {
  const [g, setG] = useState<'female' | 'male' | 'skip'>('skip');
  return (
    <div className="flex flex-col gap-3 pt-4">
      <span className="text-lead font-medium">{t.genderLabel}</span>
      <div className="grid gap-3 sm:grid-cols-3">
        {(['female', 'male', 'skip'] as const).map((x) => (
          <label key={x} className={choice(g === x)}>
            <input
              type="radio"
              name="gender"
              value={x}
              className="sr-only"
              checked={g === x}
              onChange={() => setG(x)}
            />
            {t.genders[x]}
          </label>
        ))}
      </div>
    </div>
  );
}

function TechChoice({
  t,
  technicians,
  choice,
}: {
  t: Dictionary['kiosk'];
  technicians: { id: string; name: string }[];
  choice: (on: boolean) => string;
}) {
  const [pick, setPick] = useState('');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {[{ id: '', name: t.anyTech }, ...technicians].map((x) => (
        <label key={x.id || 'any'} className={choice(pick === x.id)}>
          <input
            type="radio"
            name="requestedTechnician"
            value={x.id}
            className="sr-only"
            checked={pick === x.id}
            onChange={() => setPick(x.id)}
          />
          {x.name}
        </label>
      ))}
    </div>
  );
}

function Unlock({ t, onCancel }: { t: Dictionary['kiosk']; onCancel: () => void }) {
  const [state, action, pending] = useActionState<KioskState, FormData>(unlockAction, {});
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 bg-board px-6">
      <form action={action} className="flex flex-col gap-6">
        <h1 className="text-heading font-semibold">{t.unlockTitle}</h1>
        <input
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          aria-label={t.unlockTitle}
          className="min-h-20 rounded-control border-4 border-slate/30 px-5 text-center text-kiosk-button tracking-[0.5em]"
        />
        {state.error ? (
          <p role="alert" className="font-semibold text-polish">
            {t.errors[state.error] ?? state.error}
            <ErrorRef refId={state.ref} />
          </p>
        ) : null}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-16 flex-1 rounded-control border-4 border-slate text-lead font-semibold"
          >
            {t.cancel}
          </button>
          <button
            type="submit"
            disabled={pending}
            className="min-h-16 flex-1 rounded-control bg-navy text-lead font-semibold text-board disabled:opacity-50"
          >
            {t.unlock}
          </button>
        </div>
      </form>
    </main>
  );
}

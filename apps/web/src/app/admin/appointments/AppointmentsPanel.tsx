'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { appointmentsAction, type AppointmentsState } from './actions';

type Service = { id: string; name: string; category: string };
type Tech = { id: string; name: string; feed: string | null; feedError: string | null };
export type AppointmentItem = {
  id: string;
  technicianId: string;
  technicianName: string;
  clientName: string | null;
  when: string;
  /** datetime-local value at the salon, for the change form. */
  start: string;
  minutes: number;
  source: 'ics' | 'manual';
  state: 'open' | 'arrived' | 'cancelled';
};
type Sync = {
  feeds: number;
  lastSynced: string | null;
  failing: { name: string; error: string }[];
  stale: string[];
  staleMin: number;
};

/** Every form posts to one action; the server checks role and location again. */
export function AppointmentsPanel({
  t,
  isOwner,
  now,
  services,
  technicians,
  sync,
  appointments,
}: {
  t: Dictionary['appointments'];
  isOwner: boolean;
  now: string;
  services: Service[];
  technicians: Tech[];
  sync: Sync;
  appointments: AppointmentItem[];
}) {
  const [state, action, pending] = useActionState<AppointmentsState, FormData>(
    appointmentsAction,
    {},
  );
  const field = 'min-h-11 rounded-control border-2 border-slate/30 bg-board px-3';
  const trouble = sync.failing.length > 0 || sync.stale.length > 0;

  const message = state.error ? (
    <p role="alert" className="text-polish">
      {t.errors[state.error] ?? state.error}
      {state.detail ? ` (${state.detail})` : ''}
    </p>
  ) : state.done ? (
    <p role="status" className="font-semibold text-teal">
      {state.done === 'synced'
        ? fill(t.synced, { polled: state.polled ?? 0, failed: state.failed ?? 0 })
        : fill(t.done[state.done] ?? state.done, { name: state.name ?? '' })}
    </p>
  ) : null;

  return (
    <div className="flex flex-col gap-8">
      <section
        aria-live="polite"
        className={`flex flex-col gap-2 border-l-[12px] bg-board p-5 ${trouble ? 'border-polish' : 'border-teal'}`}
      >
        <h2 className="text-heading font-semibold">{t.sync}</h2>
        {sync.feeds === 0 ? (
          <p className="text-slate/80">{t.noFeeds}</p>
        ) : (
          <p className="text-slate/80">
            {sync.lastSynced ? fill(t.lastSynced, { time: sync.lastSynced }) : t.neverSynced}
          </p>
        )}
        {sync.failing.map((f) => (
          <p key={f.name} className="font-semibold text-polish">
            {fill(t.failing, { name: f.name, error: f.error })}
            {isOwner ? '' : ` ${t.tellOwner}`}
          </p>
        ))}
        {sync.stale.length > 0 ? (
          <p className="font-semibold text-polish">
            {fill(t.stale, { minutes: sync.staleMin, names: sync.stale.join(', ') })}
          </p>
        ) : null}
        {sync.feeds > 0 ? (
          <form action={action}>
            <input type="hidden" name="intent" value="sync" />
            <Button type="submit" tone="quiet" disabled={pending}>
              {t.syncNow}
            </Button>
          </form>
        ) : null}
      </section>

      {message}

      <section className="flex flex-col gap-3">
        <h2 className="text-heading font-semibold">{t.list}</h2>
        {appointments.length === 0 ? <p className="text-slate/70">{t.none}</p> : null}
        <ol className="flex flex-col gap-2">
          {appointments.map((a) => (
            <li
              key={a.id}
              className={`flex flex-col gap-3 bg-board px-4 py-3 ${a.state === 'open' ? '' : 'opacity-70'}`}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-lead font-semibold">{a.when}</span>
                <span className="font-semibold">{a.technicianName}</span>
                <span className="text-slate/80">{a.clientName ?? t.noName}</span>
                <span className="rounded-control bg-pumice px-2 py-0.5 text-small">
                  {a.source === 'ics' ? t.fromCalendar : t.byHand}
                </span>
                {a.state !== 'open' ? (
                  <span className="font-semibold text-slate">{t[a.state]}</span>
                ) : null}
              </div>
              {a.state === 'open' ? (
                <>
                  <form action={action} className="flex flex-col gap-2">
                    <input type="hidden" name="intent" value="arrived" />
                    <input type="hidden" name="appointmentId" value={a.id} />
                    <input type="hidden" name="technicianName" value={a.technicianName} />
                    <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
                      <legend className="text-small font-medium">{t.services}</legend>
                      {services.map((s) => (
                        <label key={s.id} className="flex min-h-11 items-center gap-2">
                          <input type="checkbox" name="service" value={s.id} className="h-5 w-5" />
                          <span>{s.name}</span>
                        </label>
                      ))}
                    </fieldset>
                    <div>
                      <Button type="submit" disabled={pending}>
                        {t.arrivedButton}
                      </Button>
                    </div>
                  </form>
                  {a.source === 'manual' ? (
                    <details className="flex flex-col gap-2">
                      <summary className="min-h-11 cursor-pointer py-2 font-medium">
                        {t.change}
                      </summary>
                      <form action={action} className="flex flex-wrap items-end gap-3">
                        <input type="hidden" name="intent" value="change" />
                        <input type="hidden" name="appointmentId" value={a.id} />
                        <TechSelect
                          t={t}
                          technicians={technicians}
                          value={a.technicianId}
                          field={field}
                        />
                        <label className="flex flex-col gap-1">
                          <span className="text-small font-medium">{t.start}</span>
                          <input
                            type="datetime-local"
                            name="start"
                            required
                            defaultValue={a.start}
                            className={field}
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-small font-medium">{t.minutes}</span>
                          <input
                            name="minutes"
                            inputMode="numeric"
                            required
                            defaultValue={a.minutes}
                            className={`${field} w-24`}
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-small font-medium">{t.clientName}</span>
                          <input
                            name="clientName"
                            maxLength={120}
                            defaultValue={a.clientName ?? ''}
                            className={`${field} w-48`}
                          />
                        </label>
                        <Button type="submit" tone="quiet" disabled={pending}>
                          {t.save}
                        </Button>
                      </form>
                      <form action={action} className="flex flex-wrap items-end gap-3">
                        <input type="hidden" name="intent" value="cancel" />
                        <input type="hidden" name="appointmentId" value={a.id} />
                        <label className="flex flex-col gap-1">
                          <span className="text-small font-medium">{t.cancelReason}</span>
                          <input name="reason" maxLength={300} className={`${field} w-56`} />
                        </label>
                        <Button type="submit" tone="danger" disabled={pending}>
                          {t.cancel}
                        </Button>
                      </form>
                    </details>
                  ) : (
                    <p className="text-small text-slate/70">{t.calendarChange}</p>
                  )}
                </>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      <form action={action} className="flex flex-col gap-3 bg-board p-5">
        <h2 className="text-heading font-semibold">{t.add}</h2>
        <p className="text-slate/80">{t.addLead}</p>
        <input type="hidden" name="intent" value="add" />
        <div className="flex flex-wrap items-end gap-3">
          <TechSelect t={t} technicians={technicians} value="" field={field} />
          <label className="flex flex-col gap-1">
            <span className="text-small font-medium">{t.start}</span>
            <input
              type="datetime-local"
              name="start"
              required
              defaultValue={now}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-small font-medium">{t.minutes}</span>
            <input
              name="minutes"
              inputMode="numeric"
              required
              defaultValue={60}
              className={`${field} w-24`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-small font-medium">{t.clientName}</span>
            <input name="clientName" maxLength={120} className={`${field} w-48`} />
          </label>
          <Button type="submit" disabled={pending}>
            {t.addButton}
          </Button>
        </div>
      </form>

      {isOwner ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-heading font-semibold">{t.feeds}</h2>
          <p className="max-w-[70ch] text-slate/80">{t.feedsLead}</p>
          <ol className="flex flex-col gap-2">
            {technicians.map((x) => (
              <li key={x.id} className="flex flex-col gap-2 bg-board px-4 py-3">
                <span className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-semibold">{x.name}</span>
                  <span className="text-small text-slate/80">{x.feed ?? t.noLink}</span>
                  {x.feedError ? (
                    <span className="text-small font-semibold text-polish">{x.feedError}</span>
                  ) : null}
                </span>
                <div className="flex flex-wrap items-end gap-3">
                  <form action={action} className="flex flex-wrap items-end gap-3">
                    <input type="hidden" name="intent" value="setFeed" />
                    <input type="hidden" name="technicianId" value={x.id} />
                    <label className="flex flex-col gap-1">
                      <span className="text-small font-medium">{t.feedUrl}</span>
                      {/* Never pre-filled: the link stays on the server (T14). */}
                      <input
                        type="password"
                        name="url"
                        required
                        maxLength={2048}
                        autoComplete="off"
                        spellCheck={false}
                        className={`${field} w-72`}
                      />
                    </label>
                    <Button type="submit" tone="quiet" disabled={pending}>
                      {t.setFeed}
                    </Button>
                  </form>
                  {x.feed ? (
                    <form action={action}>
                      <input type="hidden" name="intent" value="removeFeed" />
                      <input type="hidden" name="technicianId" value={x.id} />
                      <Button type="submit" tone="quiet" disabled={pending}>
                        {t.removeFeed}
                      </Button>
                    </form>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function TechSelect({
  t,
  technicians,
  value,
  field,
}: {
  t: Dictionary['appointments'];
  technicians: Tech[];
  value: string;
  field: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-small font-medium">{t.technician}</span>
      <select name="technicianId" required defaultValue={value} className={field}>
        <option value="">{t.pickTech}</option>
        {technicians.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
    </label>
  );
}

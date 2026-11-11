'use client';

import { useActionState } from 'react';
import { formatClock } from '@/components/Board';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import {
  callNextFor,
  clearCallFor,
  enterWalkIn,
  reviewKioskFor,
  setNotice,
  type DeskState,
} from './actions';
import { skipText, visitChips } from './chips';

type Service = { id: string; name: string; category: string };
export type Waiting = {
  id: string;
  status: string;
  services: string[];
  waitSeconds: number;
  calledTechnician: string | null;
  calledSeconds: number | null;
  assignedTechnician: string | null;
  requestedTechnician: string | null;
  note: string | null;
  clientName: string | null;
  clientGender: 'female' | 'male' | 'unspecified' | null;
  clientIsKid: boolean | null;
  clientAge: number | null;
  groupId: string | null;
  /** Part 9: checked in on the kiosk; waits for the desk until confirmed. */
  fromKiosk: boolean;
  kioskName: string | null;
  needsConfirm: boolean;
};
export type Attention = {
  unansweredCalls: { callId: string; technicianName: string; waitedMin: number }[];
  unansweredCallMin: number;
  estimatedWaitMin: number | null;
  longWait: boolean;
  longWaitMin: number;
  noticeEnabled: boolean;
  timers: {
    technicianId: string;
    technicianName: string;
    status: 'break' | 'out';
    minutes: number;
    over: boolean;
  }[];
  outOverMin: number;
};

/** The front desk: what needs a person now, enter a walk-in, see who is
 *  waiting, call the next technician and see who was passed over. */
export function Desk({
  services,
  technicians,
  waiting,
  attention,
  t,
}: {
  services: Service[];
  technicians: { id: string; name: string }[];
  waiting: Waiting[];
  attention: Attention;
  t: Dictionary['desk'];
}) {
  const [entry, enter, entering] = useActionState<DeskState, FormData>(enterWalkIn, {});
  const [callState, call, calling] = useActionState<DeskState, FormData>(callNextFor, {});
  const [clearState, clear, clearing] = useActionState<DeskState, FormData>(clearCallFor, {});
  const [noticeState, notice, switching] = useActionState<DeskState, FormData>(setNotice, {});
  const [reviewState, review, reviewing] = useActionState<DeskState, FormData>(reviewKioskFor, {});
  const field = 'min-h-12 rounded-control border-2 border-slate/30 bg-board px-3 text-lead';

  const waitLine =
    attention.estimatedWaitMin === null
      ? t.waitUnknown
      : attention.estimatedWaitMin === 0
        ? t.noWait
        : fill(t.estimatedWait, { minutes: attention.estimatedWaitMin });
  const needsPerson =
    attention.unansweredCalls.length > 0 ||
    attention.longWait ||
    attention.timers.some((x) => x.over);

  return (
    <div className="flex flex-col gap-8">
      <section
        aria-live="polite"
        className={`flex flex-col gap-3 border-l-[12px] bg-board p-5 ${needsPerson ? 'border-polish' : 'border-teal'}`}
      >
        <h2 className="text-heading font-semibold">{t.attentionTitle}</h2>
        {attention.unansweredCalls.map((c) => (
          <form key={c.callId} action={clear} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="callId" value={c.callId} />
            <span className="font-semibold text-polish">
              {fill(t.unanswered, { name: c.technicianName, minutes: c.waitedMin })}
            </span>
            <Button type="submit" tone="quiet" disabled={clearing}>
              {t.clearCall}
            </Button>
          </form>
        ))}
        {clearState.error ? (
          <p className="text-polish">{t.errors[clearState.error] ?? clearState.error}</p>
        ) : null}
        <p className={attention.longWait ? 'font-semibold text-polish' : 'text-slate/80'}>
          {waitLine}
          {attention.longWait ? ` · ${fill(t.longWait, { minutes: attention.longWaitMin })}` : ''}
        </p>
        {attention.timers.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {attention.timers.map((x) => (
              <li
                key={x.technicianId}
                className={x.over ? 'font-semibold text-polish' : 'text-slate/80'}
              >
                {x.status === 'break'
                  ? fill(t.onBreak, { name: x.technicianName, minutes: x.minutes })
                  : x.over
                    ? fill(t.outOver, {
                        name: x.technicianName,
                        minutes: x.minutes,
                        limit: attention.outOverMin,
                      })
                    : fill(t.outFor, { name: x.technicianName, minutes: x.minutes })}
              </li>
            ))}
          </ul>
        ) : null}
        <form action={notice} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="enabled" value={attention.noticeEnabled ? 'false' : 'true'} />
          <span className="text-slate/80">
            {attention.noticeEnabled ? t.noticeOn : t.noticeOff}
          </span>
          <Button type="submit" tone="quiet" disabled={switching}>
            {attention.noticeEnabled ? t.turnNoticeOff : t.turnNoticeOn}
          </Button>
          {noticeState.error ? (
            <span className="text-polish">{t.errors[noticeState.error] ?? noticeState.error}</span>
          ) : null}
        </form>
      </section>

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
          <label className="flex min-h-11 items-center gap-3">
            <input type="checkbox" name="sameTime" className="h-6 w-6" />
            <span>{t.sameTime}</span>
          </label>

          <fieldset className="flex flex-col gap-3 border-t border-pumice pt-4">
            <legend className="font-medium">{t.client}</legend>
            <p className="text-small text-slate/70">{t.clientHint}</p>
            <div className="flex flex-wrap items-center gap-4">
              <span className="font-medium">{t.gender}</span>
              {(['unspecified', 'female', 'male'] as const).map((g) => (
                <label key={g} className="flex min-h-11 items-center gap-2">
                  <input
                    type="radio"
                    name="gender"
                    value={g}
                    defaultChecked={g === 'unspecified'}
                    className="h-5 w-5"
                  />
                  <span>{t.genders[g]}</span>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex min-h-11 items-center gap-3">
                <input type="checkbox" name="kid" className="h-6 w-6" />
                <span>{t.kid}</span>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-small font-medium">{t.age}</span>
                <input name="age" inputMode="numeric" maxLength={3} className={`${field} w-24`} />
              </label>
            </div>
            <div className="flex flex-wrap gap-4">
              <label className="flex flex-col gap-1">
                <span className="text-small font-medium">{t.clientName}</span>
                <input name="clientName" maxLength={120} className={`${field} w-48`} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-small font-medium">{t.clientPhone}</span>
                <input
                  name="clientPhone"
                  inputMode="tel"
                  maxLength={32}
                  className={`${field} w-48`}
                />
              </label>
            </div>
          </fieldset>

          <label className="flex flex-col gap-2">
            <span className="font-medium">{t.requestedTech}</span>
            <select name="requestedTechnician" className={field}>
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
          {entry.error ? (
            <p className="text-polish">{t.errors[entry.error] ?? entry.error}</p>
          ) : null}
          <Button type="submit" disabled={entering}>
            {t.addWalkIn}
          </Button>
        </form>

        <section className="flex flex-col gap-3">
          <h2 className="text-heading font-semibold">{t.waiting}</h2>
          {waiting.length === 0 ? <p className="text-slate/70">{t.nobodyWaiting}</p> : null}
          {reviewState.error ? (
            <p className="text-polish">{t.errors[reviewState.error] ?? reviewState.error}</p>
          ) : null}
          {callState.error ? (
            <p className="text-polish">
              {t.errors[callState.error] ?? callState.error}
              {callState.error === 'nobody_eligible' && callState.skipped?.length
                ? ` ${fill(t.nobodyLine, {
                    list: callState.skipped
                      .map((s) =>
                        fill(t.skippedLine, { name: s.displayName, why: skipText(s, t.skip) }),
                      )
                      .join('; '),
                  })}`
                : callState.detail && callState.error !== 'nobody_eligible'
                  ? ` (${callState.detail})`
                  : ''}
            </p>
          ) : callState.skipped && callState.skipped.length > 0 ? (
            <div className="flex flex-col gap-1 border-l-[12px] border-amber bg-board p-4">
              <span className="font-semibold">{t.skippedTitle}</span>
              {callState.skipped.map((s, i) => (
                <span key={`${s.displayName}-${i}`} className="text-slate/80">
                  {fill(t.skippedLine, { name: s.displayName, why: skipText(s, t.skip) })}
                </span>
              ))}
            </div>
          ) : null}
          <ol className="flex flex-col gap-2">
            {waiting.map((v) => {
              const chips = visitChips(v, t.chips);
              return (
                <li
                  key={v.id}
                  className={`flex flex-wrap items-center gap-4 bg-board px-4 py-3 ${v.needsConfirm ? 'border-l-[12px] border-amber' : ''}`}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    {v.fromKiosk ? (
                      <span className="text-small font-semibold">
                        {v.needsConfirm ? t.kioskPending : t.kioskConfirmed}
                        {v.kioskName ? `: ${v.kioskName}` : ''}
                      </span>
                    ) : null}
                    <span className="font-semibold">
                      {v.services.join(', ')}
                      {v.requestedTechnician
                        ? ` · ${fill(t.forTech, { name: v.requestedTechnician })}`
                        : ''}
                    </span>
                    {chips.length > 0 || v.clientName ? (
                      <span className="flex flex-wrap gap-2 text-small">
                        {v.clientName ? (
                          <span className="text-slate/80">
                            {fill(t.withName, { name: v.clientName })}
                          </span>
                        ) : null}
                        {chips.map((c) => (
                          <span key={c} className="rounded-control bg-pumice px-2 py-0.5">
                            {c}
                          </span>
                        ))}
                      </span>
                    ) : null}
                    {v.note ? <span className="text-small text-slate/80">{v.note}</span> : null}
                    <span className="text-small text-slate/70">
                      {v.status === 'called' && v.calledTechnician
                        ? fill(t.calledLine, {
                            name: v.calledTechnician,
                            time: formatClock(v.calledSeconds ?? 0),
                          })
                        : v.status === 'in_service'
                          ? `${t.inService}${v.assignedTechnician ? `, ${v.assignedTechnician}` : ''}`
                          : fill(t.waitingLine, { time: formatClock(v.waitSeconds) })}
                    </span>
                  </span>
                  {v.status === 'waiting' && v.needsConfirm ? (
                    <span className="flex gap-2">
                      <form action={review}>
                        <input type="hidden" name="visitId" value={v.id} />
                        <input type="hidden" name="decision" value="confirm" />
                        <Button type="submit" disabled={reviewing}>
                          {t.kioskConfirm}
                        </Button>
                      </form>
                      <form action={review}>
                        <input type="hidden" name="visitId" value={v.id} />
                        <input type="hidden" name="decision" value="decline" />
                        <Button type="submit" tone="quiet" disabled={reviewing}>
                          {t.kioskDecline}
                        </Button>
                      </form>
                    </span>
                  ) : v.status === 'waiting' ? (
                    <form action={call}>
                      <input type="hidden" name="visitId" value={v.id} />
                      <Button type="submit" disabled={calling}>
                        {t.callNext}
                      </Button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </div>
  );
}

'use client';

import { ErrorRef } from '@/components/ErrorRef';
import { useActionState, useState } from 'react';
import { formatClock } from '@/components/Board';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { AcceptFor, DenyFor, FinishFor } from './ActForTech';
import {
  ackHelpFor,
  callNextFor,
  clearCallFor,
  clientHereFor,
  clientLeftFor,
  leftWithoutServiceFor,
  reviewFixFor,
  deskCallFor,
  enterWalkIn,
  requestHoldFor,
  reviewKioskFor,
  setNoteFor,
  setNotice,
  type DeskState,
} from './actions';
import { calledText } from './called-text';
import { skipText, visitChips } from './chips';
import { FixLookup } from './FixLookup';
import { GroupWalkIn } from './GroupWalkIn';

type Service = { id: string; name: string; category: string; isFix?: boolean };
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
  /** v0.14.0: never called by turn; the desk picks the technician. */
  deskPicks: boolean;
  /** The services a technician sent back when she split a visit. */
  splitRest: boolean;
  /** The open call's kind: by turn, an offer to a higher level, or a desk pick. */
  callKind: string | null;
  /** v0.15.0: the earlier parts of this client's visit (the on-screen slip).
   *  v0.17.0: done = her part is finished ("did"), else she "is doing" it. */
  slip: { technician: string | null; services: string[]; done?: boolean }[] | null;
  /** v0.17.0: the open call and the technicians, so the desk can act for her. */
  callId: string | null;
  calledTechnicianId: string | null;
  assignedTechnicianId: string | null;
  /** v0.17.0: the called technician said the client left; the desk answers. */
  leftClaimPending: boolean;
  /** Not callable yet: it waits until this technician finishes her part. */
  held: { technician: string | null } | null;
  /** The requested technician was booked (an appointment), not asked for at the desk. */
  booked: boolean;
  /** The requested or booked technician is busy: what the desk needs to decide. */
  hold: {
    technicianName: string;
    /** The engine's reason she cannot be called (in_service, break, ...). */
    why: string;
    detail?: string;
    /** Minutes she has been in that status; null when not on shift. */
    forMinutes: number | null;
    /** Her next appointment, as a clock time at the salon; null = none. */
    nextAppointment: string | null;
    waitedMin: number;
    attention: boolean;
  } | null;
  /** v0.16.0: people who came in together; partySize counts them all. */
  partyId: string | null;
  partySize: number | null;
  /** v0.16.0: a nail fix or repair, the visit it fixes, and the approval. */
  isFix: boolean;
  needsApproval: boolean;
  fixOf: { date: string; services: string[]; technician: string | null } | null;
  /** Who the desk may ask (higher level) or pick (desk-pick service). */
  options: {
    technicianId: string;
    /** v0.16.0: she did the work this fix repairs. */
    original?: boolean;
    name: string;
    level: string | null;
    turn: number;
    status: string;
    canCall: boolean;
    /** v0.17.1: status 'held': her appointment's time ("2:30 PM"). */
    heldAt?: string;
  }[];
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
  /** v0.16.0: technicians who tapped "Need help", oldest first. */
  help: { id: string; name: string; reason: string | null; waitedSeconds: number }[];
};

/** The front desk: what needs a person now, enter a walk-in, see who is
 *  waiting, call the next technician and see who was passed over. */
export function Desk({
  services,
  technicians,
  waiting,
  attention,
  t,
  levelNames,
  statusNames,
  bookDefault,
  canApprove,
  fixWindowDays,
  fixNeedsApproval,
  groupMax,
  canActFor,
  actFor,
  denyReasons,
  freeReasons,
  freeLabel,
}: {
  /** v0.17.0: this person may accept, deny and finish for a technician. */
  canActFor: boolean;
  actFor: Dictionary['actFor'];
  denyReasons: Record<string, string>;
  freeReasons: readonly string[];
  freeLabel: string;
  /** v0.16.0: a manager or owner: approves a receptionist's fix. */
  canApprove: boolean;
  fixWindowDays: number;
  /** A fix entered by this person waits for approval (receptionist + rules). */
  fixNeedsApproval: boolean;
  groupMax: number;
  /** v0.15.0: the start offered for "Book for later" (datetime-local, salon time). */
  bookDefault: string;
  services: Service[];
  technicians: { id: string; name: string }[];
  waiting: Waiting[];
  attention: Attention;
  t: Dictionary['desk'];
  levelNames: Record<string, string>;
  statusNames: Record<string, string>;
}) {
  const [entry, enter, entering] = useActionState<DeskState, FormData>(enterWalkIn, {});
  const [callState, call, calling] = useActionState<DeskState, FormData>(callNextFor, {});
  const [clearState, clear, clearing] = useActionState<DeskState, FormData>(clearCallFor, {});
  const [noticeState, notice, switching] = useActionState<DeskState, FormData>(setNotice, {});
  const [reviewState, review, reviewing] = useActionState<DeskState, FormData>(reviewKioskFor, {});
  const [noteState, saveNote, savingNote] = useActionState<DeskState, FormData>(setNoteFor, {});
  const [askState, ask, asking] = useActionState<DeskState, FormData>(deskCallFor, {});
  const [holdState, decide, deciding] = useActionState<DeskState, FormData>(requestHoldFor, {});
  const [fixState, reviewFix, reviewingFix] = useActionState<DeskState, FormData>(reviewFixFor, {});
  const [leftState, markLeft, markingLeft] = useActionState<DeskState, FormData>(clientLeftFor, {});
  const [helpState, ackHelp, acking] = useActionState<DeskState, FormData>(ackHelpFor, {});
  // v0.17.0
  const [walkState, markWalked, markingWalked] = useActionState<DeskState, FormData>(
    leftWithoutServiceFor,
    {},
  );
  const [hereState, markHere, markingHere] = useActionState<DeskState, FormData>(clientHereFor, {});
  // v0.16.0: one client or a group; the fix lookup shows when a fix is ticked.
  const [mode, setMode] = useState<'one' | 'group'>('one');
  const [fixTicked, setFixTicked] = useState(false);
  const optionLine = (o: Waiting['options'][number]) =>
    fill(t.optionLine, {
      level: o.level ? (levelNames[o.level] ?? o.level) : '–',
      turn: o.turn,
      status:
        o.status === 'held' && o.heldAt
          ? fill(t.heldForAppt, { time: o.heldAt })
          : (statusNames[o.status] ?? o.status),
    });
  const field = 'min-h-12 rounded-control border-2 border-slate/30 bg-board px-3 text-lead';

  const waitLine =
    attention.estimatedWaitMin === null
      ? t.waitUnknown
      : attention.estimatedWaitMin === 0
        ? t.noWait
        : fill(t.estimatedWait, { minutes: attention.estimatedWaitMin });
  const needsPerson =
    attention.help.length > 0 ||
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
        {attention.help.map((h) => (
          // v0.16.0: "Mai needs help", with the time waiting, until someone acknowledges it.
          <form
            key={h.id}
            action={ackHelp}
            className="flex flex-wrap items-center gap-3 border-l-4 border-polish pl-3"
          >
            <input type="hidden" name="helpId" value={h.id} />
            <span className="flex flex-col">
              <span className="text-lead font-semibold text-polish">
                {fill(t.helpTitle, { name: h.name })}
              </span>
              <span className="text-small text-slate/80">
                {fill(t.helpWaiting, { time: formatClock(h.waitedSeconds) })}
                {h.reason ? ` · ${fill(t.helpReason, { reason: h.reason })}` : ''}
              </span>
            </span>
            <Button
              type="submit"
              disabled={acking}
              aria-label={`${t.helpAck}: ${fill(t.helpTitle, { name: h.name })}`}
            >
              {t.helpAck}
            </Button>
          </form>
        ))}
        {helpState.error ? (
          <p role="alert" className="text-polish">
            {t.errors[helpState.error] ?? helpState.error}
            <ErrorRef refId={helpState.ref} />
          </p>
        ) : null}
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
          <p role="alert" className="text-polish">
            {t.errors[clearState.error] ?? clearState.error}
            <ErrorRef refId={clearState.ref} />
          </p>
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
            <span role="alert" className="text-polish">
              {t.errors[noticeState.error] ?? noticeState.error}
              <ErrorRef refId={noticeState.ref} />
            </span>
          ) : null}
        </form>
      </section>

      <div className="grid gap-8 md:grid-cols-2">
        <div className="flex flex-col gap-4 bg-board p-5">
          <h2 className="text-heading font-semibold">{t.walkIn}</h2>
          <div role="tablist" aria-label={t.walkIn} className="flex gap-2">
            {(['one', 'group'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={mode === k}
                onClick={() => setMode(k)}
                className={`min-h-12 flex-1 rounded-control border-2 px-4 font-semibold ${mode === k ? 'border-navy bg-navy text-board' : 'border-slate/30 text-slate'}`}
              >
                {k === 'one' ? t.walkInOne : t.walkInGroup}
              </button>
            ))}
          </div>
          {mode === 'group' ? (
            <GroupWalkIn t={t} services={services} technicians={technicians} max={groupMax} />
          ) : (
            <form action={enter} className="flex flex-col gap-4">
              <p className="text-slate/80">{t.pickServices}</p>
              <div className="flex flex-col gap-2">
                {services.map((s) => (
                  <label key={s.id} className="flex min-h-11 items-center gap-3 text-lead">
                    <input
                      type="checkbox"
                      name="service"
                      value={s.id}
                      className="h-6 w-6"
                      onChange={s.isFix ? (e) => setFixTicked(e.target.checked) : undefined}
                    />
                    <span>{s.name}</span>
                    <span className="text-small text-slate/80">{s.category}</span>
                  </label>
                ))}
              </div>
              {fixTicked ? (
                <FixLookup t={t} windowDays={fixWindowDays} needsApproval={fixNeedsApproval} />
              ) : null}
              <label className="flex min-h-11 items-center gap-3">
                <input type="checkbox" name="sameTime" className="h-6 w-6" />
                <span>{t.sameTime}</span>
              </label>

              <fieldset className="flex flex-col gap-3 border-t border-pumice pt-4">
                <legend className="font-medium">{t.client}</legend>
                <p className="text-small text-slate/70">{t.clientHint}</p>
                <div
                  role="radiogroup"
                  aria-labelledby="desk-gender"
                  className="flex flex-wrap items-center gap-4"
                >
                  <span id="desk-gender" className="font-medium">
                    {t.gender}
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
                    <input
                      name="age"
                      inputMode="numeric"
                      maxLength={3}
                      className={`${field} w-24`}
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-4">
                  <label className="flex flex-col gap-1">
                    <span className="text-small font-medium">{t.clientFirstName}</span>
                    <input name="clientFirstName" maxLength={60} className={`${field} w-40`} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-small font-medium">{t.clientLastName}</span>
                    <input name="clientLastName" maxLength={60} className={`${field} w-40`} />
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
                <p role="alert" className="text-polish">
                  {t.errors[entry.error] ?? entry.error}
                  <ErrorRef refId={entry.ref} />
                </p>
              ) : null}
              <Button type="submit" disabled={entering}>
                {t.addWalkIn}
              </Button>
            </form>
          )}
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-heading font-semibold">{t.waiting}</h2>
          {waiting.length === 0 ? <p className="text-slate/70">{t.nobodyWaiting}</p> : null}
          {reviewState.error ? (
            <p role="alert" className="text-polish">
              {t.errors[reviewState.error] ?? reviewState.error}
              <ErrorRef refId={reviewState.ref} />
            </p>
          ) : null}
          {noteState.error ? (
            <p role="alert" className="text-polish">
              {t.errors[noteState.error] ?? noteState.error}
              <ErrorRef refId={noteState.ref} />
            </p>
          ) : null}
          {askState.error ? (
            <p role="alert" className="text-polish">
              {t.errors[askState.error] ?? askState.error}
              <ErrorRef refId={askState.ref} />
            </p>
          ) : null}
          {holdState.error ? (
            <p role="alert" className="text-polish">
              {t.errors[holdState.error] ?? holdState.error}
              <ErrorRef refId={holdState.ref} />
            </p>
          ) : null}
          {fixState.error ? (
            <p role="alert" className="text-polish">
              {t.errors[fixState.error] ?? fixState.error}
              <ErrorRef refId={fixState.ref} />
            </p>
          ) : null}
          {leftState.error ? (
            <p role="alert" className="text-polish">
              {t.errors[leftState.error] ?? leftState.error}
              <ErrorRef refId={leftState.ref} />
            </p>
          ) : null}
          {walkState.error || hereState.error ? (
            <p role="alert" className="text-polish">
              {t.errors[walkState.error ?? hereState.error ?? ''] ??
                walkState.error ??
                hereState.error}
              <ErrorRef refId={walkState.ref ?? hereState.ref} />
            </p>
          ) : null}
          {callState.error ? (
            <p role="alert" className="text-polish">
              {t.errors[callState.error] ?? callState.error}
              <ErrorRef refId={callState.ref} />
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
                  className={`flex flex-wrap items-center gap-4 bg-board px-4 py-3 ${v.needsConfirm || v.needsApproval ? 'border-l-[12px] border-amber' : ''}`}
                >
                  {/* v0.16.1: the client info keeps a usable width (16rem); wide
                      actions wrap onto their own line instead of squeezing it
                      to one word per line. */}
                  <span className="flex min-w-0 grow basis-64 flex-col">
                    {v.partySize && v.partySize > 1 ? (
                      <span className="w-fit rounded-control bg-teal px-2 py-0.5 text-small font-semibold text-board">
                        {fill(t.groupOf, { n: v.partySize })}
                      </span>
                    ) : null}
                    {v.isFix ? (
                      <span className="w-fit rounded-control border-2 border-navy px-2 py-0.5 text-small font-semibold">
                        {t.fixBadge}
                      </span>
                    ) : null}
                    {v.isFix ? (
                      v.fixOf ? (
                        <span className="text-small text-slate/80">
                          {fill(t.fixOfLine, {
                            date: v.fixOf.date,
                            services: v.fixOf.services.join(' + '),
                            tech: v.fixOf.technician ?? t.fixNoTech,
                          })}
                        </span>
                      ) : (
                        <span className="text-small font-semibold text-polish">
                          {t.fixNoOrigin}
                        </span>
                      )
                    ) : null}
                    {v.fromKiosk ? (
                      <span className="text-small font-semibold">
                        {v.needsConfirm ? t.kioskPending : t.kioskConfirmed}
                        {v.kioskName ? `: ${v.kioskName}` : ''}
                      </span>
                    ) : null}
                    <span className="font-semibold">{v.services.join(', ')}</span>
                    {v.splitRest ? (
                      <span className="w-fit rounded-control bg-pumice px-2 py-0.5 text-small font-medium">
                        {t.splitRest}
                      </span>
                    ) : null}
                    {v.slip ? (
                      // v0.15.0: the on-screen slip: who did what before this part.
                      <span className="w-fit rounded-control border-2 border-slate/30 px-2 py-0.5 text-small">
                        {fill(t.slipLine, {
                          parts: v.slip
                            .map((p) =>
                              p.technician
                                ? fill(p.done === false ? t.slipDoing : t.slipPart, {
                                    name: p.technician,
                                    services: p.services.join(' + '),
                                  })
                                : fill(t.slipNobody, { services: p.services.join(' + ') }),
                            )
                            .join('; '),
                        })}
                      </span>
                    ) : null}
                    {v.requestedTechnician ? (
                      // v0.10.2: the request stands out, so whoever works the
                      // floor (the owner too) sees it before calling.
                      <span className="w-fit rounded-control bg-navy px-2 py-0.5 text-small font-semibold text-board">
                        {fill(v.booked ? t.bookedWith : t.askedFor, {
                          name: v.requestedTechnician,
                        })}
                      </span>
                    ) : null}
                    {chips.length > 0 || v.clientName ? (
                      <span className="flex flex-wrap gap-2 text-small">
                        {v.clientName && v.clientName !== v.kioskName ? (
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
                    {v.note ? (
                      <span className="w-fit rounded-control border-2 border-amber bg-amber/10 px-2 py-0.5 font-medium">
                        {fill(t.requestNote, { note: v.note })}
                      </span>
                    ) : null}
                    {v.status !== 'in_service' ? (
                      <details className="text-small">
                        <summary className="min-h-11 cursor-pointer py-2 text-slate/80 underline">
                          {v.note ? t.editNote : t.addNote}
                        </summary>
                        <form action={saveNote} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="visitId" value={v.id} />
                          <input
                            name="note"
                            defaultValue={v.note ?? ''}
                            maxLength={300}
                            aria-label={`${t.note}: ${rowLabel(v)}`}
                            className="min-h-11 flex-1 rounded-control border-2 border-slate/30 px-3"
                          />
                          <Button type="submit" tone="quiet" disabled={savingNote}>
                            {t.saveNote}
                          </Button>
                        </form>
                      </details>
                    ) : null}
                    {v.status === 'waiting' ||
                    (v.status === 'called' &&
                      canActFor &&
                      v.callId &&
                      v.calledTechnician &&
                      !v.leftClaimPending) ? (
                      // v0.17.0: less common desk actions sit under "More".
                      <details className="text-small">
                        <summary className="min-h-11 cursor-pointer py-2 text-slate/80 underline">
                          {t.more}
                        </summary>
                        <div className="flex max-w-[40ch] flex-col gap-2 pb-2">
                          {v.status === 'waiting' ? (
                            <form action={markWalked} className="flex flex-col gap-1">
                              <input type="hidden" name="visitId" value={v.id} />
                              <span className="text-slate/80">{t.walkedOutLead}</span>
                              <Button
                                type="submit"
                                tone="quiet"
                                disabled={markingWalked}
                                aria-label={`${t.walkedOut}: ${rowLabel(v)}`}
                              >
                                {t.walkedOut}
                              </Button>
                            </form>
                          ) : v.callId && v.calledTechnician ? (
                            <DenyFor
                              callId={v.callId}
                              name={v.calledTechnician}
                              reasons={denyReasons}
                              freeReasons={v.callKind === 'turn' ? freeReasons : []}
                              freeLabel={freeLabel}
                              label={rowLabel(v)}
                              t={actFor}
                            />
                          ) : null}
                        </div>
                      </details>
                    ) : null}
                    <span className="text-small text-slate/70">
                      {v.status === 'called' && v.calledTechnician
                        ? calledText(t, v.callKind, v.calledTechnician, v.calledSeconds ?? 0)
                        : v.status === 'in_service'
                          ? `${t.inService}${v.assignedTechnician ? `, ${v.assignedTechnician}` : ''}`
                          : fill(t.waitingLine, { time: formatClock(v.waitSeconds) })}
                    </span>
                  </span>
                  {v.status === 'called' && v.leftClaimPending ? (
                    // v0.17.0 (FAIR-001): she said the client left; the desk checks.
                    <span className="ml-auto flex flex-col items-end gap-2 border-l-4 border-amber pl-3">
                      <span className="font-semibold">
                        {fill(t.claimLine, { name: v.calledTechnician ?? '' })}
                      </span>
                      <span className="flex flex-wrap justify-end gap-2">
                        <form action={markLeft}>
                          <input type="hidden" name="visitId" value={v.id} />
                          <Button
                            type="submit"
                            disabled={markingLeft}
                            aria-label={`${t.claimConfirm}: ${rowLabel(v)}`}
                          >
                            {t.claimConfirm}
                          </Button>
                        </form>
                        <form action={markHere}>
                          <input type="hidden" name="visitId" value={v.id} />
                          <Button
                            type="submit"
                            tone="quiet"
                            disabled={markingHere}
                            aria-label={`${t.claimHere}: ${rowLabel(v)}`}
                          >
                            {t.claimHere}
                          </Button>
                        </form>
                      </span>
                    </span>
                  ) : v.status === 'called' ? (
                    <span className="ml-auto flex flex-wrap items-start justify-end gap-3">
                      {canActFor && v.callId && v.calledTechnician ? (
                        <AcceptFor
                          callId={v.callId}
                          name={v.calledTechnician}
                          label={rowLabel(v)}
                          t={actFor}
                        />
                      ) : null}
                      {/* v0.16.0: the client walked out after the call, before the service. */}
                      <form action={markLeft} className="flex flex-col items-end gap-1">
                        <input type="hidden" name="visitId" value={v.id} />
                        <Button
                          type="submit"
                          tone="quiet"
                          disabled={markingLeft}
                          aria-label={`${t.clientLeft}: ${rowLabel(v)}`}
                        >
                          {t.clientLeft}
                        </Button>
                        <span className="max-w-[24ch] text-right text-small text-slate/70">
                          {t.clientLeftLead}
                        </span>
                      </form>
                    </span>
                  ) : v.status === 'in_service' &&
                    canActFor &&
                    v.assignedTechnicianId &&
                    v.assignedTechnician ? (
                    <span className="ml-auto">
                      <FinishFor
                        technicianId={v.assignedTechnicianId}
                        visitId={v.id}
                        name={v.assignedTechnician}
                        label={rowLabel(v)}
                        t={actFor}
                      />
                    </span>
                  ) : null}
                  {v.status === 'waiting' && v.needsApproval ? (
                    // v0.16.0: a receptionist's fix: a manager or owner approves it first.
                    <span className="ml-auto flex flex-col items-end gap-2">
                      <span className="font-semibold">{t.fixPending}</span>
                      {canApprove ? (
                        <span className="flex flex-wrap gap-2">
                          <form action={reviewFix}>
                            <input type="hidden" name="visitId" value={v.id} />
                            <input type="hidden" name="decision" value="approve" />
                            <Button
                              type="submit"
                              disabled={reviewingFix}
                              aria-label={`${t.fixApprove}: ${rowLabel(v)}`}
                            >
                              {t.fixApprove}
                            </Button>
                          </form>
                          <form action={reviewFix}>
                            <input type="hidden" name="visitId" value={v.id} />
                            <input type="hidden" name="decision" value="decline" />
                            <Button
                              type="submit"
                              tone="quiet"
                              disabled={reviewingFix}
                              aria-label={`${t.fixDecline}: ${rowLabel(v)}`}
                            >
                              {t.fixDecline}
                            </Button>
                          </form>
                        </span>
                      ) : null}
                    </span>
                  ) : v.status === 'waiting' && v.needsConfirm ? (
                    <span className="ml-auto flex flex-wrap justify-end gap-2">
                      {v.partyId && v.partySize && v.partySize > 1 ? (
                        // v0.16.0: a group from the kiosk: confirm everyone at once.
                        <form action={review}>
                          <input type="hidden" name="visitId" value={v.id} />
                          <input type="hidden" name="decision" value="confirm" />
                          <input type="hidden" name="wholeParty" value="true" />
                          <Button
                            type="submit"
                            disabled={reviewing}
                            aria-label={`${fill(t.groupConfirmAll, { n: v.partySize })}: ${rowLabel(v)}`}
                          >
                            {fill(t.groupConfirmAll, { n: v.partySize })}
                          </Button>
                        </form>
                      ) : null}
                      <form action={review}>
                        <input type="hidden" name="visitId" value={v.id} />
                        <input type="hidden" name="decision" value="confirm" />
                        <Button
                          type="submit"
                          disabled={reviewing}
                          aria-label={`${t.kioskConfirm}: ${rowLabel(v)}`}
                        >
                          {t.kioskConfirm}
                        </Button>
                      </form>
                      {v.requestedTechnician ? (
                        // v0.9.1: the desk decides whether a request typed on
                        // the kiosk stands (review finding 2).
                        <form action={review}>
                          <input type="hidden" name="visitId" value={v.id} />
                          <input type="hidden" name="decision" value="confirm_no_request" />
                          <Button
                            type="submit"
                            tone="quiet"
                            disabled={reviewing}
                            aria-label={`${t.kioskConfirmNoRequest}: ${rowLabel(v)}`}
                          >
                            {t.kioskConfirmNoRequest}
                          </Button>
                        </form>
                      ) : null}
                      <form action={review}>
                        <input type="hidden" name="visitId" value={v.id} />
                        <input type="hidden" name="decision" value="decline" />
                        <Button
                          type="submit"
                          tone="quiet"
                          disabled={reviewing}
                          aria-label={`${t.kioskDecline}: ${rowLabel(v)}`}
                        >
                          {t.kioskDecline}
                        </Button>
                      </form>
                    </span>
                  ) : v.status === 'waiting' && v.deskPicks ? (
                    // v0.14.0: never called by turn. Everyone who does it, with
                    // level, turn and status; only a free technician can be picked.
                    <div className="flex w-full flex-col gap-2 border-l-[12px] border-navy bg-pumice/40 p-3">
                      <span className="font-semibold">{t.pickTech}</span>
                      <span className="text-small text-slate/80">{t.pickLead}</span>
                      {v.options.length === 0 ? (
                        <span className="text-small text-polish">{t.noneCanDo}</span>
                      ) : null}
                      <ul className="flex flex-col gap-2">
                        {v.options.map((o) => (
                          <li key={o.technicianId}>
                            <form action={ask} className="flex flex-wrap items-center gap-3">
                              <input type="hidden" name="visitId" value={v.id} />
                              <input type="hidden" name="technicianId" value={o.technicianId} />
                              <input type="hidden" name="kind" value="desk_pick" />
                              <Button
                                type="submit"
                                tone={o.canCall ? undefined : 'quiet'}
                                disabled={asking || !o.canCall}
                                aria-label={`${fill(t.pickButton, { name: o.name })}: ${rowLabel(v)}`}
                              >
                                {fill(t.pickButton, { name: o.name })}
                              </Button>
                              <span className="text-small text-slate/80">
                                {optionLine(o)}
                                {o.original ? (
                                  <span className="font-semibold"> · {t.originalTech}</span>
                                ) : null}
                              </span>
                            </form>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : v.status === 'waiting' && v.held ? (
                    // v0.15.0: the client is still in the first technician's chair.
                    <span className="ml-auto max-w-[26ch] text-right font-medium text-slate/80">
                      {v.held.technician
                        ? fill(t.heldLine, { name: v.held.technician })
                        : t.heldNobody}
                    </span>
                  ) : v.status === 'waiting' && v.hold ? (
                    // v0.15.0: the technician the client asked for (or booked) is
                    // busy. Never a fallback on its own: the desk decides.
                    <div
                      className={`flex w-full flex-col gap-2 border-l-[12px] p-3 ${v.hold.attention ? 'border-polish bg-polish/5' : 'border-navy bg-pumice/40'}`}
                    >
                      <span className={`font-semibold ${v.hold.attention ? 'text-polish' : ''}`}>
                        {v.hold.attention
                          ? fill(t.holdFlag, {
                              name: v.hold.technicianName,
                              minutes: v.hold.waitedMin,
                            })
                          : fill(t.holdTitle, { name: v.hold.technicianName })}
                      </span>
                      <span className="text-small text-slate/80">
                        {fill(v.hold.forMinutes === null ? t.holdStatusPlain : t.holdStatus, {
                          name: v.hold.technicianName,
                          why: fill(t.skip[v.hold.why] ?? v.hold.why, {
                            detail: v.hold.detail ?? '',
                          }),
                          minutes: v.hold.forMinutes ?? 0,
                        })}
                        {' · '}
                        {v.hold.nextAppointment
                          ? fill(t.holdNext, { time: v.hold.nextAppointment })
                          : t.holdNoNext}
                      </span>
                      <div className="flex flex-wrap items-start gap-3">
                        <form action={decide}>
                          <input type="hidden" name="visitId" value={v.id} />
                          <input type="hidden" name="decision" value="keep" />
                          <Button
                            type="submit"
                            tone="quiet"
                            disabled={deciding}
                            aria-label={`${t.keepWaiting}: ${rowLabel(v)}`}
                          >
                            {t.keepWaiting}
                          </Button>
                        </form>
                        <details className="text-small">
                          <summary className="flex min-h-12 cursor-pointer items-center font-semibold underline">
                            {t.bookLater}
                          </summary>
                          <form action={decide} className="flex flex-col gap-2 pt-2">
                            <input type="hidden" name="visitId" value={v.id} />
                            <input type="hidden" name="decision" value="book" />
                            <span className="max-w-[40ch] text-slate/80">{t.bookLead}</span>
                            <label className="flex flex-col gap-1">
                              <span className="font-medium">{t.bookTime}</span>
                              <input
                                type="datetime-local"
                                name="start"
                                defaultValue={bookDefault}
                                required
                                className={field}
                              />
                            </label>
                            <Button
                              type="submit"
                              disabled={deciding}
                              aria-label={`${fill(t.bookConfirm, { name: v.hold.technicianName })}: ${rowLabel(v)}`}
                            >
                              {fill(t.bookConfirm, { name: v.hold.technicianName })}
                            </Button>
                          </form>
                        </details>
                        <details className="text-small">
                          <summary className="flex min-h-12 cursor-pointer items-center font-semibold underline">
                            {t.sendByTurn}
                          </summary>
                          <form action={decide} className="flex flex-col gap-2 pt-2">
                            <input type="hidden" name="visitId" value={v.id} />
                            <input type="hidden" name="decision" value="by_turn" />
                            <span className="max-w-[40ch] text-slate/80">{t.sendByTurnLead}</span>
                            <Button
                              type="submit"
                              tone="quiet"
                              disabled={deciding}
                              aria-label={`${t.sendByTurn}: ${rowLabel(v)}`}
                            >
                              {t.sendByTurn}
                            </Button>
                          </form>
                        </details>
                      </div>
                    </div>
                  ) : v.status === 'waiting' ? (
                    <span className="ml-auto flex flex-col items-end gap-2">
                      <form action={call}>
                        <input type="hidden" name="visitId" value={v.id} />
                        <Button
                          type="submit"
                          disabled={calling}
                          aria-label={`${t.callNext}: ${rowLabel(v)}`}
                        >
                          {t.callNext}
                        </Button>
                      </form>
                      {v.options.length > 0 ? (
                        // A higher-level technician is free but it is not hers by
                        // turn: the desk may ask her. Never automatic.
                        <details className="text-small">
                          <summary className="min-h-11 cursor-pointer py-2 font-semibold underline">
                            {t.askHigher}
                          </summary>
                          <div className="flex max-w-[44ch] flex-col gap-2">
                            <span className="text-slate/80">{t.askHigherLead}</span>
                            {v.options.map((o) => (
                              <form
                                key={o.technicianId}
                                action={ask}
                                className="flex flex-wrap items-center gap-3"
                              >
                                <input type="hidden" name="visitId" value={v.id} />
                                <input type="hidden" name="technicianId" value={o.technicianId} />
                                <input type="hidden" name="kind" value="offer" />
                                <Button
                                  type="submit"
                                  tone="quiet"
                                  disabled={asking || !o.canCall}
                                  aria-label={`${fill(t.askButton, { name: o.name })}: ${rowLabel(v)}`}
                                >
                                  {fill(t.askButton, { name: o.name })}
                                </Button>
                                <span className="text-slate/80">{optionLine(o)}</span>
                              </form>
                            ))}
                          </div>
                        </details>
                      ) : null}
                    </span>
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

/** Which waiting row a button acts on, for screen readers: every row has the
 *  same button words (Part 10 accessibility pass). */
function rowLabel(v: { kioskName: string | null; clientName: string | null; services: string[] }) {
  return v.clientName ?? v.kioskName ?? v.services.join(', ');
}

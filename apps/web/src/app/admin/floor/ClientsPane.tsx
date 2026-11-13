'use client';

// v0.18.0 (B9, B10, B11, B18, C2, C3, F1): the clients in three groups:
// Waiting (open), Being served (folded) and To check out (folded). Each row
// is titled by the person, has one main button and one "More". "Call next"
// at the top calls for the first client who can be called by turn; after a
// call the row says who and, under it, who was passed over and why.
import { useActionState, useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { AcceptFor, DenyFor, FinishFor } from '../ActForTech';
import {
  checkOutFor,
  clientHereFor,
  clientLeftFor,
  notHereFor,
  requestHoldFor,
  reviewFixFor,
  reviewKioskFor,
  setNoteFor,
  type DeskState,
} from '../actions';
import { skipText, visitChips } from '../chips';
import { firstCallable, notHereAction } from './model';
import type { CheckoutItem, ClientRow } from './types';
import { ActButton, Problem, useWords } from './ui';

export type ClientRights = { approve: boolean; actFor: boolean };

const field = 'min-h-11 rounded-control border-2 border-slate/30 bg-board px-3';

export function ClientsPane({
  rows,
  checkout,
  rights,
  freeReasons,
  bookDefault,
  onPick,
  call,
  callState,
  calling,
}: {
  rows: ClientRow[];
  checkout: { on: boolean; items: CheckoutItem[] };
  rights: ClientRights;
  freeReasons: readonly string[];
  bookDefault: string;
  onPick: (visitId: string) => void;
  call: (fd: FormData) => void;
  callState: DeskState;
  calling: boolean;
}) {
  const w = useWords();
  const f = w.floor;
  const waiting = rows.filter((r) => r.status !== 'in_service');
  const served = rows.filter((r) => r.status === 'in_service');
  const first = firstCallable(waiting);
  return (
    <section aria-labelledby="clients-h" className="flex min-h-0 flex-col bg-board">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3 pb-2">
        <h2 id="clients-h" className="text-lead font-semibold">
          {f.waiting} <span className="text-slate/60">({waiting.length})</span>
        </h2>
        <form action={call} className="flex">
          <input type="hidden" name="visitId" value={first?.id ?? ''} />
          <Button
            type="submit"
            disabled={calling || !first}
            aria-label={first ? fill(f.callNextFor, { who: first.who }) : f.nothingToCall}
            className="min-h-14 px-8 text-lead"
          >
            {f.callNext}
          </Button>
        </form>
      </div>
      {!first && waiting.length > 0 ? (
        <p className="px-4 pb-2 text-small text-slate/70">{f.nothingToCall}</p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {waiting.length === 0 ? <p className="px-4 pb-3 text-slate/70">{f.nobodyWaiting}</p> : null}
        <ol>
          {waiting.map((v) => (
            <Row
              key={v.id}
              v={v}
              first={first?.id === v.id}
              rights={rights}
              freeReasons={freeReasons}
              bookDefault={bookDefault}
              onPick={onPick}
              call={call}
              calling={calling}
              lastCall={callState.visitId === v.id ? callState : null}
            />
          ))}
        </ol>

        <details className="border-t-2 border-pumice">
          <summary className="flex min-h-12 cursor-pointer items-center px-4 font-semibold">
            {f.beingServed} <span className="pl-1 text-slate/60">({served.length})</span>
          </summary>
          {served.length === 0 ? <p className="px-4 pb-3 text-slate/70">{f.nobodyServed}</p> : null}
          <ol>
            {served.map((v) => (
              <li
                key={v.id}
                className="flex flex-wrap items-center gap-3 border-t border-pumice px-4 py-2"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-semibold">
                    {v.who} · {v.servicesText}
                  </span>
                  <span className="text-small text-slate/80">{v.callLine}</span>
                </span>
                {rights.actFor && v.assignedTechnicianId && v.assignedTechnician ? (
                  <FinishFor
                    technicianId={v.assignedTechnicianId}
                    visitId={v.id}
                    name={v.assignedTechnician}
                    label={v.who}
                    t={w.actFor}
                  />
                ) : null}
              </li>
            ))}
          </ol>
        </details>

        {checkout.on ? (
          <details className="border-t-2 border-pumice" id="to-check-out">
            <summary className="flex min-h-12 cursor-pointer items-center px-4 font-semibold">
              {f.toCheckOut} <span className="pl-1 text-slate/60">({checkout.items.length})</span>
            </summary>
            {checkout.items.length === 0 ? (
              <p className="px-4 pb-3 text-slate/70">{f.nobodyToCheckOut}</p>
            ) : null}
            <ol>
              {checkout.items.map((c) => (
                <li
                  key={c.visitId}
                  className="flex flex-wrap items-center gap-3 border-t border-pumice px-4 py-2"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-semibold">{c.who}</span>
                    {c.parts.map((p) => (
                      <span key={p} className="text-small text-slate/80">
                        {p}
                      </span>
                    ))}
                    <span className="text-small text-slate/70">{c.finished}</span>
                  </span>
                  <ActButton
                    action={checkOutFor}
                    fields={{ visitId: c.visitId }}
                    label={f.checkedOut}
                    ariaLabel={fill(f.checkedOutFor, { who: c.who })}
                  />
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
    </section>
  );
}

function Row({
  v,
  first,
  rights,
  freeReasons,
  bookDefault,
  onPick,
  call,
  calling,
  lastCall,
}: {
  v: ClientRow;
  first: boolean;
  rights: ClientRights;
  freeReasons: readonly string[];
  bookDefault: string;
  onPick: (visitId: string) => void;
  call: (fd: FormData) => void;
  calling: boolean;
  lastCall: DeskState | null;
}) {
  const w = useWords();
  const f = w.floor;
  const d = w.desk;
  const [moreOpen, setMoreOpen] = useState(false);
  const moreId = useId();
  const chips = visitChips(v, d.chips);
  const notHere = notHereAction(v);
  const plain =
    v.status === 'waiting' &&
    !v.needsConfirm &&
    !v.needsApproval &&
    !v.deskPicks &&
    !v.held &&
    !v.hold;
  const flagged = v.needsConfirm || v.needsApproval || v.leftClaimPending;
  const notHereButton = notHere ? (
    <ActButton
      action={notHereFor}
      fields={{ visitId: v.id, kind: notHere }}
      label={f.notHere}
      ariaLabel={`${f.notHere}: ${v.who}`}
      tone="quiet"
    />
  ) : null;

  // The one main button (and, where the brief keeps two in view, a second).
  let main: ReactNode = null;
  if (v.status === 'waiting' && v.needsApproval) {
    main = rights.approve ? (
      <ActButton
        action={reviewFixFor}
        fields={{ visitId: v.id, decision: 'approve' }}
        label={d.fixApprove}
        ariaLabel={`${d.fixApprove}: ${v.who}`}
      />
    ) : (
      <span className="text-small font-semibold">{f.waitsForManager}</span>
    );
  } else if (v.status === 'waiting' && v.needsConfirm) {
    const group = v.partyId && v.partySize && v.partySize > 1;
    main = (
      <span className="flex flex-wrap justify-end gap-2">
        <ActButton
          action={reviewKioskFor}
          fields={
            group
              ? { visitId: v.id, decision: 'confirm', wholeParty: 'true' }
              : { visitId: v.id, decision: 'confirm' }
          }
          label={group ? fill(d.groupConfirmAll, { n: v.partySize ?? 0 }) : d.kioskConfirm}
          ariaLabel={`${d.kioskConfirm}: ${v.who}`}
        />
        {notHereButton}
      </span>
    );
  } else if (v.status === 'waiting' && v.held) {
    main = (
      <span className="max-w-[24ch] text-right text-small font-medium text-slate/80">
        {v.held.technician ? fill(d.heldLine, { name: v.held.technician }) : d.heldNobody}
      </span>
    );
  } else if (v.status === 'waiting' && v.hold) {
    main = (
      <ActButton
        action={requestHoldFor}
        fields={{ visitId: v.id, decision: 'keep' }}
        label={d.keepWaiting}
        ariaLabel={`${d.keepWaiting}: ${v.who}`}
        tone="quiet"
      />
    );
  } else if (v.status === 'waiting') {
    main = (
      <Button
        type="button"
        tone={v.deskPicks ? 'primary' : 'quiet'}
        onClick={() => onPick(v.id)}
        aria-label={`${f.pickSomeone}: ${v.who}`}
      >
        {f.pickSomeone}
      </Button>
    );
  } else if (v.status === 'called' && v.leftClaimPending) {
    main = (
      <span className="flex flex-wrap justify-end gap-2">
        <ActButton
          action={clientLeftFor}
          fields={{ visitId: v.id }}
          label={d.claimConfirm}
          ariaLabel={`${d.claimConfirm}: ${v.who}`}
        />
        <ActButton
          action={clientHereFor}
          fields={{ visitId: v.id }}
          label={d.claimHere}
          ariaLabel={`${d.claimHere}: ${v.who}`}
          tone="quiet"
        />
      </span>
    );
  } else if (v.status === 'called' && rights.actFor && v.callId && v.calledTechnician) {
    main = <AcceptFor callId={v.callId} name={v.calledTechnician} label={v.who} t={w.actFor} />;
  }

  const showMore =
    (v.status === 'waiting' || v.status === 'called') &&
    !(v.status === 'called' && v.leftClaimPending);
  const skipped = lastCall?.skipped ?? [];
  return (
    <li
      className={`flex flex-col gap-2 border-t border-pumice py-2 pr-4 ${flagged ? 'border-l-[10px] border-l-amber pl-3' : 'pl-4'} ${first ? 'bg-teal/5' : ''}`}
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex min-w-0 flex-1 basis-60 flex-col">
          <span className="text-lead leading-snug">
            <span className="font-semibold">{v.who}</span>
            <span className="text-slate/80"> · {v.servicesText}</span>
            {v.wait ? <span className="text-slate/60"> · {v.wait}</span> : null}
          </span>
          <span className="flex flex-wrap items-center gap-2 text-small">
            {v.partySize && v.partySize > 1 ? (
              <span className="rounded-control bg-teal px-2 py-0.5 font-semibold text-board">
                {fill(d.groupOf, { n: v.partySize })}
              </span>
            ) : null}
            {v.isFix ? (
              <span className="rounded-control border-2 border-navy px-2 font-semibold">
                {d.fixBadge}
              </span>
            ) : null}
            {v.isFix ? (
              <span className={v.fixOf ? 'text-slate/80' : 'font-semibold text-polish'}>
                {v.fixOf
                  ? fill(d.fixOfLine, {
                      date: v.fixOf.date,
                      services: v.fixOf.services.join(' + '),
                      tech: v.fixOf.technician ?? d.fixNoTech,
                    })
                  : d.fixNoOrigin}
              </span>
            ) : null}
            {v.fromKiosk ? (
              <span className="font-semibold">
                {v.needsConfirm ? d.kioskPending : d.kioskConfirmed}
              </span>
            ) : null}
            {v.splitRest ? (
              <span className="rounded-control bg-pumice px-2">{d.splitRest}</span>
            ) : null}
            {v.requestedTechnician ? (
              <span className="rounded-control bg-navy px-2 font-semibold text-board">
                {fill(v.booked ? d.bookedWith : d.askedFor, { name: v.requestedTechnician })}
              </span>
            ) : null}
            {chips.map((c) => (
              <span key={c} className="rounded-control bg-pumice px-2">
                {c}
              </span>
            ))}
          </span>
          {v.slip ? (
            <span className="text-small text-slate/80">
              {fill(d.slipLine, {
                parts: v.slip
                  .map((p) =>
                    p.technician
                      ? fill(p.done === false ? d.slipDoing : d.slipPart, {
                          name: p.technician,
                          services: p.services.join(' + '),
                        })
                      : fill(d.slipNobody, { services: p.services.join(' + ') }),
                  )
                  .join('; '),
              })}
            </span>
          ) : null}
          {v.note ? (
            <span className="w-fit rounded-control border-2 border-amber bg-amber/10 px-2 text-small font-medium">
              {fill(d.requestNote, { note: v.note })}
            </span>
          ) : null}
          {v.callLine ? <span className="font-semibold text-polish">{v.callLine}</span> : null}
          {v.status === 'called' && v.leftClaimPending ? (
            <span className="font-semibold">
              {fill(d.claimLine, { name: v.calledTechnician ?? '' })}
            </span>
          ) : null}
          {v.status === 'waiting' && v.hold ? (
            <span className={`text-small ${v.hold.attention ? 'font-semibold text-polish' : ''}`}>
              {v.hold.attention
                ? fill(d.holdFlag, { name: v.hold.technicianName, minutes: v.hold.waitedMin })
                : fill(d.holdTitle, { name: v.hold.technicianName })}
              {' · '}
              {fill(v.hold.forMinutes === null ? d.holdStatusPlain : d.holdStatus, {
                name: v.hold.technicianName,
                why: fill(d.skip[v.hold.why] ?? v.hold.why, { detail: v.hold.detail ?? '' }),
                minutes: v.hold.forMinutes ?? 0,
              })}
              {' · '}
              {v.hold.nextAppointment
                ? fill(d.holdNext, { time: v.hold.nextAppointment })
                : d.holdNoNext}
            </span>
          ) : null}
        </span>
        <span className="ml-auto flex flex-wrap items-start justify-end gap-2">
          {main}
          {showMore ? (
            <Button
              type="button"
              tone="quiet"
              aria-expanded={moreOpen}
              aria-controls={moreId}
              aria-label={fill(f.moreFor, { who: v.who })}
              onClick={() => setMoreOpen((o) => !o)}
            >
              {f.more}
            </Button>
          ) : null}
        </span>
      </div>

      {lastCall?.error ? (
        <p role="alert" className="text-small text-polish">
          {d.errors[lastCall.error] ?? lastCall.error}
          {lastCall.error === 'nobody_eligible' && skipped.length
            ? ` ${fill(d.nobodyLine, {
                list: skipped
                  .map((s) =>
                    fill(d.skippedLine, { name: s.displayName, why: skipText(s, d.skip) }),
                  )
                  .join('; '),
              })}`
            : ''}
        </p>
      ) : skipped.length > 0 ? (
        // B11: who was passed over for this call, under the call it explains.
        <details className="text-small">
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
            {fill(f.whyNot, { names: skipped.map((s) => s.displayName).join(', ') })}
          </summary>
          <ul className="flex flex-col gap-1 pb-1">
            {skipped.map((s, i) => (
              <li key={`${s.displayName}-${i}`} className="text-slate/80">
                {fill(d.skippedLine, { name: s.displayName, why: skipText(s, d.skip) })}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {showMore && moreOpen ? (
        <div id={moreId} className="border-t-2 border-dashed border-pumice text-small">
          <div className="flex max-w-[44ch] flex-col gap-3 py-2">
            {plain && !first ? (
              <form action={call} className="flex flex-col gap-1">
                <input type="hidden" name="visitId" value={v.id} />
                <span className="text-slate/80">{f.callLead}</span>
                <Button
                  type="submit"
                  tone="quiet"
                  disabled={calling}
                  aria-label={`${f.call}: ${v.who}`}
                >
                  {f.call}
                </Button>
              </form>
            ) : null}
            {v.status === 'waiting' && v.needsConfirm ? (
              <>
                {v.partyId && v.partySize && v.partySize > 1 ? (
                  <ActButton
                    action={reviewKioskFor}
                    fields={{ visitId: v.id, decision: 'confirm' }}
                    label={d.kioskConfirm}
                    tone="quiet"
                  />
                ) : null}
                {v.requestedTechnician ? (
                  <ActButton
                    action={reviewKioskFor}
                    fields={{ visitId: v.id, decision: 'confirm_no_request' }}
                    label={d.kioskConfirmNoRequest}
                    ariaLabel={`${d.kioskConfirmNoRequest}: ${v.who}`}
                    tone="quiet"
                  />
                ) : null}
              </>
            ) : null}
            {v.status === 'waiting' && v.needsApproval && rights.approve ? (
              <ActButton
                action={reviewFixFor}
                fields={{ visitId: v.id, decision: 'decline' }}
                label={d.fixDecline}
                ariaLabel={`${d.fixDecline}: ${v.who}`}
                tone="quiet"
              />
            ) : null}
            {v.status === 'waiting' && v.hold ? (
              <>
                <BookLater v={v} bookDefault={bookDefault} />
                <span className="text-slate/80">{d.sendByTurnLead}</span>
                <ActButton
                  action={requestHoldFor}
                  fields={{ visitId: v.id, decision: 'by_turn' }}
                  label={d.sendByTurn}
                  ariaLabel={`${d.sendByTurn}: ${v.who}`}
                  tone="quiet"
                />
              </>
            ) : null}
            {v.status === 'called' && rights.actFor && v.callId && v.calledTechnician ? (
              <DenyFor
                callId={v.callId}
                name={v.calledTechnician}
                reasons={w.reasons}
                freeReasons={v.callKind === 'turn' ? freeReasons : []}
                freeLabel={w.freeLabel}
                label={v.who}
                t={w.actFor}
              />
            ) : null}
            <NoteForm v={v} />
            {notHere && !v.needsConfirm ? (
              <div className="flex flex-col gap-1">
                <span className="text-slate/80">{f.notHereLead[notHere]}</span>
                {notHereButton}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** "Add a request" / "Edit request", inside More (C3). */
function NoteForm({ v }: { v: ClientRow }) {
  const w = useWords();
  const d = w.desk;
  return <ActNote v={v} title={v.note ? d.editNote : d.addNote} save={d.saveNote} label={d.note} />;
}

function ActNote({
  v,
  title,
  save,
  label,
}: {
  v: ClientRow;
  title: string;
  save: string;
  label: string;
}) {
  const [state, action, pending] = useActionState<DeskState, FormData>(setNoteFor, {});
  return (
    <form action={action} className="flex flex-col gap-1">
      <span className="font-semibold">{title}</span>
      <input type="hidden" name="visitId" value={v.id} />
      <input
        name="note"
        defaultValue={v.note ?? ''}
        maxLength={300}
        aria-label={`${label}: ${v.who}`}
        className={field}
      />
      <Button type="submit" tone="quiet" disabled={pending}>
        {save}
      </Button>
      <Problem state={state} />
    </form>
  );
}

/** A busy requested tech: book the client with her for later. */
function BookLater({ v, bookDefault }: { v: ClientRow; bookDefault: string }) {
  const w = useWords();
  const d = w.desk;
  const [state, action, pending] = useActionState<DeskState, FormData>(requestHoldFor, {});
  if (!v.hold) return null;
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="visitId" value={v.id} />
      <input type="hidden" name="decision" value="book" />
      <span className="font-semibold">{d.bookLater}</span>
      <span className="text-slate/80">{d.bookLead}</span>
      <label className="flex flex-col gap-1">
        <span className="font-medium">{d.bookTime}</span>
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
        tone="quiet"
        disabled={pending}
        aria-label={`${fill(d.bookConfirm, { name: v.hold.technicianName })}: ${v.who}`}
      >
        {fill(d.bookConfirm, { name: v.hold.technicianName })}
      </Button>
      <Problem state={state} />
    </form>
  );
}

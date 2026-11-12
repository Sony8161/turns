'use client';

import { ErrorRef } from '@/components/ErrorRef';
import { useActionState, useState } from 'react';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { answerCall, type MeState } from './actions';

const DENY_REASONS = [
  'not_my_service',
  'with_another_client',
  'break_needed',
  'personal',
  'client_issue',
  'other',
] as const;

/** The call on the technician's phone: the services, Accept, or Deny with a
 *  reason. The penalty is stated before they can deny. */
export function CallPanel({
  callId,
  services,
  serviceItems = [],
  kind = 'turn',
  requested = false,
  note = null,
  slip = null,
  excusedReasons = [],
  waitedSeconds,
  denyPenalty,
  t,
}: {
  /** v0.15.0: the earlier parts of this client's visit, when another
   *  technician did some of it first (the on-screen slip). */
  slip?: { technician: string | null; services: string[] }[] | null;
  /** v0.15.0: deny reasons the rules excuse on their own (no points). */
  excusedReasons?: readonly string[];
  callId: string;
  services: string[];
  /** v0.14.0: with ids, so a visit of two or more services can be split. */
  serviceItems?: { id: string; name: string; canDo?: boolean }[];
  /** 'turn' = called by the line; 'offer' / 'desk_pick' = the desk asked:
   *  saying no is never a penalty. */
  kind?: string;
  /** v0.10.2: the client asked for this technician. */
  requested?: boolean;
  /** v0.10.2: the design or special request, only for the call to this tech. */
  note?: string | null;
  waitedSeconds: number;
  denyPenalty: number;
  t: Dictionary['me'];
}) {
  const [state, action, pending] = useActionState<MeState, FormData>(answerCall, {});
  const [denying, setDenying] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const asked = kind !== 'turn';
  // v0.15.0: on a visit of several services she keeps only what she does;
  // the rest goes on to the next technician after she finishes.
  const mine = serviceItems.filter((i) => i.canDo !== false);
  const notMine = serviceItems.filter((i) => i.canDo === false);
  const canSplit = mine.length > 1;

  return (
    <form
      action={action}
      className="flex flex-col gap-4 border-l-[12px] border-polish bg-board p-5"
    >
      <input type="hidden" name="callId" value={callId} />
      <h2 className="text-heading font-semibold">
        {kind === 'offer'
          ? t.call.offerTitle
          : kind === 'desk_pick'
            ? t.call.pickTitle
            : t.call.title}
      </h2>
      <p className="text-name leading-tight font-semibold">{services.join(', ')}</p>
      {requested ? (
        <p className="w-fit rounded-control bg-navy px-3 py-1 font-semibold text-board">
          {t.call.requested}
        </p>
      ) : null}
      {note ? (
        <p className="border-2 border-amber bg-amber/10 px-3 py-2 text-lead font-medium">
          {fill(t.call.noteLine, { note })}
        </p>
      ) : null}
      {slip ? (
        <div className="flex flex-col gap-1 border-2 border-slate/30 px-3 py-2">
          <span className="font-semibold">{t.call.slipTitle}</span>
          {slip.map((p, i) => (
            <span key={i}>
              {p.technician
                ? fill(t.call.slipDone, { name: p.technician, services: p.services.join(' + ') })
                : fill(t.call.slipNobody, { services: p.services.join(' + ') })}
            </span>
          ))}
          <span className="font-medium">
            {fill(t.call.slipLeft, { services: services.join(' + ') })}
          </span>
        </div>
      ) : null}
      {notMine.length > 0 && mine.length > 0 ? (
        <p className="border-l-[12px] border-navy bg-pumice/40 px-3 py-2 font-medium">
          {fill(t.call.partLead, { services: mine.map((i) => i.name).join(' + ') })}{' '}
          {fill(t.call.partRest, { services: notMine.map((i) => i.name).join(' + ') })}
        </p>
      ) : null}
      {asked ? <p className="font-medium text-slate">{t.call.offerNote}</p> : null}
      <p className="text-slate/70">{fill(t.call.waitedLine, { seconds: waitedSeconds })}</p>
      {state.error ? (
        <p role="alert" className="text-polish">
          {t.errors[state.error]}
          <ErrorRef refId={state.ref} />
        </p>
      ) : null}
      {splitting ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 font-medium">{t.call.splitLead}</legend>
          {mine.map((item) => (
            <label key={item.id} className="flex min-h-12 items-center gap-3 text-lead">
              <input type="checkbox" name="keep" value={item.id} className="h-7 w-7" />
              <span>{item.name}</span>
            </label>
          ))}
          <Button
            type="submit"
            name="intent"
            value="split"
            disabled={pending}
            className="min-h-14 text-kiosk-button"
          >
            {t.call.splitConfirm}
          </Button>
          <button
            type="button"
            onClick={() => setSplitting(false)}
            className="min-h-11 self-start underline"
          >
            {t.call.back}
          </button>
        </fieldset>
      ) : !denying ? (
        <div className="flex flex-col gap-3">
          <Button
            type="submit"
            name="intent"
            value="accept"
            disabled={pending}
            className="min-h-14 text-kiosk-button"
          >
            {notMine.length > 0 && mine.length > 0
              ? t.call.acceptPart
              : canSplit
                ? t.call.doAll
                : t.call.accept}
          </Button>
          {canSplit ? (
            <Button
              type="button"
              tone="quiet"
              onClick={() => setSplitting(true)}
              className="min-h-14"
            >
              {t.call.split}
            </Button>
          ) : null}
          {asked ? (
            <Button
              type="submit"
              name="intent"
              value="decline"
              tone="quiet"
              disabled={pending}
              className="min-h-14"
            >
              {t.call.decline}
            </Button>
          ) : (
            <Button
              type="button"
              tone="quiet"
              onClick={() => setDenying(true)}
              className="min-h-14"
            >
              {t.call.deny}
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="font-semibold text-polish">
            {fill(excusedReasons.length ? t.call.penaltyNoteFree : t.call.penaltyNote, {
              points: denyPenalty,
            })}
          </p>
          {DENY_REASONS.map((r) => (
            <Button
              key={r}
              type="submit"
              name="intent"
              value={`deny:${r}`}
              tone="quiet"
              disabled={pending}
            >
              {excusedReasons.includes(r)
                ? fill(t.call.freeReason, { reason: t.call.reasons[r] })
                : t.call.reasons[r]}
            </Button>
          ))}
          <button
            type="button"
            onClick={() => setDenying(false)}
            className="min-h-11 self-start underline"
          >
            {t.call.back}
          </button>
        </div>
      )}
    </form>
  );
}

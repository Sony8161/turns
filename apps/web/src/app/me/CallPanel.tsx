'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { answerCall, type MeState } from './actions';

const DENY_REASONS = [
  'not_my_service',
  'with_another_client',
  'break_needed',
  'client_issue',
  'other',
] as const;

/** The call on the technician's phone: the services, Accept, or Deny with a
 *  reason. The penalty is stated before they can deny. */
export function CallPanel({
  callId,
  services,
  waitedSeconds,
  denyPenalty,
  t,
}: {
  callId: string;
  services: string[];
  waitedSeconds: number;
  denyPenalty: number;
  t: Dictionary['me'];
}) {
  const [state, action, pending] = useActionState<MeState, FormData>(answerCall, {});
  const [denying, setDenying] = useState(false);

  return (
    <form
      action={action}
      className="flex flex-col gap-4 border-l-[12px] border-polish bg-board p-5"
    >
      <input type="hidden" name="callId" value={callId} />
      <h2 className="text-heading font-semibold">{t.call.title}</h2>
      <p className="text-name leading-tight font-semibold">{services.join(', ')}</p>
      <p className="text-slate/70">{fill(t.call.waitedLine, { seconds: waitedSeconds })}</p>
      {state.error ? <p className="text-polish">{t.errors[state.error]}</p> : null}
      {!denying ? (
        <div className="flex flex-col gap-3">
          <Button
            type="submit"
            name="intent"
            value="accept"
            disabled={pending}
            className="min-h-14 text-kiosk-button"
          >
            {t.call.accept}
          </Button>
          <Button type="button" tone="quiet" onClick={() => setDenying(true)} className="min-h-14">
            {t.call.deny}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="font-semibold text-polish">
            {fill(t.call.penaltyNote, { points: denyPenalty })}
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
              {t.call.reasons[r]}
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

'use client';

// v0.16.0 on the technician's phone: "Client left" on an open call (the client
// walked out before she started: no points, she keeps her place), and "Need
// help" with an optional short reason (the desk board shows it until someone
// acknowledges it).
import { useActionState } from 'react';
import { ErrorRef } from '@/components/ErrorRef';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { askHelp, markClientLeft, type MeState } from './actions';

export function ClientLeftButton({ visitId, t }: { visitId: string; t: Dictionary['me'] }) {
  const [state, action, pending] = useActionState<MeState, FormData>(markClientLeft, {});
  return (
    <form action={action} className="flex flex-col gap-2 bg-board p-4">
      <input type="hidden" name="visitId" value={visitId} />
      <Button type="submit" tone="quiet" disabled={pending}>
        {t.call.clientLeft}
      </Button>
      <span className="text-small text-slate/80">{t.call.clientLeftNote}</span>
      {state.error ? (
        <p role="alert" className="text-polish">
          {t.errors[state.error] ?? state.error}
          <ErrorRef refId={state.ref} />
        </p>
      ) : null}
    </form>
  );
}

export function HelpPanel({
  openMinutes,
  t,
}: {
  /** Minutes since her open request; null when there is none. */
  openMinutes: number | null;
  t: Dictionary['me'];
}) {
  const [state, action, pending] = useActionState<MeState, FormData>(askHelp, {});
  if (openMinutes !== null) {
    return (
      <p role="status" className="border-l-[12px] border-amber bg-board p-4 font-semibold">
        {openMinutes < 1 ? t.help.openNow : fill(t.help.open, { minutes: openMinutes })}
      </p>
    );
  }
  return (
    <details className="bg-board p-4">
      <summary className="flex min-h-12 cursor-pointer items-center text-lead font-semibold">
        {t.help.button}
      </summary>
      <form action={action} className="flex flex-col gap-3 pt-3">
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t.help.reason}</span>
          <input
            name="reason"
            maxLength={80}
            className="min-h-12 rounded-control border-2 border-slate/30 bg-board px-3 text-lead"
          />
        </label>
        <Button type="submit" disabled={pending}>
          {t.help.send}
        </Button>
        {state.error ? (
          <p role="alert" className="text-polish">
            {t.errors[state.error] ?? state.error}
            <ErrorRef refId={state.ref} />
          </p>
        ) : null}
      </form>
    </details>
  );
}

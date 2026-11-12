'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui';
import type { Dictionary } from '@/i18n/dictionary';
import { receptionistEditsAction, type ToggleState } from './toggle-actions';

/** Owner only: may receptionists change technicians? (v0.13.0, default on.) */
export function ReceptionistToggle({ on, t }: { on: boolean; t: Dictionary['techSettings'] }) {
  const [state, action, pending] = useActionState<ToggleState, FormData>(
    receptionistEditsAction,
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-2 bg-board p-5">
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" name="on" defaultChecked={on} className="h-6 w-6" />
        <span className="font-medium">{t.receptionistToggle}</span>
      </label>
      <span className="text-small text-slate/70">{t.receptionistToggleHint}</span>
      <div className="flex items-center gap-3">
        <Button type="submit" tone="quiet" disabled={pending}>
          {t.receptionistSave}
        </Button>
        {state.saved ? (
          <span role="status" className="font-semibold text-teal">
            {t.receptionistSaved}
          </span>
        ) : null}
        {state.error ? (
          <span role="alert" className="font-semibold text-polish">
            {t.errors[state.error] ?? t.errors.server}
          </span>
        ) : null}
      </div>
    </form>
  );
}

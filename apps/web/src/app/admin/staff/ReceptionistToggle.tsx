'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui';
import type { Dictionary } from '@/i18n/dictionary';
import {
  receptionistActsForAction,
  receptionistEditsAction,
  type ToggleState,
} from './toggle-actions';

/** Owner only: may receptionists change technicians? (v0.13.0, default on.)
 *  v0.17.0: the same switch for acting for a technician (kind 'act_for'). */
export function ReceptionistToggle({
  on,
  t,
  kind = 'edits',
}: {
  on: boolean;
  t: Dictionary['techSettings'];
  kind?: 'edits' | 'act_for';
}) {
  const [state, action, pending] = useActionState<ToggleState, FormData>(
    kind === 'act_for' ? receptionistActsForAction : receptionistEditsAction,
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-2 bg-board p-5">
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" name="on" defaultChecked={on} className="h-6 w-6" />
        <span className="font-medium">
          {kind === 'act_for' ? t.actForToggle : t.receptionistToggle}
        </span>
      </label>
      <span className="text-small text-slate/70">
        {kind === 'act_for' ? t.actForToggleHint : t.receptionistToggleHint}
      </span>
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

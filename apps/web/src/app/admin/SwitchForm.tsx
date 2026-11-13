'use client';

import { useActionState } from 'react';
import { ErrorRef } from '@/components/ErrorRef';
import { Button } from '@/components/ui';
import type { SwitchState } from './settings-actions';

/** v0.18.0: one owner switch with Save, for the settings under Advanced. */
export function SwitchForm({
  action,
  on,
  label,
  hint,
  save,
  saved,
  failed,
}: {
  action: (prev: SwitchState, formData: FormData) => Promise<SwitchState>;
  on: boolean;
  label: string;
  hint: string;
  save: string;
  saved: string;
  failed: string;
}) {
  const [state, submit, pending] = useActionState<SwitchState, FormData>(action, {});
  return (
    <form action={submit} className="flex flex-col gap-2">
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" name="on" defaultChecked={on} className="h-6 w-6" />
        <span className="font-medium">{label}</span>
      </label>
      <span className="max-w-[70ch] text-small text-slate/70">{hint}</span>
      <div className="flex items-center gap-3">
        <Button type="submit" tone="quiet" disabled={pending}>
          {save}
        </Button>
        {state.saved ? (
          <span role="status" className="font-semibold text-teal">
            {saved}
          </span>
        ) : null}
        {state.error ? (
          <span role="alert" className="font-semibold text-polish">
            {failed}
            <ErrorRef refId={state.ref} />
          </span>
        ) : null}
      </div>
    </form>
  );
}

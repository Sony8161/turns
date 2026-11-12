'use client';

import { useActionState } from 'react';
import { ErrorRef } from '@/components/ErrorRef';
import { Button } from '@/components/ui';
import type { Dictionary } from '@/i18n/dictionary';
import { saveClientAction, type ClientState } from './actions';

/** The desk edits a client's first and last name and notes (v0.13.0). */
export function ClientForm({
  clientId,
  firstName,
  lastName,
  notes,
  t,
}: {
  clientId: string;
  firstName: string;
  lastName: string;
  notes: string;
  t: Dictionary['clients'];
}) {
  const [state, action, pending] = useActionState<ClientState, FormData>(saveClientAction, {});
  const field = 'min-h-12 rounded-control border-2 border-slate/30 bg-board px-3 text-lead';
  return (
    <form action={action} className="flex flex-col gap-4 bg-board p-5">
      <input type="hidden" name="clientId" value={clientId} />
      <h2 className="text-heading font-semibold">{t.editTitle}</h2>
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t.firstName}</span>
          <input
            name="firstName"
            defaultValue={firstName}
            maxLength={60}
            className={`${field} w-56`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t.lastName}</span>
          <input
            name="lastName"
            defaultValue={lastName}
            maxLength={60}
            className={`${field} w-56`}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="font-medium">{t.notes}</span>
        <textarea
          name="notes"
          defaultValue={notes}
          maxLength={500}
          rows={3}
          className="rounded-control border-2 border-slate/30 bg-board p-3 text-lead"
        />
        <span className="text-small text-slate/70">{t.notesHint}</span>
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {t.save}
        </Button>
        {state.saved ? (
          <span role="status" className="font-semibold text-teal">
            {t.saved}
          </span>
        ) : null}
        {state.error ? (
          <span role="alert" className="font-semibold text-polish">
            {t.errors[state.error] ?? t.errors.server}
            <ErrorRef refId={state.ref} />
          </span>
        ) : null}
      </div>
    </form>
  );
}

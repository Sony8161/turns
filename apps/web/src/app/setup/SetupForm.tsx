'use client';

import { ErrorRef } from '@/components/ErrorRef';
import { useActionState } from 'react';
import { Button, Field } from '@/components/ui';
import type { Dictionary } from '@/i18n/dictionary';
import { startSetup, type SetupState } from './actions';

export function SetupForm({ t, initialError }: { t: Dictionary['setup']; initialError?: string }) {
  const initial: SetupState =
    initialError === 'used' || initialError === 'expired' || initialError === 'unknown'
      ? { error: initialError }
      : {};
  const [state, action, pending] = useActionState<SetupState, FormData>(startSetup, initial);
  const codeError = state.error && state.error !== 'fields' ? t.errors[state.error] : undefined;
  const fieldsError = state.error === 'fields' ? t.errors.fields : undefined;
  const typed = state.typed;

  return (
    <form action={action} className="flex flex-col gap-5">
      <Field
        id="code"
        name="code"
        label={t.code}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder="ABCDE-FGHJK"
        defaultValue={typed?.code ?? ''}
        required
        autoFocus
        error={codeError}
      />
      <Field
        id="name"
        name="name"
        label={t.name}
        autoComplete="name"
        maxLength={80}
        defaultValue={typed?.name ?? ''}
        required
      />
      <Field
        id="salonName"
        name="salonName"
        label={t.salonName}
        autoComplete="organization"
        maxLength={80}
        defaultValue={typed?.salonName ?? ''}
        required
      />
      <Field
        id="locationName"
        name="locationName"
        label={t.locationName}
        maxLength={80}
        defaultValue={typed?.locationName ?? ''}
        required
        error={fieldsError}
      />
      <Button type="submit" disabled={pending}>
        {t.continue}
      </Button>
      <ErrorRef refId={state.ref} />
    </form>
  );
}

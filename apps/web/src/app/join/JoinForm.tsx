'use client';

import { useActionState } from 'react';
import { Button, Field } from '@/components/ui';
import type { Dictionary } from '@/i18n/dictionary';
import { startJoin, type JoinState } from './actions';

export function JoinForm({ t, initialError }: { t: Dictionary['join']; initialError?: string }) {
  const initial: JoinState =
    initialError === 'used' || initialError === 'expired' || initialError === 'unknown'
      ? { error: initialError }
      : {};
  const [state, action, pending] = useActionState<JoinState, FormData>(startJoin, initial);
  const codeError = state.error && state.error !== 'name' ? t.errors[state.error] : undefined;
  const nameError = state.error === 'name' ? t.errors.name : undefined;

  // React resets the form after each action; keep what was typed on an error.
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
        defaultValue={state.typed?.code ?? ''}
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
        defaultValue={state.typed?.name ?? ''}
        required
        error={nameError}
      />
      <Button type="submit" disabled={pending}>
        {t.continue}
      </Button>
    </form>
  );
}

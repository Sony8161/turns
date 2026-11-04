'use client';

import { useActionState } from 'react';
import { Button, Field } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { maskContact } from '@/lib/contact';
import { login, type LoginState } from './actions';

export function LoginForm({ t }: { t: Dictionary['login'] }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {
    step: 'contact',
  });

  if (state.step === 'code') {
    return (
      <form action={action} className="flex flex-col gap-5">
        <p>{fill(t.codeSentTo, { contact: maskContact(state.contact) })}</p>
        <Field
          id="code"
          name="code"
          label={t.code}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
          error={state.error ? t.errors[state.error] : undefined}
        />
        <Button type="submit" name="intent" value="verify" disabled={pending}>
          {t.verify}
        </Button>
        <button
          type="submit"
          name="intent"
          value="back"
          formNoValidate
          className="min-h-11 self-start text-slate/80 underline"
        >
          {t.changeContact}
        </button>
      </form>
    );
  }

  // React resets the form after each action; keep what was typed on an error.
  return (
    <form action={action} className="flex flex-col gap-5">
      <Field
        id="contact"
        name="contact"
        label={t.contact}
        type="text"
        inputMode="email"
        autoComplete="username"
        defaultValue={state.typed ?? ''}
        required
        autoFocus
        error={state.error ? t.errors[state.error] : undefined}
      />
      <Button type="submit" name="intent" value="send" disabled={pending}>
        {t.sendCode}
      </Button>
    </form>
  );
}

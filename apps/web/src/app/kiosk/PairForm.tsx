'use client';

import { useActionState } from 'react';
import type { Dictionary } from '@/i18n/dictionary';
import { pairThisIpad, type KioskState } from './actions';

/** First run on a new iPad: the pairing code from Admin → Kiosk. */
export function PairForm({ t }: { t: Dictionary['kiosk'] }) {
  const [state, action, pending] = useActionState<KioskState, FormData>(pairThisIpad, {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <label className="flex flex-col gap-2">
        <span className="text-lead font-medium">{t.pairCode}</span>
        <input
          name="code"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          maxLength={20}
          className="min-h-16 rounded-control border-4 border-slate/30 bg-board px-5 text-kiosk-button tracking-widest uppercase"
        />
      </label>
      {state.error ? (
        <p role="alert" className="font-semibold text-polish">
          {t.errors[state.error] ?? state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="min-h-16 rounded-control bg-navy px-8 text-lead font-semibold text-board disabled:opacity-50"
      >
        {t.pair}
      </button>
    </form>
  );
}

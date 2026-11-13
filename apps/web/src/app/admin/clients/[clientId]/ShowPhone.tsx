'use client';

// v0.17.1 (review #4): a receptionist sees the last four digits; "Show" asks
// the server for the whole number. Each tap is counted against her lookup
// limit and goes to the log (without the number). The number is never kept
// in the page after she leaves it.
import { useState, useTransition } from 'react';
import { ErrorRef } from '@/components/ErrorRef';
import { Button } from '@/components/ui';
import type { Dictionary } from '@/i18n/dictionary';
import { showClientPhone, type ShowPhoneState } from './actions';

export function ShowPhone({
  clientId,
  masked,
  t,
}: {
  clientId: string;
  masked: string;
  t: Dictionary['clients'];
}) {
  const [state, setState] = useState<ShowPhoneState>({});
  const [pending, start] = useTransition();
  const shown = state.phone;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-lead tabular-nums">{shown || masked}</p>
      {shown ? null : (
        <Button
          type="button"
          tone="quiet"
          disabled={pending}
          onClick={() => start(async () => setState(await showClientPhone(clientId)))}
        >
          {t.showPhone}
        </Button>
      )}
      {state.error ? (
        <p role="alert" className="w-full text-polish">
          {t.phoneErrors[state.error] ?? t.phoneErrors.server}
          <ErrorRef refId={state.ref} />
        </p>
      ) : null}
      {shown ? null : <p className="w-full text-small text-slate/70">{t.showPhoneNote}</p>}
    </div>
  );
}

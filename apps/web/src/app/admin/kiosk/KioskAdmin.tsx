'use client';

import { ErrorRef } from '@/components/ErrorRef';
import { useActionState } from 'react';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import {
  registerKiosk,
  repairKiosk,
  revokeKioskAction,
  makeThisIpadTheKiosk,
  type KioskAdminState,
} from './actions';

export type KioskRowView = {
  id: string;
  name: string;
  state: string;
  revoked: boolean;
};

const field = 'min-h-12 rounded-control border-2 border-slate/30 bg-board px-3 text-lead';

function CodeShown({
  state,
  t,
  minutes,
}: {
  state: KioskAdminState;
  t: Dictionary['kioskAdmin'];
  minutes: number;
}) {
  if (!state.code) return null;
  return (
    <div
      aria-live="polite"
      className="flex flex-col gap-1 border-l-[12px] border-teal bg-board p-4"
    >
      <span className="text-heading font-semibold tracking-widest">{state.code}</span>
      <span className="text-slate/80">{fill(t.codeHint, { minutes })}</span>
    </div>
  );
}

export function KioskAdmin({
  t,
  rows,
  pairingMinutes,
}: {
  t: Dictionary['kioskAdmin'];
  rows: KioskRowView[];
  pairingMinutes: number;
}) {
  const [made, register, registering] = useActionState<KioskAdminState, FormData>(
    registerKiosk,
    {},
  );
  const [here, pairHere, switching] = useActionState<KioskAdminState, FormData>(
    makeThisIpadTheKiosk,
    {},
  );
  const [again, repair, repairing] = useActionState<KioskAdminState, FormData>(repairKiosk, {});
  const [gone, revoke, revoking] = useActionState<KioskAdminState, FormData>(revokeKioskAction, {});
  const err = (s: KioskAdminState) =>
    s.error ? (
      <p className="text-polish">
        {t.errors[s.error] ?? s.error}
        <ErrorRef refId={s.ref} />
      </p>
    ) : null;
  const fields = (
    <>
      <label className="flex flex-col gap-1">
        <span className="font-medium">{t.deviceName}</span>
        <input
          name="name"
          maxLength={60}
          required
          className={field}
          placeholder={t.deviceNamePlaceholder}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium">{t.pin}</span>
        <input
          name="pin"
          type="password"
          inputMode="numeric"
          pattern="\d{4}"
          maxLength={4}
          required
          autoComplete="new-password"
          className={`${field} w-32`}
        />
        <span className="text-small text-slate/70">{t.pinHint}</span>
      </label>
    </>
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-8 md:grid-cols-2">
        <form action={register} className="flex flex-col gap-4 bg-board p-5">
          <h2 className="text-heading font-semibold">{t.registerTitle}</h2>
          <p className="text-slate/80">{t.registerLead}</p>
          {fields}
          {err(made)}
          <Button type="submit" disabled={registering}>
            {t.register}
          </Button>
          <CodeShown state={made} t={t} minutes={pairingMinutes} />
        </form>
        <form action={pairHere} className="flex flex-col gap-4 bg-board p-5">
          <h2 className="text-heading font-semibold">{t.useHereTitle}</h2>
          <p className="text-slate/80">{t.useHereLead}</p>
          {fields}
          {err(here)}
          <Button type="submit" tone="quiet" disabled={switching}>
            {t.useHere}
          </Button>
        </form>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-heading font-semibold">{t.listTitle}</h2>
        {err(again)}
        {err(gone)}
        <CodeShown state={again} t={t} minutes={pairingMinutes} />
        {rows.length === 0 ? <p className="text-slate/70">{t.none}</p> : null}
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className={`flex flex-wrap items-center gap-3 border-l-[12px] bg-board px-4 py-3 ${r.revoked ? 'border-pumice' : 'border-teal'}`}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold">{r.name}</span>
                <span className="text-small text-slate/70">{r.state}</span>
              </span>
              {r.revoked ? null : (
                <>
                  <form action={repair}>
                    <input type="hidden" name="deviceId" value={r.id} />
                    <Button type="submit" tone="quiet" disabled={repairing}>
                      {t.newCode}
                    </Button>
                  </form>
                  <form action={revoke}>
                    <input type="hidden" name="deviceId" value={r.id} />
                    <Button type="submit" tone="danger" disabled={revoking}>
                      {t.revoke}
                    </Button>
                  </form>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

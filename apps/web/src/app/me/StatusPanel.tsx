'use client';

import { ErrorRef } from '@/components/ErrorRef';
import { useActionState, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { moveStatus, type MeState } from './actions';

type State = 'off' | 'checked_in' | 'available' | 'in_service' | 'break' | 'out';

// What the technician may tap from each state. in_service is the engine's.
const MOVES: Record<State, { intent: string; tone: 'primary' | 'quiet' | 'danger' }[]> = {
  off: [{ intent: 'check_in', tone: 'primary' }],
  checked_in: [
    { intent: 'available', tone: 'primary' },
    { intent: 'off', tone: 'quiet' },
  ],
  available: [
    { intent: 'break', tone: 'quiet' },
    { intent: 'out', tone: 'quiet' },
    { intent: 'off', tone: 'quiet' },
  ],
  in_service: [{ intent: 'finish', tone: 'primary' }],
  break: [
    { intent: 'available', tone: 'primary' },
    { intent: 'off', tone: 'quiet' },
  ],
  out: [
    { intent: 'available', tone: 'primary' },
    { intent: 'off', tone: 'quiet' },
  ],
};

export function StatusPanel({
  status,
  called = false,
  t,
}: {
  status: State;
  /** An open call: the only moves are Accept and Deny (no auto-pass). */
  called?: boolean;
  t: Dictionary['me'];
}) {
  const [state, action, pending] = useActionState<MeState, FormData>(moveStatus, {});
  const [pos, setPos] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const asked = useRef(false);

  // Ask for the phone's position once, only when a check-in is possible. The
  // server decides whether it is inside the fence; a missing fix is sent as
  // nothing, and the server says so if it needed one.
  useEffect(() => {
    if (status !== 'off' || asked.current || typeof navigator === 'undefined') return;
    asked.current = true;
    navigator.geolocation?.getCurrentPosition(
      (p) =>
        setPos({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => setPos(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  }, [status]);

  const error =
    state.error === 'outside_geofence'
      ? fill(t.errors.outside_geofence, {
          distance: Math.round(state.distanceM ?? 0),
          radius: state.radiusM ?? 0,
        })
      : state.error === 'poor_location_accuracy'
        ? fill(t.errors.poor_location_accuracy, {
            accuracy: Math.round(state.accuracyM ?? 0),
            radius: state.radiusM ?? 0,
          })
        : state.error
          ? t.errors[state.error]
          : null;

  if (called) return <p className="text-slate/80">{t.errors.open_call}</p>;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="lat" value={pos?.lat ?? ''} />
      <input type="hidden" name="lng" value={pos?.lng ?? ''} />
      <input type="hidden" name="accuracy" value={pos?.accuracy ?? ''} />
      {error ? (
        <p role="alert" className="text-polish">
          {error}
          <ErrorRef refId={state.ref} />
        </p>
      ) : null}
      <div className="flex flex-col gap-3">
        {MOVES[status].map((m) => (
          <Button
            key={m.intent}
            type="submit"
            name="intent"
            value={m.intent}
            tone={m.tone}
            disabled={pending}
            className="min-h-14 text-kiosk-button"
          >
            {t.actions[m.intent as keyof Dictionary['me']['actions']]}
          </Button>
        ))}
      </div>
      {status === 'in_service' ? <p className="text-slate/80">{t.inServiceNote}</p> : null}
    </form>
  );
}

'use client';

// v0.17.0 (DESK-001): the desk acts for a technician whose phone is not to
// hand. Accept and Finish sit on her current visit (the desk row and her tech
// card); Deny is under the row's "More". Same rules as her phone: the server
// decides the points (@turn/db/act-for). Her phone lists what was done for her.
import { useActionState } from 'react';
import { ErrorRef } from '@/components/ErrorRef';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { actForTech, type DeskState } from './actions';

type T = Dictionary['actFor'];

function Problem({ state, t }: { state: DeskState; t: T }) {
  if (!state.error) return null;
  return (
    <span role="alert" className="text-small font-semibold text-polish">
      {t.errors[state.error] ?? t.errors.server}
      <ErrorRef refId={state.ref} />
    </span>
  );
}

/** "Accept for Linh": answers her open call; the service starts. */
export function AcceptFor({
  callId,
  name,
  label,
  t,
  align = 'end',
}: {
  callId: string;
  name: string;
  /** For screen readers: which client row this is. */
  label?: string;
  t: T;
  align?: 'start' | 'end';
}) {
  const [state, action, pending] = useActionState<DeskState, FormData>(actForTech, {});
  return (
    <form
      action={action}
      className={`flex flex-col gap-1 ${align === 'start' ? 'items-start' : 'items-end'}`}
    >
      <input type="hidden" name="intent" value="accept" />
      <input type="hidden" name="callId" value={callId} />
      <Button
        type="submit"
        disabled={pending}
        aria-label={label ? `${fill(t.accept, { name })}: ${label}` : undefined}
      >
        {fill(t.accept, { name })}
      </Button>
      <Problem state={state} t={t} />
    </form>
  );
}

/** "Finish for Hoa": ends the visit she is in service on; points post. */
export function FinishFor({
  technicianId,
  visitId,
  name,
  label,
  t,
  align = 'end',
}: {
  technicianId: string;
  visitId?: string | null;
  name: string;
  label?: string;
  t: T;
  align?: 'start' | 'end';
}) {
  const [state, action, pending] = useActionState<DeskState, FormData>(actForTech, {});
  return (
    <form
      action={action}
      className={`flex flex-col gap-1 ${align === 'start' ? 'items-start' : 'items-end'}`}
    >
      <input type="hidden" name="intent" value="finish" />
      <input type="hidden" name="technicianId" value={technicianId} />
      {visitId ? <input type="hidden" name="visitId" value={visitId} /> : null}
      <Button
        type="submit"
        disabled={pending}
        aria-label={label ? `${fill(t.finish, { name })}: ${label}` : undefined}
      >
        {fill(t.finish, { name })}
      </Button>
      <Problem state={state} t={t} />
    </form>
  );
}

/** "Deny for Linh" with a reason: the same points as on her phone. */
export function DenyFor({
  callId,
  name,
  reasons,
  freeReasons,
  freeLabel,
  label,
  t,
}: {
  callId: string;
  name: string;
  reasons: Record<string, string>;
  /** Reasons the rules excuse (no points). */
  freeReasons: readonly string[];
  /** "{reason} (no points)" */
  freeLabel: string;
  label?: string;
  t: T;
}) {
  const [state, action, pending] = useActionState<DeskState, FormData>(actForTech, {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="intent" value="deny" />
      <input type="hidden" name="callId" value={callId} />
      <label className="flex flex-col gap-1">
        <span className="font-medium">{fill(t.denyReason, { name })}</span>
        <select
          name="reason"
          required
          defaultValue=""
          className="min-h-11 rounded-control border-2 border-slate/30 bg-board px-3"
        >
          <option value="" disabled>
            {t.pickReason}
          </option>
          {Object.entries(reasons).map(([k, v]) => (
            <option key={k} value={k}>
              {freeReasons.includes(k) ? fill(freeLabel, { reason: v }) : v}
            </option>
          ))}
        </select>
      </label>
      <Button
        type="submit"
        tone="quiet"
        disabled={pending}
        aria-label={label ? `${fill(t.deny, { name })}: ${label}` : undefined}
      >
        {fill(t.deny, { name })}
      </Button>
      <Problem state={state} t={t} />
    </form>
  );
}

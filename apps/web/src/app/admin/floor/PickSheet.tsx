'use client';

// v0.18.0 (C1, B12): one "Pick someone" sheet instead of three screens (Ask a
// higher-level tech, Pick a tech for desk-pick services, the desk sending a
// named tech). Everyone able to do the visit, in its line, each with a label
// ("next by turn", "higher level, can say no", "busy", "held for 2:30 appt").
// The suggested one is marked and says why; anyone who cannot be picked is
// greyed with the reason. Each button sends the same engine function as
// before (callNext, deskCall, reassignVisit), with its own checks.
import { useActionState } from 'react';
import { ErrorRef } from '@/components/ErrorRef';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { deskCallFor } from '../actions';
import { manageAction, type ManageState } from '../manage/actions';
import type { PickOption } from './model';
import type { ClientRow } from './types';
import { ActButton, useWords } from './ui';

export function PickSheet({
  v,
  call,
  calling,
  onDone,
  levelNames,
}: {
  v: ClientRow;
  call: (fd: FormData) => void;
  calling: boolean;
  onDone: () => void;
  levelNames: Record<string, string>;
}) {
  const w = useWords();
  const f = w.floor;
  const options = v.pick ?? [];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-slate/80">{f.pickLead}</p>
      {options.length === 0 ? <p className="font-semibold text-polish">{f.noOne}</p> : null}
      <ol className="flex flex-col gap-2">
        {options.map((o) => (
          <li
            key={o.technicianId}
            className={`flex flex-wrap items-center gap-3 border-l-[10px] bg-board px-3 py-2 ${
              o.suggested ? 'border-teal' : o.action ? 'border-navy' : 'border-pumice'
            }`}
          >
            <span
              className={`flex min-w-0 flex-1 basis-56 flex-col ${o.action ? '' : 'opacity-60'}`}
            >
              <span className="text-lead font-semibold">
                <span className="pr-2 text-slate/60 tabular-nums">{o.place}</span>
                {o.name}
                {o.level ? (
                  <span className="pl-2 text-small font-medium text-slate/70">
                    {levelNames[o.level] ?? o.level}
                  </span>
                ) : null}
              </span>
              <span className="text-small font-medium">
                {o.suggested ? (
                  <span className="mr-2 rounded-full bg-teal px-2 py-0.5 font-semibold text-board">
                    {f.suggested}
                  </span>
                ) : null}
                {o.label}
              </span>
            </span>
            <Choice o={o} v={v} call={call} calling={calling} onDone={onDone} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function Choice({
  o,
  v,
  call,
  calling,
  onDone,
}: {
  o: PickOption;
  v: ClientRow;
  call: (fd: FormData) => void;
  calling: boolean;
  onDone: () => void;
}) {
  const w = useWords();
  const f = w.floor;
  if (o.action === 'call_next') {
    return (
      <form
        action={(fd) => {
          call(fd);
          onDone();
        }}
      >
        <input type="hidden" name="visitId" value={v.id} />
        <Button
          type="submit"
          disabled={calling}
          aria-label={`${fill(f.callButton, { name: o.name })}: ${v.who}`}
        >
          {fill(f.callButton, { name: o.name })}
        </Button>
      </form>
    );
  }
  if (o.action === 'offer' || o.action === 'desk_pick') {
    const label = fill(o.action === 'offer' ? f.askButton : f.pickButton, { name: o.name });
    return (
      <ActButton
        action={deskCallFor}
        fields={{ visitId: v.id, technicianId: o.technicianId, kind: o.action }}
        label={label}
        ariaLabel={`${label}: ${v.who}`}
        tone={o.suggested ? 'primary' : 'quiet'}
        onDone={onDone}
      />
    );
  }
  if (o.action === 'reassign') return <SendOutOfTurn o={o} v={v} onDone={onDone} />;
  return null;
}

/** Owners and managers: send her out of turn, with a reason (reassignVisit). */
function SendOutOfTurn({ o, v, onDone }: { o: PickOption; v: ClientRow; onDone: () => void }) {
  const w = useWords();
  const f = w.floor;
  const [state, action, pending] = useActionState<ManageState, FormData>(async (prev, fd) => {
    const next = await manageAction(prev, fd);
    if (next.done) onDone();
    return next;
  }, {});
  return (
    <details className="w-full sm:w-auto">
      <summary className="flex min-h-11 cursor-pointer items-center rounded-control border-2 border-slate px-4 font-semibold">
        {fill(f.sendButton, { name: o.name })}
      </summary>
      <form action={action} className="flex flex-col gap-2 pt-2">
        <input type="hidden" name="intent" value="reassign" />
        <input type="hidden" name="visitId" value={v.id} />
        <input type="hidden" name="technicianId" value={o.technicianId} />
        <span className="text-small text-slate/80">{f.sendLead}</span>
        <label className="flex flex-col gap-1">
          <span className="text-small font-medium">{f.reason}</span>
          <input
            name="reason"
            required
            maxLength={300}
            className="min-h-11 rounded-control border-2 border-slate/30 bg-board px-3"
          />
        </label>
        <Button type="submit" tone="quiet" disabled={pending}>
          {fill(f.sendButton, { name: o.name })}
        </Button>
        {state.error ? (
          <span role="alert" className="text-small font-semibold text-polish">
            {w.manage.errors[state.error] ?? state.error}
            <ErrorRef refId={state.ref} />
          </span>
        ) : null}
      </form>
    </details>
  );
}

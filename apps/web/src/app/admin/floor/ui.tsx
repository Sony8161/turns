'use client';

// v0.18.0: small pieces the board shares: the words (one context, sent once),
// a button that sends one existing action, the drawer and sheets (a native
// <dialog>: it keeps focus inside and closes with Escape), and the status
// chip (an icon and the words; colour is never the only signal).
import {
  createContext,
  useActionState,
  useContext,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from 'react';
import { ErrorRef } from '@/components/ErrorRef';
import { Button } from '@/components/ui';
import type { Dictionary } from '@/i18n/dictionary';
import type { DeskState } from '../actions';
import type { FloorStatus } from './model';

export type FloorDict = {
  floor: Dictionary['floor'];
  desk: Dictionary['desk'];
  actFor: Dictionary['actFor'];
  manage: Dictionary['manage'];
  /** Deny reasons in words. */
  reasons: Record<string, string>;
  freeLabel: string;
};

const Words = createContext<FloorDict | null>(null);

export function FloorWords({ value, children }: { value: FloorDict; children: ReactNode }) {
  return <Words.Provider value={value}>{children}</Words.Provider>;
}

export function useWords(): FloorDict {
  const w = useContext(Words);
  if (!w) throw new Error('FloorWords missing');
  return w;
}

/** An error from any desk action, in words. */
export function Problem({ state }: { state: { error?: string; ref?: string } }) {
  const w = useWords();
  if (!state.error) return null;
  return (
    <span role="alert" className="text-small font-semibold text-polish">
      {w.floor.errors[state.error] ??
        w.desk.errors[state.error] ??
        w.actFor.errors[state.error] ??
        w.desk.errors.server ??
        state.error}
      <ErrorRef refId={state.ref} />
    </span>
  );
}

type Action = (prev: DeskState, formData: FormData) => Promise<DeskState>;

/** One button that sends one existing action with its hidden fields. */
export function ActButton({
  action,
  fields,
  label,
  ariaLabel,
  tone = 'primary',
  className = '',
  onDone,
}: {
  action: Action;
  fields: Record<string, string>;
  label: string;
  ariaLabel?: string;
  tone?: 'primary' | 'quiet' | 'danger';
  className?: string;
  onDone?: (state: DeskState) => void;
}) {
  const [state, submit, pending] = useActionState<DeskState, FormData>(async (prev, fd) => {
    const next = await action(prev, fd);
    if (!next.error) onDone?.(next);
    return next;
  }, {});
  return (
    <form action={submit} className="flex flex-col gap-1">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Button
        type="submit"
        tone={tone}
        disabled={pending}
        aria-label={ariaLabel}
        className={`min-h-11 ${className}`}
      >
        {label}
      </Button>
      <Problem state={state} />
    </form>
  );
}

/**
 * The drawer (side 'right') and the sheets (side 'center'): a modal
 * <dialog>. showModal() makes the page behind inert, so focus stays inside;
 * Escape closes it; a tap on the dim backdrop closes it too.
 */
export function Sheet({
  open,
  onClose,
  title,
  side = 'center',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  side?: 'right' | 'center';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const w = useWords();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const shape =
    side === 'right'
      ? 'ml-auto mr-0 my-0 h-dvh max-h-dvh w-[min(30rem,100vw)]'
      : 'm-auto max-h-[92dvh] w-[min(60rem,calc(100vw-1rem))]';
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={`${shape} overflow-hidden bg-pumice p-0 text-slate backdrop:bg-slate/50`}
    >
      {open ? (
        <div className="flex max-h-[inherit] flex-col">
          <div className="flex items-center justify-between gap-3 border-b-2 border-slate/10 bg-board px-4 py-2">
            <h2 id={id} className="text-lead font-semibold">
              {title}
            </h2>
            <Button type="button" tone="quiet" onClick={onClose}>
              {w.floor.close}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}

const BAR: Record<FloorStatus, string> = {
  available: 'bg-teal',
  held: 'bg-amber',
  called: 'bg-polish',
  in_service: 'bg-slate',
  break: 'bg-amber',
  out: 'bg-amber',
  checked_in: 'bg-pumice',
};

export function statusBar(s: FloorStatus): string {
  return BAR[s];
}

/** Simple line icons, one per status, beside the words. */
function Icon({ s }: { s: FloorStatus }) {
  const p = {
    available: 'M5 12.5l4.5 4.5L19 7.5',
    held: 'M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z',
    called: 'M6 16V11a6 6 0 1112 0v5l2 2H4l2-2zM10 20a2 2 0 004 0',
    in_service: 'M8 4v7a4 4 0 008 0V4M12 15v5M8 20h8',
    break: 'M5 9h11v5a5 5 0 01-5 5h-1a5 5 0 01-5-5V9zM16 10h2a2 2 0 010 4h-2M8 3v3M12 3v3',
    out: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
    checked_in: 'M12 3a9 9 0 100 18 9 9 0 000-18z',
  }[s];
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={p} />
    </svg>
  );
}

const CHIP: Record<FloorStatus, string> = {
  available: 'border-teal text-slate',
  held: 'border-amber text-slate',
  called: 'border-polish text-polish',
  in_service: 'border-slate text-slate',
  break: 'border-amber text-slate',
  out: 'border-amber text-slate',
  checked_in: 'border-slate/30 text-slate',
};

export function StatusChip({ s }: { s: FloorStatus }) {
  const w = useWords();
  return (
    <span
      className={`inline-flex min-h-7 items-center gap-1 rounded-full border-2 px-2 text-small font-semibold ${CHIP[s]}`}
    >
      <Icon s={s} />
      {w.floor.status[s]}
    </span>
  );
}

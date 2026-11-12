'use client';
// Connect Fresha (v0.11.0): paste a link, test it, then save it. Nothing is
// saved by a test. Save stays off until the link in the box is the one that
// was tested. A suggested technician is only a hint: the owner presses the
// button for the row they mean. The saved link never comes back to this
// screen; rows show the sync state only (T14).
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorRef } from '@/components/ErrorRef';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { stateLine, type FreshaRowItem } from './fresha-state';
import {
  removeCalendarLink,
  saveCalendarLink,
  testCalendarLink,
  type CalendarMode,
  type CalendarTestState,
} from '@/lib/fresha-actions';

type T = Dictionary['fresha'];

export function FreshaConnect({
  t,
  mode,
  rows,
}: {
  t: T;
  mode: CalendarMode;
  rows: FreshaRowItem[];
}) {
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return (
    <ol className="flex flex-col gap-3">
      {rows.map((r) => (
        <FreshaRow key={r.id} t={t} mode={mode} row={r} names={names} />
      ))}
    </ol>
  );
}

function FreshaRow({
  t,
  mode,
  row,
  names,
}: {
  t: T;
  mode: CalendarMode;
  row: FreshaRowItem;
  names: Map<string, string>;
}) {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [tested, setTested] = useState<{ url: string; result: CalendarTestState } | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean; ref?: string } | null>(
    null,
  );
  const [pending, start] = useTransition();
  const technicianId = mode === 'owner' ? row.id : undefined;
  const result = tested && tested.url === url ? tested.result : null;
  const field = 'min-h-11 w-full rounded-control border-2 border-slate/30 bg-board px-3';
  const errorText = (code: string) => t.errors[code] ?? t.errors.server!;

  function test() {
    setMessage(null);
    start(async () => {
      const r = await testCalendarLink({ mode, technicianId, url });
      setTested({ url, result: r });
    });
  }

  function save(target: string | undefined) {
    setMessage(null);
    start(async () => {
      const r = await saveCalendarLink({ mode, technicianId: target, url });
      if (!r.ok) {
        setMessage({ text: errorText(r.error), error: true, ref: r.ref });
        return;
      }
      setUrl('');
      setTested(null);
      setMessage({
        text: !r.synced
          ? t.savedLater
          : r.upcoming > 0
            ? fill(t.saved, { count: r.upcoming })
            : t.savedNone,
        error: false,
      });
      router.refresh();
    });
  }

  function disconnect() {
    setMessage(null);
    start(async () => {
      const r = await removeCalendarLink({ mode, technicianId });
      setMessage(
        r.ok
          ? { text: t.removed, error: false }
          : { text: errorText(r.error), error: true, ref: r.ref },
      );
      router.refresh();
    });
  }

  const suggested =
    mode === 'owner' && result?.ok && result.suggestedTechnicianId
      ? result.suggestedTechnicianId
      : null;
  const otherSuggested = suggested && suggested !== row.id ? suggested : null;
  const inputId = `fresha-${row.id}`;

  return (
    <li className="flex flex-col gap-3 bg-board px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        {mode === 'owner' ? <span className="font-semibold">{row.name}</span> : null}
        <span
          className={
            row.state.kind === 'failing'
              ? 'text-small font-semibold text-polish'
              : row.state.kind === 'stale'
                ? 'text-small font-semibold text-slate'
                : 'text-small text-slate/80'
          }
        >
          {stateLine(t, row.state)}
        </span>
      </div>
      <label htmlFor={inputId} className="text-small font-medium">
        {t.linkLabel}
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <input
          id={inputId}
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          maxLength={2048}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://calendar-export.fresha.com/…"
          className={`${field} max-w-md flex-1`}
        />
        <Button type="button" tone="quiet" disabled={pending || !url.trim()} onClick={test}>
          {pending && !result ? t.testing : t.test}
        </Button>
        {row.state.kind !== 'none' ? (
          <Button type="button" tone="quiet" disabled={pending} onClick={disconnect}>
            {t.disconnect}
          </Button>
        ) : null}
      </div>

      {tested && tested.url !== url && url ? (
        <p className="text-small text-slate/80">{t.retest}</p>
      ) : null}

      {result ? (
        result.ok ? (
          <div className="flex flex-col gap-2" aria-live="polite">
            <p className="font-semibold text-navy">
              {result.upcoming === 0
                ? t.foundNone
                : result.upcoming === 1
                  ? t.foundOne
                  : fill(t.found, { count: result.upcoming })}
            </p>
            {result.calendarName ? (
              <p className="text-small text-slate/80">
                {fill(t.calendarIs, { name: result.calendarName })}
              </p>
            ) : null}
            {otherSuggested ? (
              <p className="text-small font-semibold text-polish">
                {fill(t.looksLike, {
                  name: names.get(otherSuggested) ?? '',
                  row: row.name,
                })}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button type="button" disabled={pending} onClick={() => save(technicianId)}>
                {pending
                  ? t.saving
                  : mode === 'owner'
                    ? fill(t.saveFor, { name: row.name })
                    : t.save}
              </Button>
              {otherSuggested ? (
                <Button
                  type="button"
                  tone="quiet"
                  disabled={pending}
                  onClick={() => save(otherSuggested)}
                >
                  {fill(t.saveFor, { name: names.get(otherSuggested) ?? '' })}
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <p role="alert" className="text-polish">
            {errorText(result.error)}
            <ErrorRef refId={result.ref} />
          </p>
        )
      ) : null}

      {message ? (
        <p
          role={message.error ? 'alert' : 'status'}
          className={message.error ? 'text-polish' : 'font-semibold text-navy'}
        >
          {message.text}
          {message.error ? <ErrorRef refId={message.ref} /> : null}
        </p>
      ) : null}
    </li>
  );
}

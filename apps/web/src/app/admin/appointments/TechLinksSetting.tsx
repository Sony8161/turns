'use client';

// v0.17.1 (review #6): owner only, under Connect Fresha. What happens when a
// technician adds her own Fresha calendar (Heavenly: the owner or a manager
// approves it first).
import { useActionState } from 'react';
import { ErrorRef } from '@/components/ErrorRef';
import { Button } from '@/components/ui';
import type { Dictionary } from '@/i18n/dictionary';
import { techLinksAction, type TechLinksState } from './feed-actions';

const CHOICES = ['owner_approves', 'name_must_match', 'open'] as const;

export function TechLinksSetting({ t, value }: { t: Dictionary['fresha']; value: string }) {
  const [state, action, pending] = useActionState<TechLinksState, FormData>(techLinksAction, {});
  // React resets the form after the action; keying the select on the saved
  // value remounts it showing that value (as the rules form does).
  const shown = state.value ?? value;
  return (
    <form action={action} className="flex flex-wrap items-end gap-3 bg-board p-4">
      <label className="flex w-full max-w-md flex-col gap-1">
        <span className="font-medium">{t.techLinksLabel}</span>
        <select
          key={shown}
          name="value"
          defaultValue={shown}
          className="min-h-12 w-full rounded-control border-2 border-slate/30 bg-board px-3 text-lead"
        >
          {CHOICES.map((c) => (
            <option key={c} value={c}>
              {t.techLinks[c]}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" tone="quiet" disabled={pending}>
        {t.techLinksSave}
      </Button>
      {state.saved ? (
        <span role="status" className="font-semibold text-teal">
          {t.techLinksSaved}
        </span>
      ) : null}
      {state.error ? (
        <span role="alert" className="font-semibold text-polish">
          {t.errors[state.error] ?? t.errors.server}
          <ErrorRef refId={state.ref} />
        </span>
      ) : null}
    </form>
  );
}

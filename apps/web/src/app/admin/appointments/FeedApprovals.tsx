'use client';

// v0.17.1 (review #6): a technician's own Fresha link waits here until the
// owner or a manager approves it. Names only: the link never reaches this
// page. Approve is the main step; Decline removes the link (she can add it
// again), so neither needs a confirm.
import { useActionState } from 'react';
import { ErrorRef } from '@/components/ErrorRef';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { reviewFeedAction, type FeedReviewState } from './feed-actions';

export function FeedApprovals({
  t,
  rows,
}: {
  t: Dictionary['fresha'];
  rows: { technicianId: string; name: string; since: string }[];
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="feed-approvals-title">
      <h2 id="feed-approvals-title" className="text-heading font-semibold">
        {t.pendingTitle}
      </h2>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <FeedApprovalRow key={r.technicianId} t={t} row={r} />
        ))}
      </ul>
    </section>
  );
}

function FeedApprovalRow({
  t,
  row,
}: {
  t: Dictionary['fresha'];
  row: { technicianId: string; name: string; since: string };
}) {
  const [state, action, pending] = useActionState<FeedReviewState, FormData>(reviewFeedAction, {});
  return (
    <li className="flex flex-col gap-2 border-l-[12px] border-navy bg-board px-4 py-3">
      <form action={action} className="flex flex-wrap items-center justify-between gap-3">
        <input type="hidden" name="technicianId" value={row.technicianId} />
        <span className="font-medium">
          {fill(t.pendingLine, { name: row.name, since: row.since })}
        </span>
        <span className="flex flex-wrap gap-2">
          <Button type="submit" name="decision" value="approve" disabled={pending}>
            {t.approve}
          </Button>
          <Button type="submit" name="decision" value="decline" tone="quiet" disabled={pending}>
            {t.decline}
          </Button>
        </span>
      </form>
      {state.done ? (
        <p role="status" className="font-semibold text-teal">
          {state.done === 'approved' ? t.approved : t.declined}
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="font-semibold text-polish">
          {t.errors[state.error] ?? t.errors.server}
          <ErrorRef refId={state.ref} />
        </p>
      ) : null}
    </li>
  );
}

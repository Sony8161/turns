'use client';

// v0.18.0 (B5, B6, C4): one tech's drawer. Her level and only what differs
// from it, her limits, her next appointment, "Why this order?", and what the
// viewer may do: accept or finish for her on her current visit, and under
// More: deny for her, change status (her page), adjust points, excuse a
// penalty, send a client to her (reassign). This replaces the tech cards and
// the Overrides page. The server checks every action again, exactly as before.
import { useActionState } from 'react';
import { ErrorRef } from '@/components/ErrorRef';
import { Button, LinkButton } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { AcceptFor, DenyFor, FinishFor } from '../ActForTech';
import { skipText } from '../chips';
import { manageAction, type ManageState } from '../manage/actions';
import type { TeamMember } from './types';
import { StatusChip, useWords } from './ui';

const DELTAS = ['-2', '-1.5', '-1', '-0.5', '0.5', '1', '1.5', '2'] as const;
const field = 'min-h-11 rounded-control border-2 border-slate/30 bg-board px-3';

export type DrawerRights = {
  /** Accept, deny and finish for her (owner, manager; receptionist: switch). */
  actFor: boolean;
  /** Her settings page: status today, points (receptionist: switch). */
  edit: boolean;
  /** The Overrides actions: excuse, adjust (owner, manager). */
  override: boolean;
  /** Reassign a visit to her (owner, manager). */
  reassign: boolean;
};

export function TechDrawer({
  m,
  rights,
  freeReasons,
  openVisits,
}: {
  m: TeamMember;
  rights: DrawerRights;
  freeReasons: readonly string[];
  /** Open visits that could be sent to her, by title. */
  openVisits: { id: string; title: string }[];
}) {
  const w = useWords();
  const f = w.floor;
  const [state, action, pending] = useActionState<ManageState, FormData>(manageAction, {});
  const message = state.error ? (
    <p role="alert" className="font-semibold text-polish">
      {fill(w.manage.errors[state.error] ?? state.error, {
        detail: state.skipped?.[0]
          ? skipText(state.skipped[0], w.desk.skip)
          : (w.desk.skip[state.detail ?? ''] ?? state.detail ?? ''),
      })}
      <ErrorRef refId={state.ref} />
    </p>
  ) : state.done ? (
    <p role="status" className="font-semibold text-teal">
      {w.manage.done[state.done]}
    </p>
  ) : null;
  const more =
    (rights.actFor && m.status === 'called' && m.openCallId) ||
    rights.edit ||
    rights.override ||
    rights.reassign;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusChip s={m.status} />
        <span className="text-slate/80">{m.time}</span>
        <span className="ml-auto text-lead font-semibold">
          {fill(f.place, { n: m.place })} · {m.pointsWords}
        </span>
      </div>
      {m.currentLine ? <p className="font-medium">{m.currentLine}</p> : null}

      {rights.actFor && m.status === 'called' && m.openCallId ? (
        <AcceptFor callId={m.openCallId} name={m.name} t={w.actFor} align="start" />
      ) : rights.actFor && m.status === 'in_service' && m.inServiceVisitId ? (
        <FinishFor
          technicianId={m.id}
          visitId={m.inServiceVisitId}
          name={m.name}
          t={w.actFor}
          align="start"
        />
      ) : null}

      <dl className="flex flex-col gap-2 bg-board p-4">
        <div>
          <dt className="sr-only">{f.level.replace('{level}', '')}</dt>
          <dd className="font-semibold">{m.levelLine}</dd>
          {m.diffLines.map((d) => (
            <dd key={d} className="text-slate/80">
              {d}
            </dd>
          ))}
        </div>
        <div>
          <dt className="font-medium">{f.limits}</dt>
          {m.limits.length ? (
            m.limits.map((l) => (
              <dd key={l} className="text-slate/80">
                {l}
              </dd>
            ))
          ) : (
            <dd className="text-slate/80">{f.noLimits}</dd>
          )}
        </div>
        <dd className="text-slate/80">{m.apptLine}</dd>
        {m.freeDenyBadge ? (
          <dd className="w-fit rounded-full border-2 border-polish px-3 text-small font-semibold">
            {m.freeDenyBadge}
          </dd>
        ) : null}
      </dl>

      <details className="bg-board p-4" open>
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
          {f.whyOrder}
        </summary>
        {m.lines.length === 0 ? (
          <p className="text-slate/80">{f.noPoints}</p>
        ) : (
          <table className="w-full text-left">
            <caption className="sr-only">{m.name}</caption>
            <tbody>
              {m.lines.map((l, k) => (
                <tr key={k} className="border-b border-pumice">
                  <td className="w-14 py-1 pr-2 font-semibold tabular-nums">{l.delta}</td>
                  <td className="py-1">{l.text}</td>
                  <td className="py-1 pl-2 text-right text-small text-slate/70">{l.at}</td>
                </tr>
              ))}
              <tr>
                <td className="py-1 pr-2 font-semibold">{m.points}</td>
                <td className="py-1 font-semibold" colSpan={2}>
                  {f.total}
                </td>
              </tr>
            </tbody>
          </table>
        )}
        {m.notes.map((n) => (
          <p key={n} className="pt-1 text-slate/80">
            {n}
          </p>
        ))}
      </details>

      {more ? (
        <details className="bg-board p-4">
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
            {fill(f.moreFor, { who: m.name })}
          </summary>
          <div className="flex flex-col gap-5 pt-2">
            {message}
            {rights.actFor && m.status === 'called' && m.openCallId ? (
              <DenyFor
                callId={m.openCallId}
                name={m.name}
                reasons={w.reasons}
                freeReasons={m.openCallKind === 'turn' ? freeReasons : []}
                freeLabel={w.freeLabel}
                t={w.actFor}
              />
            ) : null}
            {rights.edit ? (
              <LinkButton href={`/admin/staff/${m.id}`} tone="quiet">
                {f.changeStatus}
              </LinkButton>
            ) : null}
            {rights.override ? (
              <form action={action} className="flex flex-col gap-2">
                <span className="font-semibold">{f.adjust}</span>
                <input type="hidden" name="intent" value="adjust" />
                <input type="hidden" name="technicianId" value={m.id} />
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-small font-medium">{w.manage.delta}</span>
                    <select name="delta" defaultValue="0.5" className={field}>
                      {DELTAS.map((d) => (
                        <option key={d} value={d}>
                          {Number(d) > 0 ? `+${d}` : d}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-1 flex-col gap-1">
                    <span className="text-small font-medium">{w.manage.reason}</span>
                    <input name="reason" required maxLength={300} className={field} />
                  </label>
                  <Button type="submit" tone="quiet" disabled={pending}>
                    {w.manage.adjustButton}
                  </Button>
                </div>
              </form>
            ) : null}
            {rights.override ? (
              <div className="flex flex-col gap-2">
                <span className="font-semibold">{f.excuse}</span>
                {m.penalties.length === 0 ? (
                  <span className="text-slate/80">{f.noPenalties}</span>
                ) : (
                  m.penalties.map((p) => (
                    <form
                      key={p.ledgerId}
                      action={action}
                      className={`flex flex-wrap items-end gap-3 ${p.excused ? 'opacity-70' : ''}`}
                    >
                      <span className="min-w-40 flex-1">{p.text}</span>
                      {p.excused ? (
                        <span className="font-semibold text-teal">{w.manage.excused}</span>
                      ) : (
                        <>
                          <input type="hidden" name="intent" value="excuse" />
                          <input type="hidden" name="ledgerId" value={p.ledgerId} />
                          <label className="flex flex-col gap-1">
                            <span className="text-small font-medium">{w.manage.reason}</span>
                            <input name="reason" required maxLength={300} className={field} />
                          </label>
                          <Button type="submit" tone="quiet" disabled={pending}>
                            {w.manage.excuse}
                          </Button>
                        </>
                      )}
                    </form>
                  ))
                )}
              </div>
            ) : null}
            {rights.reassign ? (
              <form action={action} className="flex flex-col gap-2">
                <span className="font-semibold">{f.reassign}</span>
                <input type="hidden" name="intent" value="reassign" />
                <input type="hidden" name="technicianId" value={m.id} />
                {openVisits.length === 0 ? (
                  <span className="text-slate/80">{f.noOpenVisits}</span>
                ) : (
                  <>
                    <label className="flex flex-col gap-1">
                      <span className="text-small font-medium">{f.reassignClient}</span>
                      <select name="visitId" required defaultValue="" className={field}>
                        <option value="" disabled>
                          {f.reassignPick}
                        </option>
                        {openVisits.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-small font-medium">{w.manage.reason}</span>
                      <input name="reason" required maxLength={300} className={field} />
                    </label>
                    <label className="flex min-h-11 items-center gap-2">
                      <input type="checkbox" name="penalizeFirst" className="h-5 w-5" />
                      <span className="text-small">{w.manage.penalizeFirst}</span>
                    </label>
                    <label className="flex min-h-11 items-center gap-2">
                      <input type="checkbox" name="force" className="h-5 w-5" />
                      <span className="text-small">{w.manage.force}</span>
                    </label>
                    <Button type="submit" tone="quiet" disabled={pending}>
                      {w.manage.reassignButton}
                    </Button>
                  </>
                )}
              </form>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

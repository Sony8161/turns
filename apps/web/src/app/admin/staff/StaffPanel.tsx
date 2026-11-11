'use client';

import { ErrorRef } from '@/components/ErrorRef';
import Link from 'next/link';
import { useActionState } from 'react';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { staffAction, type StaffState } from './actions';

type Role = 'owner' | 'manager' | 'receptionist' | 'technician';
type Row = {
  membershipId: string;
  displayName: string;
  contact: string;
  role: Role;
  active: boolean;
  technicianStatus: string | null;
  isMe: boolean;
  technicianId: string | null;
  /** Skills and restrictions in one line, for technicians (Part 6). */
  profile: string | null;
};

const ROLES: Role[] = ['owner', 'manager', 'receptionist', 'technician'];

/** Owners set any role; managers never touch an owner (mirrors staff.ts canSetRole). */
function allowed(actor: Role, from: Role): Role[] {
  if (actor === 'owner') return ROLES;
  if (actor === 'manager' && from !== 'owner') return ROLES.filter((r) => r !== 'owner');
  return [];
}

export function StaffPanel({
  rows,
  actorRole,
  lang,
  t,
  roles,
  statuses,
  editProfile,
}: {
  rows: Row[];
  actorRole: Role;
  lang: string;
  t: Dictionary['staff'];
  roles: Dictionary['roles'];
  statuses: Dictionary['board']['status'];
  /** The link text for a technician's skills page, or null when this role cannot edit it. */
  editProfile: string | null;
}) {
  const [state, action, pending] = useActionState<StaffState, FormData>(staffAction, {});
  const inviteRoles = allowed(actorRole, 'technician');
  const expires = state.expiresAt
    ? new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(state.expiresAt))
    : '';
  const field = 'min-h-11 rounded-control border-2 border-slate/30 bg-board px-3';

  return (
    <div className="flex flex-col gap-8">
      <form action={action} className="flex flex-col gap-4 bg-board p-5">
        <h2 className="text-heading font-semibold">{t.invite}</h2>
        <input type="hidden" name="intent" value="invite" />
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t.inviteRole}</span>
          <select name="role" defaultValue="technician" className={`${field} w-60 text-lead`}>
            {inviteRoles.map((r) => (
              <option key={r} value={r}>
                {roles[r]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" disabled={pending} className="self-start">
          {t.makeCode}
        </Button>
        {state.code ? (
          <div className="flex flex-col gap-2 border-l-[12px] border-teal pl-4">
            <span className="text-name font-semibold tracking-wide">{state.code}</span>
            <span className="text-slate/80">{fill(t.codeMade, { date: expires })}</span>
          </div>
        ) : null}
      </form>

      {state.error ? (
        <p className="text-polish">
          {t.errors[state.error] ?? state.error}
          <ErrorRef refId={state.ref} />
        </p>
      ) : state.done ? (
        <p className="font-semibold text-teal">{t.done[state.done]}</p>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-heading font-semibold">{t.title}</h2>
        <ol className="flex flex-col gap-2">
          {rows.map((r) => {
            const targets = r.isMe ? [] : allowed(actorRole, r.role).filter((x) => x !== r.role);
            const status = r.technicianStatus as keyof typeof statuses | null;
            return (
              <li
                key={r.membershipId}
                className={`flex flex-col gap-3 bg-board px-4 py-3 ${r.active ? '' : 'opacity-70'}`}
              >
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-lead font-semibold">
                    {r.displayName}
                    {r.isMe ? ` (${t.you})` : ''}
                  </span>
                  <span className="text-slate/80">{roles[r.role]}</span>
                  <span className="text-small text-slate/70">{r.contact}</span>
                  <span className="text-small text-slate/70">
                    {!r.active ? t.archived : status ? statuses[status] : ''}
                  </span>
                </div>
                {r.profile ? (
                  <div className="flex flex-wrap items-center gap-3 text-small">
                    <span className="text-slate/80">{r.profile}</span>
                    {r.active && editProfile && r.technicianId ? (
                      <Link href={`/admin/staff/${r.technicianId}`} className="underline">
                        {editProfile}
                      </Link>
                    ) : null}
                  </div>
                ) : null}
                {r.active && targets.length > 0 ? (
                  <div className="flex flex-wrap items-end gap-3">
                    <form action={action} className="flex flex-wrap items-end gap-3">
                      <input type="hidden" name="intent" value="role" />
                      <input type="hidden" name="membershipId" value={r.membershipId} />
                      <label className="flex flex-col gap-1">
                        <span className="text-small font-medium">{t.changeRole}</span>
                        <select name="role" defaultValue="" required className={field}>
                          <option value="">{t.pickRole}</option>
                          {targets.map((x) => (
                            <option key={x} value={x}>
                              {roles[x]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-small font-medium">{t.reason}</span>
                        <input name="reason" maxLength={300} className={`${field} w-56`} />
                      </label>
                      <Button type="submit" tone="quiet" disabled={pending}>
                        {t.changeRole}
                      </Button>
                    </form>
                    <form action={action} className="flex flex-wrap items-end gap-3">
                      <input type="hidden" name="intent" value="archive" />
                      <input type="hidden" name="membershipId" value={r.membershipId} />
                      <label className="flex flex-col gap-1">
                        <span className="text-small font-medium">{t.reason}</span>
                        <input name="reason" required maxLength={300} className={`${field} w-56`} />
                      </label>
                      <Button type="submit" tone="danger" disabled={pending}>
                        {t.archive}
                      </Button>
                    </form>
                  </div>
                ) : null}
                {!r.active && !r.isMe && allowed(actorRole, r.role).length > 0 ? (
                  <form action={action}>
                    <input type="hidden" name="intent" value="restore" />
                    <input type="hidden" name="membershipId" value={r.membershipId} />
                    <Button type="submit" tone="quiet" disabled={pending}>
                      {t.restore}
                    </Button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

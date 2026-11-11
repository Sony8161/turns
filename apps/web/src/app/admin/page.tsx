import { and, eq, isNull } from 'drizzle-orm';
import { serviceCategories, services, turnCalls } from '@turn/db';
import { floorAttention, todayCounts, waitingVisits } from '@turn/db/engine';
import { locationStatus, sweepFloor } from '@turn/db/status';
import { redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { AutoRefresh } from '@/components/AutoRefresh';
import { Board, secondsSince, type BoardRow } from '@/components/Board';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { can } from '@/lib/permissions';
import { signOut } from '../login/actions';
import { Desk } from './Desk';

// Admin home: the live board in queue order, what needs attention, the front
// desk (walk-ins and calls), and today's counts as a sentence.
export default async function AdminPage() {
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  // Technicians see their own position on /me, never the whole board (roles table).
  const membership = membershipWith(actor, 'view_board');
  if (!membership && actor.memberships.some((m) => m.role === 'technician')) redirect('/me');

  // Part 6: out-over penalties and shifts left open from an earlier day are
  // settled before the board is read. Idempotent.
  if (membership) await sweepFloor(db(), membership.locationId);
  const [rows, menu, waiting, counts, attention] = membership
    ? await Promise.all([
        boardRows(membership.locationId),
        db()
          .select({ id: services.id, name: services.name, category: serviceCategories.name })
          .from(services)
          .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
          .where(and(eq(services.locationId, membership.locationId), isNull(services.archivedAt)))
          .orderBy(serviceCategories.name, services.name),
        waitingVisits(db(), membership.locationId),
        todayCounts(db(), membership.locationId),
        floorAttention(db(), membership.locationId),
      ])
    : [[], [], [], { visits: 0, denies: 0, overrides: 0 }, null];

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      <AutoRefresh seconds={5} />
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-lead font-semibold">{t.app.name}</span>
          <span className="text-small text-slate/70">
            {fill(t.admin.welcome, { name: actor.displayName })}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <LanguageToggle lang={lang} t={t} />
          <form action={signOut}>
            <Button type="submit" tone="quiet">
              {t.nav.signOut}
            </Button>
          </form>
        </div>
      </header>

      {membership ? (
        <>
          <AdminNav
            t={t.nav}
            current="board"
            canStaff={can(membership.role, 'invite_staff')}
            canRules={can(membership.role, 'manage_rules')}
            canManage={can(membership.role, 'override_queue')}
          />
          <section className="flex flex-col gap-4">
            <h1 className="text-heading font-semibold">
              {fill(t.admin.locationRole, {
                location: membership.locationName,
                role: t.roles[membership.role],
              })}
            </h1>
            <Board rows={rows} t={t} compact />
            <p className="text-slate/80">{fill(t.admin.today, counts)}</p>
          </section>
          {can(membership.role, 'enter_walkins') && attention ? (
            <Desk
              services={menu}
              waiting={waiting.map((v) => ({
                id: v.id,
                status: v.status,
                services: v.services,
                waitSeconds: secondsSince(v.arrivedAt),
                calledTechnician: v.calledTechnician,
                calledSeconds: v.calledAt ? secondsSince(v.calledAt) : null,
                assignedTechnician: v.assignedTechnician,
                requestedTechnician: v.requestedTechnician,
                note: v.note,
                clientName: v.clientName,
                clientGender: v.clientGender,
                clientIsKid: v.clientIsKid,
                clientAge: v.clientAge,
                groupId: v.groupId,
              }))}
              technicians={rows.map((r) => ({ id: r.id, name: r.name }))}
              attention={{
                unansweredCalls: attention.unansweredCalls.map((c) => ({
                  callId: c.callId,
                  technicianName: c.technicianName,
                  waitedMin: c.waitedMin,
                })),
                unansweredCallMin: attention.unansweredCallMin,
                estimatedWaitMin: attention.estimatedWaitMin,
                longWait: attention.longWait,
                longWaitMin: attention.longWaitMin,
                noticeEnabled: attention.noticeEnabled,
                timers: attention.timers.map((x) => ({
                  technicianId: x.technicianId,
                  technicianName: x.technicianName,
                  status: x.status,
                  minutes: x.minutes,
                  over: x.over,
                })),
                outOverMin: attention.outOverMin,
              }}
              t={t.desk}
            />
          ) : null}
        </>
      ) : (
        <p className="max-w-[60ch] text-lead">{t.admin.noSalon}</p>
      )}
    </main>
  );
}

// Queue order (design doc): lowest points first, then earlier check-in. A
// technician with an open call shows as "called" with the time waited.
async function boardRows(locationId: string): Promise<BoardRow[]> {
  const [rows, open] = await Promise.all([
    locationStatus(db(), locationId),
    db()
      .select({ technicianId: turnCalls.technicianId, calledAt: turnCalls.calledAt })
      .from(turnCalls)
      .where(and(eq(turnCalls.locationId, locationId), isNull(turnCalls.respondedAt))),
  ]);
  const called = new Map(open.map((c) => [c.technicianId, c.calledAt]));
  return rows
    .filter((r) => r.status !== 'off')
    .sort(
      (a, b) =>
        a.points - b.points || (a.checkedInAt?.getTime() ?? 0) - (b.checkedInAt?.getTime() ?? 0),
    )
    .map((r) => {
      const calledAt = called.get(r.technicianId);
      return {
        id: r.technicianId,
        name: r.displayName,
        points: r.points,
        status: calledAt ? 'called' : (r.status as BoardRow['status']),
        seconds: secondsSince(calledAt ?? r.since),
      };
    });
}

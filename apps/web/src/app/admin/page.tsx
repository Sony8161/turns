import { and, eq, isNull } from 'drizzle-orm';
import { locations, serviceCategories, services, turnCalls } from '@turn/db';
import { appointmentsBetween } from '@turn/db/appointments';
import { compareQueue, floorAttention, todayCounts, waitingVisits } from '@turn/db/engine';
import { feedSummary, FEED_STALE_MIN } from '@turn/db/feeds';
import { ensureDailySummary, localDate, previousDate } from '@turn/db/reports';
import { activeRules } from '@turn/db/rules';
import { locationStatus, sweepFloor } from '@turn/db/status';
import Link from 'next/link';
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
import { currentKiosk } from '@/lib/kiosk';
import { signOut } from '../login/actions';
import { enterKioskMode } from './kiosk/actions';
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
  const now = new Date();
  const [rows, menu, waiting, counts, attention, calendar, upcoming, loc] = membership
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
        // Part 7: the calendar's state (T15) and the next appointments.
        feedSummary(db(), membership.locationId, now),
        appointmentsBetween(
          db(),
          membership.locationId,
          new Date(now.getTime() - 30 * 60_000),
          new Date(now.getTime() + 4 * 3_600_000),
        ),
        db()
          .select({ timezone: locations.timezone })
          .from(locations)
          .where(eq(locations.id, membership.locationId))
          .then((r) => r[0]),
      ])
    : [[], [], [], { visits: 0, denies: 0, overrides: 0 }, null, null, [], undefined];
  const clock = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-US', {
    timeZone: loc?.timezone ?? 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });
  const nextAppointments = upcoming.filter((a) => !a.arrivedAt && !a.cancelledAt).slice(0, 4);
  const owner = !!membership && can(membership.role, 'manage_rules');
  // Part 9: this browser is also paired as this location's kiosk.
  const kiosk = membership ? await currentKiosk() : null;
  const kioskHere = !!kiosk && kiosk.locationId === membership?.locationId;
  // Part 8: the owner's end-of-day summary for yesterday (written once, then read).
  const yesterday =
    owner && membership ? previousDate(localDate(now, loc?.timezone ?? 'America/New_York')) : null;
  const lastDay =
    yesterday && membership
      ? await ensureDailySummary(db(), membership.locationId, yesterday, now)
      : null;

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
          {kioskHere ? (
            <form action={enterKioskMode}>
              <Button type="submit" tone="quiet">
                {t.nav.kioskMode}
              </Button>
            </form>
          ) : null}
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
            canLog={can(membership.role, 'view_audit')}
            canKiosk={can(membership.role, 'manage_kiosks')}
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
            {lastDay ? (
              <p className="text-slate/80">
                {fill(t.admin.yesterday, {
                  date: lastDay.date,
                  visits: lastDay.visits,
                  denies: lastDay.denies,
                  overrides: lastDay.overrides,
                })}{' '}
                <Link
                  href={`/admin/reports?date=${lastDay.date}`}
                  className="font-semibold underline"
                >
                  {t.admin.seeReport}
                </Link>
              </p>
            ) : null}
          </section>
          {calendar && (calendar.feeds > 0 || nextAppointments.length > 0) ? (
            <section
              aria-live="polite"
              className={`flex flex-col gap-1 border-l-[12px] bg-board p-4 ${
                calendar.failing.length || calendar.stale.length ? 'border-polish' : 'border-teal'
              }`}
            >
              {calendar.feeds > 0 ? (
                <p className="text-slate/80">
                  {calendar.lastSyncedAt
                    ? fill(t.appointments.lastSynced, { time: clock.format(calendar.lastSyncedAt) })
                    : t.appointments.neverSynced}
                </p>
              ) : null}
              {calendar.failing.map((f) => (
                <p key={f.technicianName} className="font-semibold text-polish">
                  {fill(t.appointments.failing, {
                    name: f.technicianName,
                    error: t.appointments.feedErrors[f.error] ?? f.error,
                  })}
                  {owner ? '' : ` ${t.appointments.tellOwner}`}
                </p>
              ))}
              {calendar.stale.length ? (
                <p className="font-semibold text-polish">
                  {fill(t.appointments.stale, {
                    minutes: FEED_STALE_MIN,
                    names: calendar.stale.join(', '),
                  })}
                </p>
              ) : null}
              {nextAppointments.length ? (
                <p className="text-slate/80">
                  <span className="font-medium">{t.appointments.upcomingOnBoard}: </span>
                  {nextAppointments
                    .map((a) =>
                      fill(t.appointments.upcomingLine, {
                        time: clock.format(a.startAt),
                        name: a.technicianName,
                      }),
                    )
                    .join(' · ')}
                </p>
              ) : null}
              <Link href="/admin/appointments" className="font-semibold text-navy underline">
                {t.appointments.open}
              </Link>
            </section>
          ) : null}
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
                fromKiosk: v.fromKiosk,
                kioskName: v.kioskName,
                needsConfirm: v.needsConfirm,
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

// Queue order (design doc, rules' queue.sort): lowest points first, 0 before 00, then earlier check-in. A
// technician with an open call shows as "called" with the time waited.
async function boardRows(locationId: string): Promise<BoardRow[]> {
  const [rows, open, rules] = await Promise.all([
    locationStatus(db(), locationId),
    db()
      .select({ technicianId: turnCalls.technicianId, calledAt: turnCalls.calledAt })
      .from(turnCalls)
      .where(and(eq(turnCalls.locationId, locationId), isNull(turnCalls.respondedAt))),
    activeRules(db(), locationId),
  ]);
  const called = new Map(open.map((c) => [c.technicianId, c.calledAt]));
  return (
    rows
      .filter((r) => r.status !== 'off')
      // The engine's own order, so 0 sits above 00 (Part 7).
      .sort((a, b) => compareQueue(rules, a, b))
      .map((r) => {
        const calledAt = called.get(r.technicianId);
        return {
          id: r.technicianId,
          name: r.displayName,
          points: r.points,
          hadAppointmentLast: r.hadAppointmentLast,
          status: calledAt ? 'called' : (r.status as BoardRow['status']),
          seconds: secondsSince(calledAt ?? r.since),
        };
      })
  );
}

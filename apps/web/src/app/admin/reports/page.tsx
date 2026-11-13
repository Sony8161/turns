import {
  dailyTurnReport,
  DESK_ACTIONS,
  ensureDailySummary,
  fairnessReport,
  lastDays,
  localDate,
  OVERRIDE_ACTIONS,
  overrideSummary,
  parseDate,
  previousDate,
  signed,
} from '@turn/db/reports';
import { appointmentsBetween } from '@turn/db/appointments';
import { todayCounts } from '@turn/db/engine';
import { feedSummary, FEED_STALE_MIN } from '@turn/db/feeds';
import Link from 'next/link';
import { locations } from '@turn/db';
import { fixesByOriginalTech } from '@turn/db/fixes';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { SectionTabs } from '@/components/SectionTabs';
import { Button, LinkButton } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { can } from '@/lib/permissions';

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Reports (Part 8): the daily turn report, the end-of-day summary for a closed
// day, and who changed what over the last 7 days (threat model T4). Owners and
// managers, at the session's location. Staff names and counts only.
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string | string[] }>;
}) {
  const [{ lang, t }, actor, params] = await Promise.all([
    getDictionary(),
    requireActor(),
    searchParams,
  ]);
  const onlyTechnician =
    actor.memberships.length > 0 && actor.memberships.every((m) => m.role === 'technician');
  if (onlyTechnician) redirect('/me');
  const m = membershipWith(actor, 'view_audit');

  if (!m) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
        <AdminNav current="reports" />
        <p className="max-w-[60ch] text-lead">{t.reports.notAllowed}</p>
      </main>
    );
  }

  const [loc] = await db()
    .select({ timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, m.locationId));
  const tz = loc?.timezone ?? 'UTC';
  const today = localDate(new Date(), tz);
  const asked = parseDate(Array.isArray(params.date) ? params.date[0] : params.date);
  const day = asked && asked <= today ? asked : today;
  const fairRange = lastDays(day, 7);
  const [report, week, summary, fixes, fairness] = await Promise.all([
    dailyTurnReport(db(), m.locationId, day),
    overrideSummary(db(), m.locationId, addDays(day, -6), day),
    day < today ? ensureDailySummary(db(), m.locationId, day) : Promise.resolve(null),
    // v0.16.0: fixes per technician who did the original work.
    fixesByOriginalTech(db(), m.locationId, day),
    // v0.17.0: the fairness table, the 7 days up to this one.
    fairnessReport(db(), m.locationId, fairRange.from, fairRange.to),
  ]);
  // v0.18.0 (B15): the board's old "today" lines live here now.
  const now = new Date();
  const [counts, calendar, upcoming, lastDay] = await Promise.all([
    todayCounts(db(), m.locationId),
    feedSummary(db(), m.locationId, now),
    appointmentsBetween(
      db(),
      m.locationId,
      new Date(now.getTime() - 30 * 60_000),
      new Date(now.getTime() + 4 * 3_600_000),
    ),
    can(m.role, 'manage_rules')
      ? ensureDailySummary(db(), m.locationId, previousDate(today), now)
      : Promise.resolve(null),
  ]);
  const nextAppointments = upcoming.filter((a) => !a.arrivedAt && !a.cancelledAt).slice(0, 4);
  const fr = t.reports.fairness;
  const skipWhy = fr.skipWhy as Record<string, string>;
  const clock = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  });
  const c = t.reports.cols;
  const roles = t.roles as Record<string, string>;
  const actions = t.log.actions as Record<string, string>;
  const cell = 'whitespace-nowrap px-2 py-2';
  const isOverride = (a: string) => (OVERRIDE_ACTIONS as readonly string[]).includes(a);
  const isDesk = (a: string) => (DESK_ACTIONS as readonly string[]).includes(a);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      <AdminNav current="reports" />
      <SectionTabs
        label={t.nav.reportsHistory}
        current="/admin/reports"
        items={[
          { href: '/admin/reports', label: t.nav.reports },
          { href: '/admin/log', label: t.nav.history },
        ]}
      />
      {/* v0.18.0 (B15): what used to sit on the board: today's counts,
          yesterday's line and the calendar box. */}
      <section
        aria-labelledby="today-h"
        className="flex flex-col gap-2 border-l-[12px] border-navy bg-board p-4"
      >
        <h2 id="today-h" className="text-lead font-semibold">
          {t.floor.todayTitle}
        </h2>
        <p>{fill(t.admin.today, counts)}</p>
        {lastDay ? (
          <p>
            {fill(t.admin.yesterday, {
              date: lastDay.date,
              visits: lastDay.visits,
              denies: lastDay.denies,
              overrides: lastDay.overrides,
            })}{' '}
            {closedCount(lastDay) > 0
              ? `${fill(t.admin.yesterdayClosed, { n: closedCount(lastDay) })} `
              : ''}
            <Link
              href={`/admin/reports?date=${lastDay.date}`}
              className="inline-flex min-h-11 items-center font-semibold underline"
            >
              {t.admin.seeReport}
            </Link>
          </p>
        ) : null}
        {calendar && (calendar.feeds > 0 || nextAppointments.length > 0) ? (
          <div className="flex flex-col gap-1 border-t-2 border-pumice pt-2">
            {calendar.feeds > 0 ? (
              <p className="text-slate/80">
                {calendar.lastSyncedAt
                  ? fill(t.appointments.lastSynced, { time: clock.format(calendar.lastSyncedAt) })
                  : t.appointments.neverSynced}
              </p>
            ) : null}
            {calendar.failing.map((x) => (
              <p key={x.technicianName} className="font-semibold text-polish">
                {fill(t.appointments.failing, {
                  name: x.technicianName,
                  error: t.appointments.feedErrors[x.error] ?? x.error,
                })}
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
            <LinkButton href="/admin/appointments" tone="quiet">
              {t.appointments.open}
            </LinkButton>
          </div>
        ) : null}
      </section>
      <section className="flex flex-col gap-2">
        <h1 className="text-heading font-semibold">
          {t.reports.title}: {m.locationName}
        </h1>
        <p className="max-w-[70ch] text-slate/80">{t.reports.lead}</p>
      </section>
      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t.reports.date}</span>
          <input
            type="date"
            name="date"
            defaultValue={day}
            max={today}
            className="min-h-11 rounded-control border-2 border-slate/30 bg-board px-3"
          />
        </label>
        <Button type="submit">{t.reports.show}</Button>
      </form>

      <section className="flex flex-col gap-3">
        <h2 className="text-lead font-semibold">
          {t.reports.daily}, {day}
        </h2>
        {report ? <p>{fill(t.reports.totals, { ...report.totals, closedAtDayEnd: '' })}</p> : null}
        {report ? (
          <p>
            {fill(t.reports.leftLine, {
              walkedOut: report.totals.walkedOut,
              clientLeft: report.totals.clientLeft,
              noShows: report.totals.noShows,
            })}
          </p>
        ) : null}
        {report && report.totals.feedFailures > 0 ? (
          <p className="text-polish">
            {fill(t.reports.feedFailures, { count: report.totals.feedFailures })}
          </p>
        ) : null}
        {!report || report.technicians.length === 0 ? (
          <p>{t.reports.noShifts}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-small">
              <thead>
                <tr className="border-b-2 border-slate/30">
                  {[
                    c.technician,
                    c.checkIn,
                    c.checkOut,
                    c.late,
                    c.calls,
                    c.accepted,
                    c.denied,
                    c.response,
                    c.visits,
                    c.appointments,
                    c.visit,
                    c.deny,
                    c.lateP,
                    c.outOver,
                    c.manual,
                    c.points,
                  ].map((h) => (
                    <th key={h} scope="col" className="px-2 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.technicians.map((r) => (
                  <tr key={r.technicianId} className="border-b border-slate/15">
                    <td className={`${cell} font-semibold`}>{r.name}</td>
                    <td className={cell}>{r.checkedInAt ? clock.format(r.checkedInAt) : ''}</td>
                    <td className={cell}>{r.checkedOutAt ? clock.format(r.checkedOutAt) : ''}</td>
                    <td className={cell}>{r.lateMinutes}</td>
                    <td className={cell}>{r.calls}</td>
                    <td className={cell}>{r.accepted}</td>
                    <td className={cell}>{r.denied}</td>
                    <td className={cell}>{r.avgResponseSeconds ?? ''}</td>
                    <td className={cell}>{r.visitsCompleted}</td>
                    <td className={cell}>{r.appointments}</td>
                    <td className={cell}>{signed(r.byReason.visit)}</td>
                    <td className={cell}>{signed(r.byReason.deny)}</td>
                    <td className={cell}>{signed(r.byReason.late)}</td>
                    <td className={cell}>{signed(r.byReason.out_over)}</td>
                    <td className={cell}>{signed(r.byReason.manual)}</td>
                    <td className={`${cell} font-semibold`}>{r.points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lead font-semibold">{t.reports.endOfDay}</h2>
        {summary ? (
          <>
            <p>
              {fill(t.reports.endOfDayLine, {
                visits: summary.visits,
                denies: summary.denies,
                overrides: summary.overrides,
              })}
            </p>
            {summary.closedAtDayEnd ? (
              <p>{fill(t.reports.closedLine, summary.closedAtDayEnd)}</p>
            ) : null}
            {summary.closedAtDayEnd?.checkouts ? (
              <p>{fill(t.reports.checkoutsLine, { n: summary.closedAtDayEnd.checkouts })}</p>
            ) : null}
            {summary.walkedOut !== undefined ? (
              <p>
                {fill(t.reports.leftLine, {
                  walkedOut: summary.walkedOut,
                  clientLeft: summary.clientLeft ?? 0,
                  noShows: summary.noShows ?? 0,
                })}
              </p>
            ) : null}
            <p>
              {summary.overridesBy.length
                ? fill(t.reports.overridesBy, {
                    people: summary.overridesBy
                      .map((p) => `${p.name ?? t.log.system} (${p.total})`)
                      .join(', '),
                  })
                : t.reports.noOverrides}
            </p>
          </>
        ) : (
          <p className="text-slate/80">{t.reports.endOfDayToday}</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lead font-semibold">{t.reports.fixes}</h2>
        <p className="max-w-[70ch] text-slate/80">{t.reports.fixesLead}</p>
        {fixes.length === 0 ? (
          <p>{t.reports.fixesEmpty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-small">
              <thead>
                <tr className="border-b-2 border-slate/30">
                  {[
                    t.reports.fixesCols.original,
                    t.reports.fixesCols.fixes,
                    t.reports.fixesCols.same,
                  ].map((h) => (
                    <th key={h} scope="col" className="px-2 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fixes.map((f) => (
                  <tr key={f.technicianId ?? 'none'} className="border-b border-slate/15">
                    <td className={`${cell} font-semibold`}>
                      {f.technician ?? t.reports.fixesNoOrigin}
                    </td>
                    <td className={cell}>{f.fixes}</td>
                    <td className={cell}>{f.technicianId ? f.doneBySameTech : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lead font-semibold">
          {fill(fr.title, { from: fairRange.from, to: fairRange.to })}
        </h2>
        <p className="max-w-[70ch] text-slate/80">{fr.lead}</p>
        {fairness.length === 0 ? (
          <p>{fr.empty}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-small">
                <thead>
                  <tr className="border-b-2 border-slate/30">
                    {[fr.cols.technician, fr.cols.visits, fr.cols.points, fr.cols.flags].map(
                      (h) => (
                        <th key={h} scope="col" className="px-2 py-2 font-semibold">
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {fairness.map((r) => {
                    const flags = [
                      r.deniesFree ? fill(fr.flagFree, { n: r.deniesFree }) : null,
                      r.clientLeftMarked
                        ? fill(fr.flagLeft, {
                            n: r.clientLeftMarked,
                            confirmed: r.clientLeftConfirmed,
                          })
                        : null,
                      r.fixesOnHerWork ? fill(fr.flagFixes, { n: r.fixesOnHerWork }) : null,
                    ].filter((x): x is string => !!x);
                    return (
                      <tr key={r.technicianId} className="border-b border-slate/15 align-top">
                        <td className={`${cell} font-semibold`}>{r.name}</td>
                        <td className={cell}>{r.visitsDone}</td>
                        <td className={cell}>{r.points}</td>
                        <td className="px-2 py-2">{flags.length ? flags.join(' · ') : '–'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <details>
              <summary className="min-h-11 cursor-pointer py-2 font-semibold underline">
                {fr.showDetails}
              </summary>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-small">
                  <thead>
                    <tr className="border-b-2 border-slate/30">
                      {[
                        fr.cols.technician,
                        fr.cols.visits,
                        fr.cols.points,
                        fr.cols.deniesPenalty,
                        fr.cols.deniesFree,
                        fr.cols.declined,
                        fr.cols.splits,
                        fr.cols.clientLeft,
                        fr.cols.fixes,
                        fr.cols.skipped,
                      ].map((h) => (
                        <th key={h} scope="col" className="px-2 py-2 font-semibold">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {fairness.map((r) => (
                      <tr key={r.technicianId} className="border-b border-slate/15 align-top">
                        <td className={`${cell} font-semibold`}>{r.name}</td>
                        <td className={cell}>{r.visitsDone}</td>
                        <td className={cell}>{r.points}</td>
                        <td className={cell}>{r.deniesPenalty}</td>
                        <td className={cell}>{r.deniesFree}</td>
                        <td className={cell}>{r.declined}</td>
                        <td className={cell}>{r.splits}</td>
                        <td className={cell}>
                          {r.clientLeftMarked} / {r.clientLeftConfirmed}
                        </td>
                        <td className={cell}>{r.fixesOnHerWork}</td>
                        <td className="px-2 py-2">
                          {Object.entries(r.skipped)
                            .sort((x, y) => y[1] - x[1])
                            .map(([why, n]) => `${skipWhy[why] ?? why.replace(/_/g, ' ')}: ${n}`)
                            .join('; ') || '–'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lead font-semibold">{t.reports.week}</h2>
        <p className="max-w-[70ch] text-slate/80">{t.reports.weekLead}</p>
        {week.length === 0 ? (
          <p>{t.reports.weekEmpty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-small">
              <thead>
                <tr className="border-b-2 border-slate/30">
                  {[
                    t.reports.weekCols.person,
                    t.reports.weekCols.role,
                    t.reports.weekCols.overrides,
                    t.reports.weekCols.desk,
                    t.reports.weekCols.detail,
                  ].map((h) => (
                    <th key={h} scope="col" className="px-2 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {week.map((p) => {
                  const entries = Object.entries(p.counts);
                  const sum = (pred: (a: string) => boolean) =>
                    entries.filter(([a]) => pred(a)).reduce((s, [, n]) => s + n, 0);
                  return (
                    <tr key={p.userId ?? 'system'} className="border-b border-slate/15 align-top">
                      <td className={`${cell} font-semibold`}>{p.name ?? t.log.system}</td>
                      <td className={cell}>{p.role ? (roles[p.role] ?? p.role) : ''}</td>
                      <td className={cell}>{sum(isOverride)}</td>
                      <td className={cell}>{sum(isDesk)}</td>
                      <td className="px-2 py-2">
                        {entries.map(([a, n]) => `${actions[a] ?? a}: ${n}`).join('; ')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

/** v0.17.0: how many things the day-end close-out closed for that day. */
function closedCount(s: {
  closedAtDayEnd?: {
    visits: number;
    autoFinished: number;
    calls: number;
    help: number;
    checkouts?: number;
  };
}): number {
  const c = s.closedAtDayEnd;
  return c ? c.visits + c.autoFinished + c.calls + c.help + (c.checkouts ?? 0) : 0;
}

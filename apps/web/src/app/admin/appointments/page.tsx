import { appointmentsBetween } from '@turn/db/appointments';
import { activeRules } from '@turn/db/rules';
import {
  feedStates,
  feedSummary,
  FEED_STALE_MIN,
  pendingFeeds,
  techCalendarLinksAt,
} from '@turn/db/feeds';
import { locations, serviceCategories, services, technicians } from '@turn/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { AutoRefresh } from '@/components/AutoRefresh';
import { FreshaConnect } from '@/components/FreshaConnect';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { ownerRows } from '@/lib/fresha-rows';
import { can } from '@/lib/permissions';
import { signOut } from '../../login/actions';
import { AppointmentsPanel } from './AppointmentsPanel';
import { FeedApprovals } from './FeedApprovals';
import { salonInput } from './form';
import { TechLinksSetting } from './TechLinksSetting';

const WEEK = 7 * 86_400_000;

// Appointments (Part 7): today and the next week, "Client arrived", entry by
// hand, the calendar sync state, and (owner) the calendar links. The links
// themselves never reach this page: only their hint (threat model T14).
export default async function AppointmentsPage() {
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  const onlyTechnician =
    actor.memberships.length > 0 && actor.memberships.every((m) => m.role === 'technician');
  if (onlyTechnician) redirect('/me');
  const m = membershipWith(actor, 'enter_walkins');
  const any = actor.memberships[0];

  const header = (
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
  );

  if (!m) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
        {header}
        <AdminNav
          t={t.nav}
          current="appointments"
          canStaff={!!any && can(any.role, 'invite_staff')}
          canRules={!!any && can(any.role, 'manage_rules')}
          canManage={!!any && can(any.role, 'override_queue')}
          canLog={!!any && can(any.role, 'view_audit')}
        />
        <p className="max-w-[60ch] text-lead">{t.appointments.notAllowed}</p>
      </main>
    );
  }

  const now = new Date();
  const from = new Date(now.getTime() - 12 * 3_600_000);
  const isOwner = can(m.role, 'manage_rules');
  // v0.17.1 (review #6): a technician's own link waits for one of these.
  const mayApprove = can(m.role, 'approve_calendar_links');
  const [loc, rows, menu, techs, summary, feeds, waiting, techLinks] = await Promise.all([
    db()
      .select({ timezone: locations.timezone })
      .from(locations)
      .where(eq(locations.id, m.locationId))
      .then((r) => r[0]),
    appointmentsBetween(db(), m.locationId, from, new Date(now.getTime() + WEEK)),
    db()
      .select({ id: services.id, name: services.name, category: serviceCategories.name })
      .from(services)
      .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
      .where(and(eq(services.locationId, m.locationId), isNull(services.archivedAt)))
      .orderBy(serviceCategories.name, services.name),
    db()
      .select({ id: technicians.id, name: technicians.displayName })
      .from(technicians)
      .where(and(eq(technicians.locationId, m.locationId), eq(technicians.active, true)))
      .orderBy(asc(technicians.displayName)),
    feedSummary(db(), m.locationId, now),
    isOwner ? feedStates(db(), m.locationId, now) : Promise.resolve([]),
    mayApprove ? pendingFeeds(db(), m.locationId) : Promise.resolve([]),
    isOwner ? techCalendarLinksAt(db(), m.locationId) : Promise.resolve('owner_approves'),
  ]);
  const timezone = loc?.timezone ?? 'America/New_York';
  // v0.17.0: No-show is offered once the start time plus these minutes has passed.
  const noShowAfterMin = (await activeRules(db(), m.locationId)).closing.no_show_after_min;
  const locale = lang === 'vi' ? 'vi-VN' : 'en-US';
  const when = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const clock = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  });
  const feedByTech = new Map(feeds.map((f) => [f.technicianId, f]));
  // v0.11.0: the Connect Fresha card, owner only, with each technician's state.
  const freshaRows = isOwner ? await ownerRows(m.locationId, t, lang, timezone) : [];

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      <AutoRefresh seconds={30} />
      {header}
      <AdminNav
        t={t.nav}
        current="appointments"
        canStaff={can(m.role, 'invite_staff')}
        canRules={isOwner}
        canManage={can(m.role, 'override_queue')}
        canLog={can(m.role, 'view_audit')}
      />
      <section className="flex flex-col gap-2">
        <h1 className="text-heading font-semibold">
          {fill(t.admin.locationRole, { location: m.locationName, role: t.roles[m.role] })}
        </h1>
        <p className="max-w-[70ch] text-slate/80">{t.appointments.lead}</p>
      </section>
      {waiting.length > 0 ? (
        <FeedApprovals
          t={t.fresha}
          rows={waiting.map((w) => ({
            technicianId: w.technicianId,
            name: w.technicianName,
            since: when.format(w.since),
          }))}
        />
      ) : null}
      {isOwner ? (
        <section className="flex flex-col gap-3" aria-labelledby="fresha-title">
          <h2 id="fresha-title" className="text-heading font-semibold">
            {t.fresha.title}
          </h2>
          <p className="max-w-[70ch] text-slate/80">{t.fresha.howTo}</p>
          {freshaRows.length > 0 ? (
            <FreshaConnect t={t.fresha} mode="owner" rows={freshaRows} />
          ) : (
            <p className="max-w-[70ch]">{t.fresha.noTechs}</p>
          )}
          <TechLinksSetting t={t.fresha} value={techLinks} />
        </section>
      ) : null}
      <AppointmentsPanel
        t={t.appointments}
        otherLinks={t.fresha.otherLinks}
        isOwner={isOwner}
        now={salonInput(now, timezone)}
        services={menu}
        technicians={techs.map((x) => {
          const f = feedByTech.get(x.id);
          return {
            id: x.id,
            name: x.name,
            feed: f
              ? f.lastSyncedAt
                ? fill(t.appointments.feedLine, {
                    hint: f.urlHint,
                    events: f.lastEventCount ?? 0,
                    time: when.format(f.lastSyncedAt),
                  })
                : fill(t.appointments.feedNever, { hint: f.urlHint })
              : null,
            feedError: f?.lastError
              ? (t.appointments.feedErrors[f.lastError] ?? f.lastError)
              : null,
          };
        })}
        sync={{
          feeds: summary.feeds,
          lastSynced: summary.lastSyncedAt ? when.format(summary.lastSyncedAt) : null,
          failing: summary.failing.map((x) => ({
            name: x.technicianName,
            error: t.appointments.feedErrors[x.error] ?? x.error,
          })),
          stale: summary.stale,
          staleMin: FEED_STALE_MIN,
        }}
        appointments={rows.map((a) => ({
          id: a.id,
          technicianId: a.technicianId,
          technicianName: a.technicianName,
          clientName: a.clientName,
          when: fill(t.me.upcomingLine, {
            start: when.format(a.startAt),
            end: clock.format(a.endAt),
          }),
          start: salonInput(a.startAt, timezone),
          minutes: Math.round((a.endAt.getTime() - a.startAt.getTime()) / 60_000),
          source: a.source,
          state: a.arrivedAt
            ? 'arrived'
            : a.cancelledAt
              ? 'cancelled'
              : a.noShowAt
                ? 'no_show'
                : 'open',
          canNoShow:
            !a.arrivedAt &&
            !a.cancelledAt &&
            !a.noShowAt &&
            now.getTime() >= a.startAt.getTime() + noShowAfterMin * 60_000,
        }))}
      />
    </main>
  );
}

import { locations } from '@turn/db';
import { upcomingFor } from '@turn/db/appointments';
import { openCallFor } from '@turn/db/engine';
import { eq } from 'drizzle-orm';
import { activeRules } from '@turn/db/rules';
import { locationStatus, sweepFloor } from '@turn/db/status';
import Link from 'next/link';
import { AutoRefresh } from '@/components/AutoRefresh';
import { formatPoints, secondsSince } from '@/components/Board';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { technicianForUser } from '@/lib/technician';
import { signOut } from '../login/actions';
import { CallPanel } from './CallPanel';
import { StatusPanel } from './StatusPanel';

// The technician's own screen: status, today's points, the call if there is
// one, and the moves allowed from here. The web version of the phone app.
export default async function MePage() {
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  const tech = await technicianForUser(actor.userId);
  // Part 6: the out-over penalty posts even if nobody looked at the board.
  if (tech) await sweepFloor(db(), tech.locationId);
  const [board, call, rules, upcoming, loc] = tech
    ? await Promise.all([
        locationStatus(db(), tech.locationId),
        openCallFor(db(), tech.id),
        activeRules(db(), tech.locationId),
        // Part 7: own appointments, times only (the phone never shows clients, T11).
        upcomingFor(db(), tech.id),
        db()
          .select({ timezone: locations.timezone })
          .from(locations)
          .where(eq(locations.id, tech.locationId))
          .then((r) => r[0]),
      ])
    : [[], null, null, [], undefined];
  const timeOf = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-US', {
    timeZone: loc?.timezone ?? 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  const me = tech ? board.find((r) => r.technicianId === tech.id) : undefined;
  const status = me?.status ?? 'off';
  const awayMinutes = me?.since ? Math.floor(secondsSince(me.since) / 60) : 0;
  const outOver = !!rules && status === 'out' && awayMinutes >= rules.penalties.out_over_minutes;
  const timerLine =
    rules && status === 'out'
      ? fill(outOver ? t.me.outOver : t.me.outTimer, {
          minutes: awayMinutes,
          limit: rules.penalties.out_over_minutes,
          points: formatPoints(rules.penalties.out_over_penalty),
        })
      : status === 'break'
        ? fill(t.me.breakTimer, { minutes: awayMinutes })
        : null;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-8 px-4 py-6">
      <AutoRefresh seconds={5} />
      <header className="flex items-center justify-between">
        <Link href="/" className="text-lead font-semibold">
          {t.app.name}
        </Link>
        <div className="flex items-center gap-3">
          <LanguageToggle lang={lang} t={t} />
          <form action={signOut}>
            <Button type="submit" tone="quiet">
              {t.nav.signOut}
            </Button>
          </form>
        </div>
      </header>

      {!tech || !rules ? (
        <p className="text-lead">{t.me.notTechnician}</p>
      ) : (
        <>
          <section className="flex flex-col gap-1">
            <h1 className="text-heading font-semibold">{actor.displayName}</h1>
            <p className="text-lead">{fill(t.me.statusLine, { status: t.board.status[status] })}</p>
            <p className="points text-slate">
              <span aria-hidden>{formatPoints(me?.points ?? 0, me?.hadAppointmentLast)}</span>
              <span className="sr-only">
                {formatPoints(me?.points ?? 0, me?.hadAppointmentLast)} {t.board.points}
              </span>
            </p>
            <p className="text-slate/70">{t.me.pointsToday}</p>
            {timerLine ? (
              <p className={outOver ? 'font-semibold text-polish' : 'text-slate/80'}>{timerLine}</p>
            ) : null}
          </section>
          {call ? (
            <CallPanel
              callId={call.callId}
              services={call.services}
              waitedSeconds={secondsSince(call.calledAt)}
              denyPenalty={rules.penalties.deny}
              t={t.me}
            />
          ) : null}
          <StatusPanel status={status} called={!!call} t={t.me} />
          {upcoming.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-lead font-semibold">{t.me.upcoming}</h2>
              <ul className="flex flex-col gap-1">
                {upcoming.map((a) => (
                  <li key={a.startAt.toISOString()} className="text-slate/80">
                    {fill(t.me.upcomingLine, {
                      start: timeOf.format(a.startAt),
                      end: timeOf.format(a.endAt),
                    })}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}

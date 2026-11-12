import type { TechCard } from '@turn/db/board';
import { aheadBecause } from '@turn/db/board';
import Link from 'next/link';
import { formatPoints } from '@/components/Board';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { lineText, signedPoints } from './tech-lines';

const BAR: Record<TechCard['status'], string> = {
  off: 'border-pumice',
  checked_in: 'border-pumice',
  available: 'border-teal',
  called: 'border-polish',
  in_service: 'border-slate',
  break: 'border-amber',
  out: 'border-amber',
};

const chip = 'inline-flex min-h-8 items-center rounded-full px-3 text-small font-medium';

/**
 * The tech board: one card per technician on shift, in the order the next call
 * goes (Duong, 2026-11-12). Each card says what they do and do not take, the
 * next appointment, who is in the chair, and every point behind their total.
 * Sized for an iPad: two cards a row in landscape, one in portrait.
 */
export function TechCards({
  cards,
  t,
  timezone,
  lang,
  canEdit,
  sort,
}: {
  cards: TechCard[];
  /** The rules' queue.sort: whether an appointment counts at zero only (v0.15.0). */
  sort?: readonly string[];
  t: Dictionary;
  timezone: string;
  lang: 'en' | 'vi';
  canEdit: boolean;
}) {
  if (cards.length === 0) return null;
  const tb = t.techBoard;
  const clock = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  });
  const everyScore = !!sort?.includes('had_appointment_last');
  const zeroOnly = !everyScore && (!sort || sort.includes('double_zero_last'));
  // "Next up": the first one the engine would call for a plain walk-in.
  const firstFree = cards.find((c) => c.status === 'available' && !c.heldForAppointment);
  return (
    <section aria-labelledby="tech-cards" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="tech-cards" className="text-heading font-semibold">
          {tb.title}
        </h2>
        <p className="text-slate/80">{tb.lead}</p>
      </div>
      <ol className="grid gap-3 md:grid-cols-2">
        {cards.map((c, i) => {
          const status = t.board.status[c.status];
          const ahead = cards[i + 1];
          return (
            <li
              key={c.technicianId}
              className={`flex flex-col gap-3 border-l-[10px] bg-board p-4 ${BAR[c.status]}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                  <span className="text-small font-semibold uppercase tracking-wide text-slate/70">
                    {fill(tb.turn, { n: c.turn })}
                    {firstFree?.technicianId === c.technicianId ? ` · ${tb.next}` : ''}
                  </span>
                  <span className="truncate text-heading font-semibold">{c.displayName}</span>
                  <span className="font-medium text-slate/80">
                    {c.currentServices.length &&
                    (c.status === 'in_service' || c.status === 'called')
                      ? fill(c.status === 'called' ? tb.called : tb.withClient, {
                          services: c.currentServices.join(' + '),
                        })
                      : status}
                  </span>
                </div>
                <span className="flex flex-col items-end">
                  <span className="text-[44px] font-semibold leading-none text-slate">
                    {formatPoints(c.points, c.hadAppointmentLast)}
                  </span>
                  <span className="text-small text-slate/70">{t.board.points}</span>
                </span>
              </div>

              <ul aria-label={tb.does} className="flex flex-wrap gap-2">
                {c.level ? (
                  <li className={`${chip} bg-navy text-board`}>
                    {fill(tb.level, { level: t.levels.name[c.level] ?? c.level })}
                  </li>
                ) : null}
                <li className={`${chip} bg-teal/15 text-slate`}>
                  {c.services !== null
                    ? fill(tb.onlyThese, { list: c.services.join(', ') })
                    : c.skills === null
                      ? tb.doesEverything
                      : fill(tb.onlyThese, {
                          list: c.skills.map((s) => tb.category[s] ?? s).join(', '),
                        })}
                </li>
                {c.tags.map((tag) => (
                  <li key={tag} className={`${chip} bg-pumice text-slate`}>
                    {tag}
                  </li>
                ))}
              </ul>
              <ul aria-label={tb.restrictions} className="flex flex-wrap gap-2">
                {c.restrictions.length === 0 ? (
                  <li className={`${chip} border border-slate/30 text-slate/80`}>
                    {tb.noRestrictions}
                  </li>
                ) : (
                  c.restrictions.map((r) => (
                    <li key={r.type} className={`${chip} bg-polish/15 text-slate`}>
                      {r.type === 'custom'
                        ? (r.note ?? '')
                        : fill(t.profile.summary[r.type] ?? r.type, { value: r.value ?? '' })}
                    </li>
                  ))
                )}
              </ul>
              <p className="text-slate/80">
                {c.nextAppointmentAt
                  ? fill(c.heldForAppointment ? tb.heldForAppointment : tb.nextAppointment, {
                      time: clock.format(c.nextAppointmentAt),
                    })
                  : tb.noAppointment}
              </p>

              <details className="group">
                <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-navy underline">
                  {tb.why}
                </summary>
                <div className="flex flex-col gap-2 pt-2">
                  {c.lines.length === 0 ? (
                    <p className="text-slate/80">{tb.noPoints}</p>
                  ) : (
                    <table className="w-full text-left">
                      <caption className="sr-only">
                        {fill(tb.pointsOf, { name: c.displayName })}
                      </caption>
                      <tbody>
                        {c.lines.map((l, k) => (
                          <tr key={k} className="border-b border-pumice">
                            <td className="w-16 py-1 pr-3 font-semibold tabular-nums">
                              {signedPoints(l.delta)}
                            </td>
                            <td className="py-1">{lineText(l, tb, t.me.call.reasons)}</td>
                            <td className="py-1 pl-3 text-right text-small text-slate/70">
                              {clock.format(l.at)}
                            </td>
                          </tr>
                        ))}
                        <tr>
                          <td className="py-1 pr-3 font-semibold">
                            {formatPoints(c.points, c.hadAppointmentLast)}
                          </td>
                          <td className="py-1 font-semibold" colSpan={2}>
                            {tb.total}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  )}
                  <p className="text-slate/80">
                    {c.checkedInAt
                      ? fill(tb.checkedIn, {
                          time: clock.format(c.checkedInAt),
                          rank: c.checkInRank,
                          count: cards.length,
                        })
                      : null}
                  </p>
                  {c.hadAppointmentLast && everyScore ? (
                    <p className="text-slate/80">{tb.appointmentLast}</p>
                  ) : c.hadAppointmentLast && zeroOnly && c.points === 0 ? (
                    <p className="text-slate/80">{tb.appointmentLastZero}</p>
                  ) : null}
                  {ahead ? (
                    <p className="text-slate/80">
                      {fill(tb.ahead[aheadBecause(c, ahead, sort)], { name: ahead.displayName })}
                    </p>
                  ) : null}
                  {canEdit ? (
                    <Link
                      href={`/admin/staff/${c.technicianId}`}
                      className="font-semibold text-navy underline"
                    >
                      {tb.edit}
                    </Link>
                  ) : null}
                </div>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

import {
  auditEntries,
  AUDIT_ACTIONS,
  AUDIT_MAX_DAYS,
  AUDIT_MAX_ROWS,
  auditTable,
  techniciansAt,
} from '@turn/db/reports';
import { locations } from '@turn/db';
import { visitLabels } from '@turn/db/clients';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { SectionTabs } from '@/components/SectionTabs';
import { pointsWord } from '@/components/Board';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { can } from '@/lib/permissions';
import { filterQuery, parseLogFilters } from './filters';
import { auditLabels } from './labels';
import { formatReadable, visitIdsOf } from './readable';

// Audit log viewer (Part 8). Owners and managers, at the location the session
// says (managers: their own). Read only: the log is append-only (T17). The
// queue snapshot on a call shows who was ahead and why (T4); technicians never
// reach this page. No client name or phone is in the log itself: v0.16.1 shows
// a visit as "First L. · services", looked up here for the screen only (the
// owner and managers see the same on the board); the CSV keeps the ids.
export default async function LogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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
        <AdminNav current="log" />
        <p className="max-w-[60ch] text-lead">{t.log.notAllowed}</p>
      </main>
    );
  }

  const [loc] = await db()
    .select({ timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, m.locationId));
  const tz = loc?.timezone ?? 'UTC';
  const f = parseLogFilters(params, tz);
  const [rows, techs] = await Promise.all([
    auditEntries(db(), { locationId: m.locationId, ...f }),
    techniciansAt(db(), m.locationId),
  ]);
  const table = auditTable(rows, tz, auditLabels(t));
  const visits = await visitLabels(db(), m.locationId, visitIdsOf(rows));
  const readable = { t, timezone: tz, lang, visits };
  const mayExport = can(m.role, 'export_data');
  const skip = t.desk.skip as Record<string, string>;
  const status = t.board.status as Record<string, string>;
  const input = 'min-h-11 rounded-control border-2 border-slate/30 bg-board px-3';

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      <AdminNav current="log" />
      <SectionTabs
        label={t.nav.reportsHistory}
        current="/admin/log"
        items={[
          { href: '/admin/reports', label: t.nav.reports },
          { href: '/admin/log', label: t.nav.history },
        ]}
      />
      <section className="flex flex-col gap-2">
        <h1 className="text-heading font-semibold">
          {t.log.title}: {m.locationName}
        </h1>
        <p className="max-w-[70ch] text-slate/80">{t.log.lead}</p>
      </section>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t.log.from}</span>
          <input type="date" name="from" defaultValue={f.from} className={input} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t.log.to}</span>
          <input type="date" name="to" defaultValue={f.to} className={input} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t.log.technician}</span>
          <select name="technician" defaultValue={f.technicianId ?? ''} className={input}>
            <option value="">{t.log.anyTechnician}</option>
            {techs.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t.log.action}</span>
          <select name="action" defaultValue={f.action ?? ''} className={input}>
            <option value="">{t.log.anyAction}</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t.log.actions[a] ?? a}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit">{t.log.apply}</Button>
        {mayExport ? (
          <a
            href={`/admin/log/export?${filterQuery(f)}`}
            className="inline-flex min-h-11 items-center rounded-control border-2 border-slate px-5 font-semibold text-slate hover:bg-board"
          >
            {t.log.exportCsv}
          </a>
        ) : null}
      </form>
      <p className="text-small text-slate/70">
        {fill(t.log.count, { count: rows.length })}
        {f.clamped ? ` ${fill(t.log.rangeTooLong, { days: AUDIT_MAX_DAYS })}` : ''}
        {rows.length >= AUDIT_MAX_ROWS ? ` ${fill(t.log.tooMany, { count: AUDIT_MAX_ROWS })}` : ''}
        {mayExport ? ` ${t.log.exportNote}` : ` ${t.log.exportOwnerOnly}`}
      </p>

      {rows.length === 0 ? (
        <p className="text-lead">{t.log.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-small">
            <thead>
              <tr className="border-b-2 border-slate/30">
                {table.header.slice(0, 8).map((h) => (
                  <th key={h} scope="col" className="px-2 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.body.map((cells, i) => {
                const r = rows[i]!;
                return (
                  <tr key={r.id} className="border-b border-slate/15 align-top">
                    {cells.slice(0, 6).map((c, j) => (
                      <td key={j} className="whitespace-nowrap px-2 py-2">
                        {c}
                      </td>
                    ))}
                    <td className="min-w-[16rem] px-2 py-2">
                      {r.readable.length > 0 ? (
                        <ul className="flex flex-col gap-0.5">
                          {formatReadable(r.readable, readable).map((line, n) => (
                            <li key={n}>{line}</li>
                          ))}
                        </ul>
                      ) : null}
                      {r.queue ? (
                        <details className="mt-1">
                          <summary className="cursor-pointer font-medium">
                            {t.log.showQueue}
                          </summary>
                          <ol className="mt-1 flex flex-col gap-0.5">
                            {r.queue.map((q, n) => (
                              <li key={n}>
                                {fill(t.log.queueLine, {
                                  n: n + 1,
                                  name: q.name,
                                  points: pointsWord(q.points, q.hadAppointmentLast, t.board),
                                  status: status[q.status] ?? q.status,
                                })}
                                {q.eligible
                                  ? ''
                                  : ` (${fill(t.log.queueSkipped, { why: fill(skip[q.why] ?? q.why, { detail: q.detail }) })})`}
                              </li>
                            ))}
                          </ol>
                        </details>
                      ) : null}
                    </td>
                    <td className="px-2 py-2">{cells[7]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

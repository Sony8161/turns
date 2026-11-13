import {
  CLIENT_SEARCH_LIMIT,
  findClients,
  parseClientQuery,
  type ClientHit,
} from '@turn/db/clients';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';

// Client search (v0.13.0, Duong 2026-11-12): by phone in any format, or by
// name without accents. Owner, managers and the front desk; never a
// technician. No export of the list (threat model T11). v0.17.1 (review #4):
// at least 4 digits or 3 letters, and every search, client page, fix lookup
// and "Show" counts against one per-person limit (@turn/db/clients).

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const [{ lang, t }, actor, params] = await Promise.all([
    getDictionary(),
    requireActor(),
    searchParams,
  ]);
  const m = membershipWith(actor, 'view_board');
  if (!m) redirect(actor.memberships.some((x) => x.role === 'technician') ? '/me' : '/admin');
  const tc = t.clients;
  const q = (Array.isArray(params.q) ? params.q[0] : params.q)?.slice(0, 60) ?? '';
  const parsed = q ? parseClientQuery(q) : null;
  let limited = false;
  let hits: ClientHit[] = [];
  if (parsed) {
    const r = await findClients(db(), {
      viewer: {
        userId: actor.userId,
        role: m.role,
        organizationId: m.organizationId,
        locationId: m.locationId,
      },
      query: q,
    });
    if (r.ok) hits = r.hits;
    else limited = r.reason === 'too_many';
  }
  const day = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-US', { dateStyle: 'medium' });
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      <AdminNav current="clients" />
      <section className="flex flex-col gap-2">
        <h1 className="text-heading font-semibold">{tc.title}</h1>
        <p className="max-w-[70ch] text-slate/80">{tc.lead}</p>
      </section>
      <form role="search" method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
          <span className="font-medium">{tc.searchLabel}</span>
          <input
            name="q"
            defaultValue={q}
            maxLength={60}
            autoComplete="off"
            placeholder={tc.searchPlaceholder}
            className="min-h-12 rounded-control border-2 border-slate/30 bg-board px-3 text-lead"
          />
        </label>
        <Button type="submit">{tc.search}</Button>
      </form>
      {q && !parsed ? <p className="text-slate/80">{tc.tooShort}</p> : null}
      {limited ? (
        <p role="alert" className="font-semibold text-polish">
          {tc.tooMany}
        </p>
      ) : null}
      {parsed && !limited ? (
        hits.length === 0 ? (
          <p className="text-slate/80">{tc.none}</p>
        ) : (
          <section className="flex flex-col gap-2">
            <p className="text-small text-slate/70">
              {hits.length >= CLIENT_SEARCH_LIMIT
                ? fill(tc.first, { n: hits.length })
                : fill(tc.found, { n: hits.length })}
            </p>
            <ul className="flex flex-col gap-2">
              {hits.map((h) => (
                <li key={h.id}>
                  {/* v0.17.1: no prefetch, so only a real tap counts as a page view. */}
                  <Link
                    href={`/admin/clients/${h.id}`}
                    prefetch={false}
                    className="flex min-h-14 flex-wrap items-center justify-between gap-3 bg-board px-4 py-3 hover:bg-pumice"
                  >
                    <span className="flex flex-col">
                      <span className="font-semibold">
                        {[h.firstName, h.lastName].filter(Boolean).join(' ') || tc.noName}
                      </span>
                      <span className="text-small text-slate/70">{h.phone ?? tc.noPhone}</span>
                    </span>
                    <span className="text-small text-slate/80">
                      {fill(h.visitCount === 1 ? tc.visitsOne : tc.visits, { n: h.visitCount })}
                      {h.lastVisitAt
                        ? ` · ${fill(tc.lastVisit, { date: day.format(h.lastVisitAt) })}`
                        : ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )
      ) : null}
    </main>
  );
}

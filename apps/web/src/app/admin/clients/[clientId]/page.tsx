import { viewClient } from '@turn/db/clients';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { isUuid } from '@/lib/ids';
import { ClientForm } from './ClientForm';
import { ShowPhone } from './ShowPhone';

// One client (v0.13.0): full name, phone, visits, usual technician, notes;
// the desk edits first and last name and notes. Same roles as search.
// v0.17.1 (review #4): a page view counts against the same per-person limit
// as search; the full phone is for owners and managers, a receptionist sees
// the last four digits and taps Show (counted and audited, no number).
export default async function ClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  if (!isUuid(clientId)) notFound();
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  const m = membershipWith(actor, 'view_board');
  if (!m) redirect(actor.memberships.some((x) => x.role === 'technician') ? '/me' : '/admin');
  const viewed = await viewClient(db(), {
    viewer: {
      userId: actor.userId,
      role: m.role,
      organizationId: m.organizationId,
      locationId: m.locationId,
    },
    clientId,
  });
  if (!viewed.ok && viewed.reason !== 'too_many') notFound();
  const tc = t.clients;
  const day = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-US', { dateStyle: 'medium' });
  const c = viewed.ok ? viewed.client : null;
  const full = c ? [c.firstName, c.lastName].filter(Boolean).join(' ') || tc.noName : '';
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      <AdminNav current="clients" />
      {!c ? (
        <section className="flex flex-col gap-2">
          <Link href="/admin/clients" className="text-small underline">
            {tc.back}
          </Link>
          <p role="alert" className="font-semibold text-polish">
            {tc.tooMany}
          </p>
        </section>
      ) : (
        <ClientBody c={c} full={full} day={day} t={t} />
      )}
    </main>
  );
}

function ClientBody({
  c,
  full,
  day,
  t,
}: {
  c: Extract<Awaited<ReturnType<typeof viewClient>>, { ok: true }>['client'];
  full: string;
  day: Intl.DateTimeFormat;
  t: Dictionary;
}) {
  const tc = t.clients;
  return (
    <>
      <section className="flex flex-col gap-2">
        <Link href="/admin/clients" className="text-small underline">
          {tc.back}
        </Link>
        <h1 className="text-heading font-semibold">{full}</h1>
        {c.phoneMasked && c.phone ? (
          <ShowPhone clientId={c.id} masked={c.phone} t={tc} />
        ) : (
          <p className="text-lead">{c.phone ? formatPhone(c.phone) : tc.noPhone}</p>
        )}
        <p className="text-slate/80">
          {fill(c.visitCount === 1 ? tc.visitsOne : tc.visits, { n: c.visitCount })}
          {c.lastVisitAt ? ` · ${fill(tc.lastVisit, { date: day.format(c.lastVisitAt) })}` : ''}
          {c.usualTechnician ? ` · ${fill(tc.usual, { name: c.usualTechnician })}` : ''}
          {c.noShows > 0 ? ` · ${fill(tc.noShows, { n: c.noShows })}` : ''}
        </p>
      </section>
      <ClientForm
        clientId={c.id}
        firstName={c.firstName ?? ''}
        lastName={c.lastName ?? ''}
        notes={c.notes ?? ''}
        t={tc}
      />
      <section className="flex flex-col gap-2">
        <h2 className="text-heading font-semibold">{tc.recent}</h2>
        {c.recent.length === 0 ? (
          <p className="text-slate/80">{tc.noVisits}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {c.recent.map((r, i) => (
              <li
                key={i}
                className="flex flex-wrap justify-between gap-3 border-b border-pumice py-2"
              >
                <span>
                  {day.format(r.at)}: {r.services.join(' + ') || '—'}
                </span>
                <span className="text-slate/80">
                  {r.technician ?? ''}{' '}
                  {r.status === 'completed' ? '' : `(${t.clients.status[r.status] ?? r.status})`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** +18135550199 as (813) 555-0199. */
function formatPhone(phone: string): string {
  return phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
}

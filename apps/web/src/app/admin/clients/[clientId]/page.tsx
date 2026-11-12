import { clientDetail } from '@turn/db/clients';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { isUuid } from '@/lib/ids';
import { can } from '@/lib/permissions';
import { signOut } from '../../../login/actions';
import { ClientForm } from './ClientForm';

// One client (v0.13.0): full name, phone, visits, usual technician, notes;
// the desk edits first and last name and notes. Same roles as search.
export default async function ClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  if (!isUuid(clientId)) notFound();
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  const m = membershipWith(actor, 'view_board');
  if (!m) redirect(actor.memberships.some((x) => x.role === 'technician') ? '/me' : '/admin');
  const c = await clientDetail(db(), m.locationId, clientId);
  if (!c) notFound();
  const tc = t.clients;
  const day = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-US', { dateStyle: 'medium' });
  const full = [c.firstName, c.lastName].filter(Boolean).join(' ') || tc.noName;
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
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
      <AdminNav
        t={t.nav}
        current="clients"
        canStaff={can(m.role, 'invite_staff')}
        canRules={can(m.role, 'manage_rules')}
        canManage={can(m.role, 'override_queue')}
        canLog={can(m.role, 'view_audit')}
        canKiosk={can(m.role, 'manage_kiosks')}
      />
      <section className="flex flex-col gap-2">
        <Link href="/admin/clients" className="text-small underline">
          {tc.back}
        </Link>
        <h1 className="text-heading font-semibold">{full}</h1>
        <p className="text-lead">
          {c.phone?.match(/^\+1(\d{3})(\d{3})(\d{4})$/)
            ? c.phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3')
            : (c.phone ?? tc.noPhone)}
        </p>
        <p className="text-slate/80">
          {fill(tc.visits, { n: c.visitCount })}
          {c.lastVisitAt ? ` · ${fill(tc.lastVisit, { date: day.format(c.lastVisitAt) })}` : ''}
          {c.usualTechnician ? ` · ${fill(tc.usual, { name: c.usualTechnician })}` : ''}
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
    </main>
  );
}

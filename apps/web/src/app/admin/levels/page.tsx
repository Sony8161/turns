import { menuLevels } from '@turn/db/levels';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { can } from '@/lib/permissions';
import { signOut } from '../../login/actions';
import { ServiceLevels } from './ServiceLevels';

// Skill levels (v0.14.0, Duong 2026-11-12): which levels get each service by
// turn, and which services the desk picks the technician for. Owners and
// managers, their own location. Each technician's own level is on their page.
export default async function LevelsPage() {
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  const onlyTechnician =
    actor.memberships.length > 0 && actor.memberships.every((m) => m.role === 'technician');
  if (onlyTechnician) redirect('/me');
  const m = membershipWith(actor, 'edit_technicians');
  const any = actor.memberships[0];
  const services = m ? await menuLevels(db(), m.locationId) : [];

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
        current="staff"
        canStaff={!!any && can((m ?? any).role, 'invite_staff')}
        canRules={!!m && can(m.role, 'manage_rules')}
        canManage={!!m && can(m.role, 'override_queue')}
        canLog={!!m && can(m.role, 'view_audit')}
      />
      <section className="flex flex-col gap-2">
        <h1 className="text-heading font-semibold">{t.levels.title}</h1>
        <p className="max-w-[70ch] text-slate/80">{t.levels.lead}</p>
        <p className="text-slate/80">
          <Link href="/admin/staff" className="font-semibold underline">
            {t.levels.techsLink}
          </Link>
        </p>
      </section>
      {m ? (
        <ServiceLevels services={services} t={t.levels} />
      ) : (
        <p className="max-w-[60ch] text-lead">{t.levels.notAllowed}</p>
      )}
    </main>
  );
}

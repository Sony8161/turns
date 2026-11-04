import { listStaff } from '@turn/db/staff';
import { redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { maskContact } from '@/lib/contact';
import { db } from '@/lib/db';
import { can } from '@/lib/permissions';
import { signOut } from '../../login/actions';
import { StaffPanel } from './StaffPanel';

// Staff (Part 5): invite codes, role changes, archive and restore. Owners and
// managers; a manager only at their own location (the membership decides).
export default async function StaffPage() {
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  const onlyTechnician =
    actor.memberships.length > 0 && actor.memberships.every((m) => m.role === 'technician');
  if (onlyTechnician) redirect('/me');
  const m = membershipWith(actor, 'invite_staff');

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
        <AdminNav t={t.nav} current="staff" canStaff={false} canRules={false} />
        <p className="max-w-[60ch] text-lead">{t.staff.notAllowed}</p>
      </main>
    );
  }

  const rows = await listStaff(db(), m.locationId);
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      {header}
      <AdminNav t={t.nav} current="staff" canStaff canRules={can(m.role, 'manage_rules')} />
      <section className="flex flex-col gap-2">
        <h1 className="text-heading font-semibold">
          {fill(t.admin.locationRole, { location: m.locationName, role: t.roles[m.role] })}
        </h1>
        <p className="max-w-[70ch] text-slate/80">{t.staff.lead}</p>
      </section>
      <StaffPanel
        rows={rows.map((r) => ({
          membershipId: r.membershipId,
          displayName: r.displayName,
          contact: [
            r.phone ? maskContact({ kind: 'phone', value: r.phone }) : null,
            r.email ? maskContact({ kind: 'email', value: r.email }) : null,
          ]
            .filter(Boolean)
            .join(' · '),
          role: r.role,
          active: r.active,
          technicianStatus: r.technicianStatus,
          isMe: r.userId === actor.userId,
        }))}
        actorRole={m.role}
        lang={lang}
        t={t.staff}
        roles={t.roles}
        statuses={t.board.status}
      />
    </main>
  );
}

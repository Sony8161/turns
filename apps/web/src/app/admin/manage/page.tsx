import { todayPenalties, waitingVisits } from '@turn/db/engine';
import { locationStatus, sweepFloor } from '@turn/db/status';
import { redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { AutoRefresh } from '@/components/AutoRefresh';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { can } from '@/lib/permissions';
import { signOut } from '../../login/actions';
import { visitChips } from '../chips';
import { ManagePanel } from './ManagePanel';

// Overrides (Part 6): reassign a visit, excuse a penalty, adjust points. Owners
// and managers, at their own location; every change carries a reason.
export default async function ManagePage() {
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  const onlyTechnician =
    actor.memberships.length > 0 && actor.memberships.every((m) => m.role === 'technician');
  if (onlyTechnician) redirect('/me');
  const m = membershipWith(actor, 'override_queue');
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
          current="manage"
          canStaff={!!any && can(any.role, 'invite_staff')}
          canRules={!!any && can(any.role, 'manage_rules')}
          canManage={false}
        />
        <p className="max-w-[60ch] text-lead">{t.manage.notAllowed}</p>
      </main>
    );
  }

  await sweepFloor(db(), m.locationId);
  const [open, penalties, board] = await Promise.all([
    waitingVisits(db(), m.locationId),
    todayPenalties(db(), m.locationId),
    locationStatus(db(), m.locationId),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      <AutoRefresh seconds={10} />
      {header}
      <AdminNav
        t={t.nav}
        current="manage"
        canStaff={can(m.role, 'invite_staff')}
        canRules={can(m.role, 'manage_rules')}
        canManage
      />
      <section className="flex flex-col gap-2">
        <h1 className="text-heading font-semibold">
          {fill(t.admin.locationRole, { location: m.locationName, role: t.roles[m.role] })}
        </h1>
        <p className="max-w-[70ch] text-slate/80">{t.manage.lead}</p>
      </section>
      <ManagePanel
        visits={open.map((v) => ({
          id: v.id,
          status: t.manage.visitStatus[v.status as keyof typeof t.manage.visitStatus] ?? v.status,
          services: v.services,
          holder: v.calledTechnician ?? v.assignedTechnician,
          chips: visitChips(v, t.desk.chips),
        }))}
        penalties={penalties.map((p) => ({
          ledgerId: p.ledgerId,
          technicianName: p.technicianName,
          points: p.delta,
          kind: p.reasonType,
          note: p.note,
          excused: p.excused,
        }))}
        technicians={board
          .filter((r) => r.status !== 'off')
          .sort((a, b) => a.points - b.points)
          .map((r) => ({ id: r.technicianId, name: r.displayName, points: r.points }))}
        t={t.manage}
        skip={t.desk.skip}
      />
    </main>
  );
}

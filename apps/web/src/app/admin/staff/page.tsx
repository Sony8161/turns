import { and, eq, isNull } from 'drizzle-orm';
import { serviceCategories } from '@turn/db';
import { loadProfiles, type TechnicianProfile } from '@turn/db/profile';
import { listStaff } from '@turn/db/staff';
import { redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { Button } from '@/components/ui';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { maskContact } from '@/lib/contact';
import { db } from '@/lib/db';
import { can } from '@/lib/permissions';
import { signOut } from '../../login/actions';
import { StaffPanel } from './StaffPanel';

/** One line per technician: what they do and who they do not take (Part 6). */
function profileSummary(
  profile: TechnicianProfile | undefined,
  categoryNames: Map<string, string>,
  t: Dictionary['profile'],
): string {
  const skills =
    !profile || profile.skillCategoryIds.length === 0
      ? t.summaryEverything
      : fill(t.summaryOnly, {
          // An archived category is left out of the line.
          list: profile.skillCategoryIds
            .map((id) => categoryNames.get(id))
            .filter(Boolean)
            .join(', '),
        });
  const restrictions = profile?.restrictions.length
    ? profile.restrictions
        .map((r) =>
          r.type === 'custom'
            ? (r.note ?? '')
            : fill(t.summary[r.type] ?? r.type, { value: r.value ?? '' }),
        )
        .join(', ')
    : t.summaryNone;
  const tags = profile?.tags.length ? ` · ${profile.tags.join(', ')}` : '';
  return `${skills} · ${restrictions}${tags}`;
}

// Staff (Part 5): invite codes, role changes, archive and restore. Owners and
// managers; a manager only at their own location (the membership decides).
// Part 6 adds each technician's skills and restrictions, with a link to edit.
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
        <AdminNav t={t.nav} current="staff" canStaff={false} canRules={false} canManage={false} />
        <p className="max-w-[60ch] text-lead">{t.staff.notAllowed}</p>
      </main>
    );
  }

  const [rows, profiles, categories] = await Promise.all([
    listStaff(db(), m.locationId),
    loadProfiles(db(), m.locationId),
    db()
      .select({ id: serviceCategories.id, name: serviceCategories.name })
      .from(serviceCategories)
      .where(
        and(eq(serviceCategories.locationId, m.locationId), isNull(serviceCategories.archivedAt)),
      ),
  ]);
  const categoryNames = new Map(categories.map((c) => [c.id, c.name]));
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      {header}
      <AdminNav
        t={t.nav}
        current="staff"
        canStaff
        canRules={can(m.role, 'manage_rules')}
        canManage={can(m.role, 'override_queue')}
      />
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
          technicianId: r.technicianId,
          profile:
            r.technicianId && r.role === 'technician'
              ? profileSummary(profiles.get(r.technicianId), categoryNames, t.profile)
              : null,
        }))}
        actorRole={m.role}
        lang={lang}
        t={t.staff}
        roles={t.roles}
        statuses={t.board.status}
        editProfile={can(m.role, 'edit_technicians') ? t.profile.edit : null}
      />
    </main>
  );
}

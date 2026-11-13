import { and, eq, isNull } from 'drizzle-orm';
import { serviceCategories } from '@turn/db';
import { loadProfiles, type TechnicianProfile } from '@turn/db/profile';
import { listStaff } from '@turn/db/staff';
import { receptionistMayEdit } from '@turn/db/tech-settings';
import { receptionistMayActFor } from '@turn/db/act-for';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { categoryLabel } from '../floor/model';
import { fill, type Dictionary } from '@/i18n/dictionary';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { maskContact } from '@/lib/contact';
import { db } from '@/lib/db';
import { allowedAt, can } from '@/lib/permissions';
import { receptionistSeesPhoneAt } from '@turn/db/clients';
import { phoneSettingAction } from '../settings-actions';
import { SwitchForm } from '../SwitchForm';
import { ReceptionistToggle } from './ReceptionistToggle';
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

  if (!m) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
        <AdminNav current="staff" />
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
  const categoryNames = new Map(
    categories.map((c) => [c.id, categoryLabel(c.name, t.floor.category)]),
  );
  const owner = can(m.role, 'manage_rules');
  const deskEdits = owner ? await receptionistMayEdit(db(), m.locationId) : false;
  const deskActsFor = owner ? await receptionistMayActFor(db(), m.locationId) : false;
  const deskSeesPhone = owner ? await receptionistSeesPhoneAt(db(), m.locationId) : true;
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      <AdminNav current="staff" />
      <section className="flex flex-col gap-2">
        <h1 className="text-heading font-semibold">
          {fill(t.admin.locationRole, { location: m.locationName, role: t.roles[m.role] })}
        </h1>
        <p className="max-w-[70ch] text-slate/80">{t.staff.lead}</p>
        <p>
          <Link href="/admin/levels" className="font-semibold underline">
            {t.levels.link}
          </Link>
        </p>
      </section>
      {owner ? <ReceptionistToggle on={deskEdits} t={t.techSettings} /> : null}
      {owner ? <ReceptionistToggle on={deskActsFor} t={t.techSettings} kind="act_for" /> : null}
      {owner ? (
        // v0.18.0 (Duong, 2026-11-13): one new setting, under Advanced.
        <details className="bg-board p-5">
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
            {t.floor.advanced}
          </summary>
          <div className="pt-3">
            <SwitchForm
              action={phoneSettingAction}
              on={deskSeesPhone}
              label={t.floor.phoneSetting}
              hint={t.floor.phoneSettingHint}
              save={t.floor.save}
              saved={t.floor.saved}
              failed={t.techSettings.errors.server ?? ''}
            />
          </div>
        </details>
      ) : null}
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
        editProfile={(await allowedAt(db(), m, 'edit_technicians')) ? t.profile.edit : null}
      />
    </main>
  );
}

import { and, asc, eq, isNull } from 'drizzle-orm';
import { serviceCategories, technicians } from '@turn/db';
import { locationStatus } from '@turn/db/status';
import { menuLevels, technicianLevel } from '@turn/db/levels';
import { loadProfile } from '@turn/db/profile';
import { mayEditTechnicians } from '@turn/db/tech-settings';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { categoryLabel } from '../../floor/model';
import { fill } from '@/i18n/dictionary';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { isUuid } from '@/lib/ids';
import { can } from '@/lib/permissions';
import { LevelForm } from './LevelForm';
import { ProfileForm } from './ProfileForm';
import { TodayPanel } from './TodayPanel';

// One technician's settings (Part 6; v0.13.0 adds today's status and points):
// owners, managers and, unless the owner turned it off, receptionists, for a
// technician at their own location. Technicians are sent to /me.
export default async function TechnicianProfilePage({
  params,
}: {
  params: Promise<{ technicianId: string }>;
}) {
  const { technicianId } = await params;
  if (!isUuid(technicianId)) notFound();
  const [{ t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  const onlyTechnician =
    actor.memberships.length > 0 && actor.memberships.every((m) => m.role === 'technician');
  if (onlyTechnician) redirect('/me');
  const board = membershipWith(actor, 'view_board');
  const m = board && (await mayEditTechnicians(db(), board)) ? board : null;

  if (!m) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
        <AdminNav current="staff" />
        <p className="max-w-[60ch] text-lead">{t.profile.notAllowed}</p>
      </main>
    );
  }

  // Only a technician at the actor's own location is shown at all (T10).
  const [tech] = await db()
    .select({ id: technicians.id, displayName: technicians.displayName })
    .from(technicians)
    .where(
      and(
        eq(technicians.id, technicianId),
        eq(technicians.locationId, m.locationId),
        eq(technicians.organizationId, m.organizationId),
      ),
    );
  if (!tech) notFound();

  const [categories, profile, floor, menu, level] = await Promise.all([
    db()
      .select({ id: serviceCategories.id, name: serviceCategories.name })
      .from(serviceCategories)
      .where(
        and(eq(serviceCategories.locationId, m.locationId), isNull(serviceCategories.archivedAt)),
      )
      .orderBy(asc(serviceCategories.name)),
    loadProfile(db(), tech.id),
    locationStatus(db(), m.locationId),
    menuLevels(db(), m.locationId),
    technicianLevel(db(), tech.id),
  ]);
  // v0.14.0: levels are set by an owner or a manager only.
  const mayLevel = can(m.role, 'manage_levels');
  const today = floor.find((r) => r.technicianId === tech.id);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      <AdminNav current="staff" />
      <section className="flex flex-col gap-2">
        <Link
          href={can(m.role, 'invite_staff') ? '/admin/staff' : '/admin'}
          className="text-small underline"
        >
          {can(m.role, 'invite_staff') ? t.nav.staff : t.nav.board}
        </Link>
        <h1 className="text-heading font-semibold">{tech.displayName}</h1>
        <p className="max-w-[70ch] text-slate/80">{t.techSettings.lead}</p>
      </section>
      <TodayPanel
        technicianId={tech.id}
        name={tech.displayName}
        status={today?.status ?? 'off'}
        points={today?.points ?? 0}
        hadAppointmentLast={today?.hadAppointmentLast ?? false}
        t={t.techSettings}
        board={t.board}
      />
      {mayLevel ? (
        <LevelForm
          key={`${level.level ?? 'none'}:${level.serviceIds.length}`}
          technicianId={tech.id}
          level={level.level}
          serviceIds={level.serviceIds}
          services={menu.map((s) => ({ id: s.id, name: s.name, minLevel: s.minLevel }))}
          t={t.levels}
        />
      ) : (
        <p className="bg-board p-5 text-slate/80">
          {fill(t.levels.readOnly, {
            level: level.level ? (t.levels.name[level.level] ?? level.level) : t.levels.notSet,
          })}
        </p>
      )}
      {mayLevel ? (
        <p>
          <Link href="/admin/levels" className="font-semibold underline">
            {t.levels.link}
          </Link>
        </p>
      ) : null}
      <section className="flex flex-col gap-2">
        <h2 className="text-heading font-semibold">{t.profile.title}</h2>
        <p className="max-w-[70ch] text-slate/80">{t.profile.lead}</p>
      </section>
      <ProfileForm
        technicianId={tech.id}
        categories={categories.map((c) => ({
          ...c,
          name: categoryLabel(c.name, t.floor.category),
        }))}
        skillCategoryIds={profile.skillCategoryIds}
        levelSet={level.level !== null}
        tags={profile.tags}
        restrictions={profile.restrictions}
        t={t.profile}
      />
    </main>
  );
}

import { and, asc, eq, isNull } from 'drizzle-orm';
import { serviceCategories, technicians } from '@turn/db';
import { loadProfile } from '@turn/db/profile';
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
import { ProfileForm } from './ProfileForm';

// One technician's skills, tags and restrictions (Part 6). Owners and
// managers, for a technician at their own location.
export default async function TechnicianProfilePage({
  params,
}: {
  params: Promise<{ technicianId: string }>;
}) {
  const { technicianId } = await params;
  if (!isUuid(technicianId)) notFound();
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  const onlyTechnician =
    actor.memberships.length > 0 && actor.memberships.every((m) => m.role === 'technician');
  if (onlyTechnician) redirect('/me');
  const m = membershipWith(actor, 'edit_technicians');

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

  const [categories, profile] = await Promise.all([
    db()
      .select({ id: serviceCategories.id, name: serviceCategories.name })
      .from(serviceCategories)
      .where(
        and(eq(serviceCategories.locationId, m.locationId), isNull(serviceCategories.archivedAt)),
      )
      .orderBy(asc(serviceCategories.name)),
    loadProfile(db(), tech.id),
  ]);

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
        <Link href="/admin/staff" className="text-small underline">
          {t.nav.staff}
        </Link>
        <h1 className="text-heading font-semibold">
          {tech.displayName}: {t.profile.title}
        </h1>
        <p className="max-w-[70ch] text-slate/80">{t.profile.lead}</p>
      </section>
      <ProfileForm
        technicianId={tech.id}
        categories={categories}
        skillCategoryIds={profile.skillCategoryIds}
        tags={profile.tags}
        restrictions={profile.restrictions}
        t={t.profile}
      />
    </main>
  );
}

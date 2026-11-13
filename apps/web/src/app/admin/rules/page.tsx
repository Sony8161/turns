import { and, eq, inArray, isNull } from 'drizzle-orm';
import { locations, profiles, serviceCategories, services } from '@turn/db';
import { ruleHistory } from '@turn/db/rules';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { SectionTabs } from '@/components/SectionTabs';
import { fill } from '@/i18n/dictionary';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { formValues } from './form';
import { checkoutListAt } from '@turn/db/checkout';
import { categoryLabel } from '../floor/model';
import { checkoutListAction } from '../settings-actions';
import { SwitchForm } from '../SwitchForm';
import { RulesForm } from './RulesForm';

// The rule builder (Part 5). Owner only. Every number the engine uses, the
// version history, and a preview of today's board under the typed rules.
export default async function RulesPage() {
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  const onlyTechnician =
    actor.memberships.length > 0 && actor.memberships.every((m) => m.role === 'technician');
  if (onlyTechnician) redirect('/me');
  const m = membershipWith(actor, 'manage_rules');

  if (!m) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
        <AdminNav current="rules" />
        <p className="max-w-[60ch] text-lead">{t.rules.notAllowed}</p>
      </main>
    );
  }

  const [history, categories, loc] = await Promise.all([
    ruleHistory(db(), m.locationId),
    db()
      .select({
        id: serviceCategories.id,
        name: serviceCategories.name,
        isFillOrFullSet: serviceCategories.isFillOrFullSet,
      })
      .from(serviceCategories)
      .where(
        and(eq(serviceCategories.locationId, m.locationId), isNull(serviceCategories.archivedAt)),
      )
      .orderBy(serviceCategories.name),
    db()
      .select({ timezone: locations.timezone })
      .from(locations)
      .where(eq(locations.id, m.locationId))
      .then((r) => r[0]),
  ]);
  // v0.16.0: points per service (polish change, fix).
  const menu = await db()
    .select({
      id: services.id,
      name: services.name,
      categoryId: services.categoryId,
      isFix: services.isFix,
    })
    .from(services)
    .where(and(eq(services.locationId, m.locationId), isNull(services.archivedAt)))
    .orderBy(services.name);
  const current = history.find((h) => h.valid);
  const checkoutOn = await checkoutListAt(db(), m.locationId);
  const authors = [...new Set(history.map((h) => h.createdBy).filter((x): x is string => !!x))];
  const names = authors.length
    ? await db()
        .select({ id: profiles.id, displayName: profiles.displayName })
        .from(profiles)
        .where(inArray(profiles.id, authors))
    : [];
  const nameOf = new Map(names.map((n) => [n.id, n.displayName]));
  const when = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: loc?.timezone,
  });

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      <AdminNav current="rules" />
      <SectionTabs
        label={t.nav.servicesRules}
        current="/admin/rules"
        items={[
          { href: '/admin/rules', label: t.nav.rulesTab },
          { href: '/admin/levels', label: t.nav.levelsByTurn },
        ]}
      />
      <section className="flex flex-col gap-2">
        <h1 className="text-heading font-semibold">{t.rules.title}</h1>
        <p className="max-w-[70ch] text-slate/80">{t.rules.lead}</p>
        <p>
          <Link href="/admin/levels" className="font-semibold underline">
            {t.levels.link}
          </Link>
        </p>
        {current ? (
          <p className="text-slate/80">
            {fill(t.rules.version, { version: current.version })},{' '}
            {fill(t.rules.activeSince, { date: when.format(current.activeFrom) })}
          </p>
        ) : null}
      </section>

      {current?.config ? (
        <RulesForm
          values={formValues(current.config)}
          // v0.18.0: category names in words, never a code like full_set.
          categories={categories.map((c) => ({
            ...c,
            name: categoryLabel(c.name, t.floor.category),
          }))}
          services={menu.map((s) => ({
            id: s.id,
            name: s.name,
            category: categoryLabel(
              categories.find((c) => c.id === s.categoryId)?.name ?? '',
              t.floor.category,
            ),
            isFix: s.isFix,
          }))}
          version={history[0]?.version ?? current.version}
          t={t.rules}
        />
      ) : (
        <p className="text-polish">{t.rules.noValid}</p>
      )}

      {/* v0.18.0 (F1): one new setting, under Advanced. */}
      <details className="bg-board p-5">
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
          {t.floor.advanced}
        </summary>
        <div className="pt-3">
          <SwitchForm
            action={checkoutListAction}
            on={checkoutOn}
            label={t.floor.checkoutSetting}
            hint={t.floor.checkoutSettingHint}
            save={t.floor.save}
            saved={t.floor.saved}
            failed={t.techSettings.errors.server ?? ''}
          />
        </div>
      </details>

      <section className="flex flex-col gap-3">
        <h2 className="text-heading font-semibold">{t.rules.history}</h2>
        <ol className="flex flex-col gap-2">
          {history.map((h) => (
            <li key={h.id} className="flex flex-col bg-board px-4 py-3">
              <span className="font-semibold">
                {fill(t.rules.version, { version: h.version })}
                {h.valid ? '' : ` (${t.rules.invalidVersion})`}
              </span>
              <span className="text-small text-slate/70">
                {when.format(h.activeFrom)}
                {h.createdBy
                  ? `, ${fill(t.rules.savedBy, { name: nameOf.get(h.createdBy) ?? '?' })}`
                  : ''}
                {h.note ? `: ${h.note}` : ''}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { locations, profiles, serviceCategories } from '@turn/db';
import { ruleHistory } from '@turn/db/rules';
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
import { formValues } from './form';
import { RulesForm } from './RulesForm';

// The rule builder (Part 5). Owner only. Every number the engine uses, the
// version history, and a preview of today's board under the typed rules.
export default async function RulesPage() {
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  const onlyTechnician =
    actor.memberships.length > 0 && actor.memberships.every((m) => m.role === 'technician');
  if (onlyTechnician) redirect('/me');
  const m = membershipWith(actor, 'manage_rules');
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
          current="rules"
          canStaff={!!any && can(any.role, 'invite_staff')}
          canRules={false}
        />
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
  const current = history.find((h) => h.valid);
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
      {header}
      <AdminNav t={t.nav} current="rules" canStaff={can(m.role, 'invite_staff')} canRules />
      <section className="flex flex-col gap-2">
        <h1 className="text-heading font-semibold">{t.rules.title}</h1>
        <p className="max-w-[70ch] text-slate/80">{t.rules.lead}</p>
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
          categories={categories}
          version={history[0]?.version ?? current.version}
          t={t.rules}
        />
      ) : (
        <p className="text-polish">{t.rules.noValid}</p>
      )}

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

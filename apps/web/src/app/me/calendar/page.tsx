import { locations } from '@turn/db';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FreshaConnect } from '@/components/FreshaConnect';
import { LinkButton } from '@/components/ui';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { selfRow } from '@/lib/fresha-rows';
import { technicianForUser } from '@/lib/technician';

// A technician's own Fresha calendar (v0.11.0): offered right after joining,
// and from /me later. Their own row only; the saved link never comes back.
export default async function MyCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string }>;
}) {
  const [{ lang, t }, actor, params] = await Promise.all([
    getDictionary(),
    requireActor(),
    searchParams,
  ]);
  const tech = await technicianForUser(actor.userId);
  if (!tech) redirect('/me');
  const [loc] = await db()
    .select({ timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, tech.locationId));
  const row = await selfRow(
    tech.id,
    actor.displayName,
    t,
    lang,
    loc?.timezone ?? 'America/New_York',
  );
  const welcome = params.welcome === '1';

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-8 px-4 py-6">
      <header className="flex items-center justify-between">
        <Link href="/me" className="text-lead font-semibold">
          {t.app.name}
        </Link>
        <LanguageToggle lang={lang} t={t} />
      </header>
      <section className="flex flex-col gap-2">
        <h1 className="text-heading font-semibold">{t.fresha.selfTitle}</h1>
        <p className="text-lead text-slate/80">{t.fresha.selfLead}</p>
        <p className="text-slate/80">{t.fresha.howTo}</p>
      </section>
      <FreshaConnect t={t.fresha} mode="self" rows={[row]} />
      <div className="flex flex-wrap gap-3">
        <LinkButton href="/me">{t.fresha.done}</LinkButton>
        {welcome ? (
          <LinkButton href="/me" tone="quiet">
            {t.fresha.skip}
          </LinkButton>
        ) : null}
      </div>
    </main>
  );
}

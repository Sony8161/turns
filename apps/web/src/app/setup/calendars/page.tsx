import { locations } from '@turn/db';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FreshaConnect } from '@/components/FreshaConnect';
import { LinkButton } from '@/components/ui';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { ownerRows } from '@/lib/fresha-rows';

// Setup, optional last step (v0.11.0): connect each technician's Fresha
// calendar. The owner can skip it; the same card is on Appointments.
export default async function SetupCalendarsPage() {
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  const m = membershipWith(actor, 'manage_rules');
  if (!m || m.role !== 'owner') redirect('/admin');
  const [loc] = await db()
    .select({ timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, m.locationId));
  const rows = await ownerRows(m.locationId, t, lang, loc?.timezone ?? 'America/New_York');

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-6">
      <header className="flex items-center justify-between">
        <Link href="/admin" className="text-lead font-semibold">
          {t.app.name}
        </Link>
        <LanguageToggle lang={lang} t={t} />
      </header>
      <section className="flex flex-col gap-2">
        <h1 className="text-[40px] leading-tight font-semibold">{t.fresha.title}</h1>
        <p className="max-w-[70ch] text-lead text-slate/80">{t.fresha.lead}</p>
        <p className="max-w-[70ch] text-slate/80">{t.fresha.howTo}</p>
      </section>
      {rows.length > 0 ? (
        <FreshaConnect t={t.fresha} mode="owner" rows={rows} />
      ) : (
        <p className="max-w-[70ch] text-lead">{t.fresha.noTechs}</p>
      )}
      <div className="flex flex-wrap gap-3">
        <LinkButton href="/admin">{t.fresha.done}</LinkButton>
        <LinkButton href="/admin" tone="quiet">
          {t.fresha.skip}
        </LinkButton>
      </div>
    </main>
  );
}

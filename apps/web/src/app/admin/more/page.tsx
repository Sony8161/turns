import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { MORE_HREF, moreItemsFor, type MoreItem } from '@/components/nav-model';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { getDictionary } from '@/i18n/lang';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { requireActor } from '@/lib/auth';
import { currentKiosk } from '@/lib/kiosk';
import { can } from '@/lib/permissions';
import { signOut } from '../../login/actions';
import { enterKioskMode } from '../kiosk/actions';

// v0.18.0 (B13, C4): everything that is not the board, appointments or
// clients. Each person sees only what her role opens; a receptionist's More
// holds language and sign out, and that is fine.
export default async function MorePage() {
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  const m = actor.memberships.find((x) => can(x.role, 'view_board'));
  if (!m && actor.memberships.some((x) => x.role === 'technician')) redirect('/me');
  const items = m ? moreItemsFor(m.role) : [];
  const kiosk = m ? await currentKiosk() : null;
  const kioskHere = !!kiosk && kiosk.locationId === m?.locationId;
  const label: Record<MoreItem, { title: string; lead: string }> = {
    reports: { title: t.nav.reportsHistory, lead: t.nav.reportsHistoryLead },
    team: { title: t.nav.team, lead: t.nav.teamLead },
    rules: { title: t.nav.servicesRules, lead: t.nav.servicesRulesLead },
    levels: { title: t.nav.servicesRulesManager, lead: t.nav.servicesRulesLead },
    devices: { title: t.nav.devices, lead: t.nav.devicesLead },
  };
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-4 sm:px-8">
      <AdminNav current="more" />
      <h1 className="text-heading font-semibold">{t.nav.moreTitle}</h1>
      {items.length ? (
        <ul className="flex flex-col gap-2">
          {items.map((i) => (
            <li key={i}>
              <Link
                href={MORE_HREF[i]}
                className="flex min-h-16 flex-col justify-center border-l-[12px] border-navy bg-board px-4 py-3 hover:bg-board/70"
              >
                <span className="text-lead font-semibold">{label[i].title}</span>
                <span className="text-slate/80">{label[i].lead}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-slate/80">{t.nav.moreEmpty}</p>
      )}
      <section className="flex flex-col gap-3 border-t-2 border-pumice pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{t.nav.language}</span>
          <LanguageToggle lang={lang} t={t} />
        </div>
        {kioskHere ? (
          <form action={enterKioskMode}>
            <Button type="submit" tone="quiet">
              {t.nav.kioskMode}
            </Button>
          </form>
        ) : null}
        <form action={signOut}>
          <Button type="submit" tone="quiet">
            {t.nav.signOut}
          </Button>
        </form>
        <p className="text-small text-slate/70">
          {fill(t.admin.welcome, { name: actor.displayName })}
        </p>
      </section>
    </main>
  );
}

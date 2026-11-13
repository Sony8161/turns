import { needsYouCount } from '@turn/db/board';
import Link from 'next/link';
import { fill } from '@/i18n/dictionary';
import { getDictionary } from '@/i18n/lang';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { can } from '@/lib/permissions';
import { LocationSwitch } from './LocationSwitch';
import { TAB_HREF, tabOf, tabsFor, type Page } from './nav-model';

/**
 * v0.18.0 (B13, B14, C4): one slim header on every admin page: where you
 * are, four tabs (Board, Appointments, Clients, More), a one-tap language
 * toggle, and the location switch only for someone at two or more
 * locations. Sign out and the rest moved into More. The Board tab carries
 * the number of things waiting for the desk. Each page checks access again.
 */
export async function AdminNav({ current, badge }: { current: Page; badge?: number }) {
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), getActor()]);
  const m = actor?.memberships.find((x) => can(x.role, 'view_board')) ?? null;
  const tabs = m ? tabsFor(m.role) : [];
  const count =
    badge ?? (m ? await needsYouCount(db(), m.locationId, can(m.role, 'approve_fixes')) : 0);
  const active = tabOf(current);
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate font-semibold">{m?.locationName ?? t.app.name}</span>
        {m ? <span className="text-small text-slate/70">{t.roles[m.role]}</span> : null}
      </div>
      {tabs.length ? (
        <nav
          aria-label="Admin"
          className="order-last grid w-full grid-cols-4 gap-1 sm:order-none sm:flex sm:w-auto sm:items-center"
        >
          {tabs.map((tab) => (
            <Link
              key={tab}
              href={TAB_HREF[tab]}
              aria-current={tab === active ? 'page' : undefined}
              aria-label={
                tab === 'board' && count > 0
                  ? `${t.nav.board}, ${fill(t.nav.boardBadge, { n: count })}`
                  : undefined
              }
              className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-control px-2 font-semibold sm:px-4 ${
                tab === active ? 'bg-navy text-board' : 'text-slate hover:bg-board'
              }`}
            >
              {t.nav[tab]}
              {tab === 'board' && count > 0 ? (
                <span
                  aria-hidden
                  className="inline-flex min-w-6 items-center justify-center rounded-full bg-polish px-1.5 text-small font-semibold text-board"
                >
                  {count}
                </span>
              ) : null}
            </Link>
          ))}
        </nav>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <LocationSwitch t={t.nav} />
        <LanguageToggle lang={lang} t={t} />
      </div>
    </header>
  );
}

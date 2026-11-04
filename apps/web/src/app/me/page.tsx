import { locationStatus } from '@turn/db/status';
import Link from 'next/link';
import { formatPoints } from '@/components/Board';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { technicianForUser } from '@/lib/technician';
import { signOut } from '../login/actions';
import { StatusPanel } from './StatusPanel';

// The technician's own screen: status, today's points, and the moves allowed
// from here. The web version of the phone app; the Expo app (Part 4) shows
// the same thing.
export default async function MePage() {
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  const tech = await technicianForUser(actor.userId);
  const me = tech
    ? (await locationStatus(db(), tech.locationId)).find((r) => r.technicianId === tech.id)
    : undefined;
  const status = me?.status ?? 'off';

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-8 px-4 py-6">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-lead font-semibold">
          {t.app.name}
        </Link>
        <div className="flex items-center gap-3">
          <LanguageToggle lang={lang} t={t} />
          <form action={signOut}>
            <Button type="submit" tone="quiet">
              {t.nav.signOut}
            </Button>
          </form>
        </div>
      </header>

      {!tech ? (
        <p className="text-lead">{t.me.notTechnician}</p>
      ) : (
        <>
          <section className="flex flex-col gap-1">
            <h1 className="text-heading font-semibold">{actor.displayName}</h1>
            <p className="text-lead">{fill(t.me.statusLine, { status: t.board.status[status] })}</p>
            <p className="points text-slate">
              <span aria-hidden>{formatPoints(me?.points ?? 0)}</span>
              <span className="sr-only">
                {formatPoints(me?.points ?? 0)} {t.board.points}
              </span>
            </p>
            <p className="text-slate/70">{t.me.pointsToday}</p>
          </section>
          <StatusPanel status={status} t={t.me} />
        </>
      )}
    </main>
  );
}

import { locationStatus } from '@turn/db/status';
import { Board, type BoardRow } from '@/components/Board';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { redirect } from 'next/navigation';
import { requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { can } from '@/lib/permissions';
import { signOut } from '../login/actions';

// Admin home: the live board, smaller, with today's counts as a sentence.
// Queue order (design doc): lowest points first, then earlier check-in.
// "had appointment last" joins the sort in Part 7 when appointments exist.
export default async function AdminPage() {
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  // Technicians see their own position on /me, never the whole board (roles table).
  const membership = actor.memberships.find((m) => can(m.role, 'view_board'));
  if (!membership && actor.memberships.some((m) => m.role === 'technician')) redirect('/me');
  const rows = membership ? await boardRows(membership.locationId) : [];

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
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

      {membership ? (
        <section className="flex flex-col gap-4">
          <h1 className="text-heading font-semibold">
            {fill(t.admin.locationRole, {
              location: membership.locationName,
              role: t.roles[membership.role],
            })}
          </h1>
          <Board rows={rows} t={t} compact />
          <p className="text-slate/80">
            {fill(t.admin.today, { visits: 0, denies: 0, overrides: 0 })}
          </p>
        </section>
      ) : (
        <p className="max-w-[60ch] text-lead">{t.admin.noSalon}</p>
      )}
    </main>
  );
}

async function boardRows(locationId: string): Promise<BoardRow[]> {
  const now = Date.now();
  const rows = await locationStatus(db(), locationId);
  return rows
    .filter((r) => r.status !== 'off')
    .sort(
      (a, b) =>
        a.points - b.points || (a.checkedInAt?.getTime() ?? 0) - (b.checkedInAt?.getTime() ?? 0),
    )
    .map((r) => ({
      id: r.technicianId,
      name: r.displayName,
      points: r.points,
      status: r.status as BoardRow['status'],
      seconds: Math.max(0, Math.floor((now - (r.since?.getTime() ?? now)) / 1000)),
    }));
}

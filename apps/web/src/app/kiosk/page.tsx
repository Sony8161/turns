import { eq } from 'drizzle-orm';
import { locations } from '@turn/db';
import { kioskMenu, kioskNotice } from '@turn/db/kiosk';
import type { Metadata } from 'next';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { db } from '@/lib/db';
import { currentKiosk } from '@/lib/kiosk';
import { getAuthUser } from '@/lib/supabase/server';
import { signOutForKiosk } from './actions';
import { KioskScreen } from './KioskScreen';
import { PairForm } from './PairForm';

export const metadata: Metadata = { title: 'Check in', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

// The customer check-in iPad (Part 9). Three states: a staff member is still
// signed in on this browser (sign them out first, T20); not paired (enter the
// code from Admin → Kiosk); paired (the check-in screens).
export default async function KioskPage() {
  const [{ lang, t }, user, device] = await Promise.all([
    getDictionary(),
    getAuthUser(),
    currentKiosk(),
  ]);
  const toggle = <LanguageToggle lang={lang} t={t} />;

  if (user) {
    return (
      <Centered toggle={toggle}>
        <h1 className="text-heading font-semibold">{t.kiosk.staffTitle}</h1>
        <p className="text-lead">{t.kiosk.staffLead}</p>
        <form action={signOutForKiosk}>
          <button
            type="submit"
            className="min-h-16 rounded-control bg-navy px-8 text-lead font-semibold text-board"
          >
            {t.kiosk.staffSignOut}
          </button>
        </form>
      </Centered>
    );
  }

  if (!device) {
    return (
      <Centered toggle={toggle}>
        <h1 className="text-heading font-semibold">{t.kiosk.pairTitle}</h1>
        <p className="text-lead">{t.kiosk.pairLead}</p>
        <PairForm t={t.kiosk} />
      </Centered>
    );
  }

  const [menu, notice, loc] = await Promise.all([
    kioskMenu(db(), device),
    kioskNotice(db(), device),
    db()
      .select({ name: locations.name })
      .from(locations)
      .where(eq(locations.id, device.locationId))
      .then((r) => r[0]),
  ]);
  return (
    <KioskScreen
      t={t.kiosk}
      locationName={loc?.name ?? t.app.name}
      services={menu.services}
      technicians={menu.technicians}
      notice={notice}
      languageToggle={toggle}
    />
  );
}

function Centered({ toggle, children }: { toggle: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-6 bg-board px-6 py-6">
      <div className="flex justify-end">{toggle}</div>
      <div className="flex flex-1 flex-col justify-center gap-6">{children}</div>
    </main>
  );
}

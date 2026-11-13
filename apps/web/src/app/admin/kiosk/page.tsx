import { listKiosks } from '@turn/db/kiosk';
import { locations } from '@turn/db';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { fill } from '@/i18n/dictionary';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { KioskAdmin, type KioskRowView } from './KioskAdmin';

// Admin → Kiosk (Part 9): the check-in iPads at this location. Owners and
// managers register one (a pairing code shown once), give it a new code, or
// revoke it. Names and dates only; no hash ever leaves the server.
export default async function KioskAdminPage() {
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  if (actor.memberships.length > 0 && actor.memberships.every((m) => m.role === 'technician')) {
    redirect('/me');
  }
  const m = membershipWith(actor, 'manage_kiosks');

  const nav = <AdminNav current="kiosk" />;

  if (!m) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
        {nav}
        <p className="max-w-[60ch] text-lead">{t.kioskAdmin.notAllowed}</p>
      </main>
    );
  }

  const [rows, loc] = await Promise.all([
    listKiosks(db(), m.locationId),
    db()
      .select({ timezone: locations.timezone })
      .from(locations)
      .where(eq(locations.id, m.locationId))
      .then((r) => r[0]),
  ]);
  const when = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-US', {
    timeZone: loc?.timezone ?? 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const k = t.kioskAdmin;
  const view: KioskRowView[] = rows.map((r) => {
    const parts: string[] = [];
    if (r.revokedAt) parts.push(fill(k.revokedAt, { time: when.format(r.revokedAt) }));
    else if (r.paired && r.pairedAt)
      parts.push(fill(k.pairedAt, { time: when.format(r.pairedAt) }));
    else parts.push(k.notPaired);
    if (!r.revokedAt && r.pairingOpen) {
      // v0.17.0: the real expiry (the sample code lasts 24 hours, a new one 15 minutes).
      parts.push(
        r.pairingExpiresAt
          ? fill(k.codeOpenUntil, { time: when.format(r.pairingExpiresAt) })
          : k.codeOpen,
      );
    }
    if (!r.revokedAt && r.lastSeenAt)
      parts.push(fill(k.lastSeen, { time: when.format(r.lastSeenAt) }));
    return { id: r.id, name: r.name, state: parts.join(' · '), revoked: !!r.revokedAt };
  });

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      {nav}
      <section className="flex flex-col gap-2">
        <h1 className="text-heading font-semibold">{k.title}</h1>
        <p className="max-w-[70ch] text-slate/80">{fill(k.lead, { location: m.locationName })}</p>
      </section>
      <KioskAdmin
        t={k}
        rows={view}
        timezone={loc?.timezone ?? 'America/New_York'}
        locale={lang === 'vi' ? 'vi-VN' : 'en-US'}
      />
    </main>
  );
}

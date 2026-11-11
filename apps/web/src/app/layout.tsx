import type { Metadata } from 'next';
import { Be_Vietnam_Pro } from 'next/font/google';
import { cookies } from 'next/headers';
import { ErrorRefLabel } from '@/components/ErrorRef';
import { KioskStaffGuard } from '@/components/KioskStaffGuard';
import { OfflineBanner } from '@/components/OfflineBanner';
import { getDictionary } from '@/i18n/lang';
import { KIOSK_COOKIE } from '@/lib/kiosk-idle';
import { getAuthUser } from '@/lib/supabase/server';
import './globals.css';

// One family for everything. Drawn for Vietnamese first, so diacritics sit
// right at 112 px; weights cover the board number and admin text.
const beVietnam = Be_Vietnam_Pro({
  variable: '--font-be-vietnam',
  subsets: ['latin', 'vietnamese'],
  weight: ['400', '500', '600', '800'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Turn board',
  description: 'A turn board for nail salons.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { lang, t } = await getDictionary();
  // A staff session on a kiosk iPad gets the idle guard (v0.9.1).
  const kioskStaff = (await cookies()).has(KIOSK_COOKIE) && !!(await getAuthUser());
  return (
    <html lang={lang} className={`${beVietnam.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <OfflineBanner text={t.app.offline} retry={t.app.offlineRetry} />
        {kioskStaff ? <KioskStaffGuard /> : null}
        <ErrorRefLabel label={t.app.errorRef}>{children}</ErrorRefLabel>
      </body>
    </html>
  );
}

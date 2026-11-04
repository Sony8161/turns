import type { Metadata } from 'next';
import { Be_Vietnam_Pro } from 'next/font/google';
import { getLang } from '@/i18n/lang';
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
  const lang = await getLang();
  return (
    <html lang={lang} className={`${beVietnam.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}

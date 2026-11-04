import Link from 'next/link';
import { Board, type BoardRow } from '@/components/Board';
import { LinkButton } from '@/components/ui';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';

// The hero is the product: a board as it looks on a Saturday afternoon.
const DEMO: BoardRow[] = [
  { id: '1', name: 'Linh', points: 0, status: 'available', seconds: 42 },
  { id: '2', name: 'Mai', points: 0, hadAppointmentLast: true, status: 'available', seconds: 65 },
  { id: '3', name: 'Thảo', points: 0.5, status: 'called', service: 'pedicure', seconds: 38 },
  { id: '4', name: 'Hương', points: 1, status: 'in_service', service: 'full set', seconds: 1260 },
  { id: '5', name: 'An', points: 1.5, status: 'break', seconds: 720 },
  { id: '6', name: 'Kim', points: 2, status: 'out', seconds: 2820 },
];

export default async function LandingPage() {
  const { lang, t } = await getDictionary();
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-4 py-6 sm:px-8">
      <header className="flex items-center justify-between">
        <span className="text-lead font-semibold">{t.app.name}</span>
        <LanguageToggle lang={lang} t={t} />
      </header>

      <section className="flex max-w-[34ch] flex-col gap-4">
        <h1 className="text-[40px] leading-[1.1] font-semibold sm:text-[56px]">
          {t.landing.title}
        </h1>
        <p className="text-lead text-slate/80">{t.landing.lead}</p>
        <div className="mt-2 flex flex-wrap gap-3">
          <LinkButton href="/login">{t.landing.signIn}</LinkButton>
          <LinkButton href="/join" tone="quiet">
            {t.landing.join}
          </LinkButton>
        </div>
        <Link href="/setup" className="self-start text-slate/70 underline">
          {t.setup.link}
        </Link>
      </section>

      <figure className="flex flex-col gap-3">
        <Board rows={DEMO} t={t} compact />
        <figcaption className="text-small text-slate/70">{t.landing.demoCaption}</figcaption>
      </figure>
    </main>
  );
}

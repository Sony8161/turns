import Link from 'next/link';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { JoinForm } from './JoinForm';

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ lang, t }, params] = await Promise.all([getDictionary(), searchParams]);
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-8 px-4 py-6">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-lead font-semibold">
          {t.app.name}
        </Link>
        <LanguageToggle lang={lang} t={t} />
      </header>
      <div className="flex flex-col gap-2">
        <h1 className="text-[40px] leading-tight font-semibold">{t.join.title}</h1>
        <p className="text-lead text-slate/80">{t.join.lead}</p>
      </div>
      <JoinForm t={t.join} initialError={params.error} />
    </main>
  );
}

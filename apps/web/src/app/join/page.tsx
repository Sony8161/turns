import Link from 'next/link';
import { Button } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { getActor } from '@/lib/auth';
import { signOut } from '../login/actions';
import { JoinForm } from './JoinForm';

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ lang, t }, params, actor] = await Promise.all([
    getDictionary(),
    searchParams,
    getActor(),
  ]);
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
      {actor ? (
        // An invite code binds a new person. Never attach it to whoever happens
        // to be signed in on this device (a shared salon iPad, or the owner
        // trying a code out).
        <div className="flex flex-col gap-4">
          <p>{fill(t.join.signedInAs, { name: actor.displayName })}</p>
          <form action={signOut}>
            <Button type="submit" tone="quiet">
              {t.nav.signOut}
            </Button>
          </form>
        </div>
      ) : (
        <JoinForm t={t.join} initialError={params.error} />
      )}
    </main>
  );
}

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LanguageToggle } from '@/i18n/LanguageToggle';
import { getDictionary } from '@/i18n/lang';
import { getActor } from '@/lib/auth';
import { readInviteCookie } from '../join/invite-cookie';
import { LoginForm } from './LoginForm';

export default async function LoginPage() {
  const [{ lang, t }, actor, invite] = await Promise.all([
    getDictionary(),
    getActor(),
    readInviteCookie(),
  ]);
  // Already signed in: a pending invite is redeemed for this session, never
  // left waiting for whoever signs in next.
  if (actor) redirect(invite ? '/join/finish' : '/admin');

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-8 px-4 py-6">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-lead font-semibold">
          {t.app.name}
        </Link>
        <LanguageToggle lang={lang} t={t} />
      </header>
      <h1 className="text-[40px] leading-tight font-semibold">{t.login.title}</h1>
      <LoginForm t={t.login} />
    </main>
  );
}

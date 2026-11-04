// The language lives in one cookie so every page, including the kiosk, renders
// server-side in the right language with no flash.
import { cookies } from 'next/headers';
import { dictionaries, LANGS, type Dictionary, type Lang } from './dictionary';

export const LANG_COOKIE = 'lang';
const ONE_YEAR = 60 * 60 * 24 * 365;

function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

export async function getLang(): Promise<Lang> {
  const value = (await cookies()).get(LANG_COOKIE)?.value;
  return isLang(value) ? value : 'en';
}

export async function getDictionary(): Promise<{ lang: Lang; t: Dictionary }> {
  const lang = await getLang();
  return { lang, t: dictionaries[lang] };
}

export async function setLangCookie(lang: Lang): Promise<void> {
  (await cookies()).set(LANG_COOKIE, lang, {
    maxAge: ONE_YEAR,
    sameSite: 'lax',
    httpOnly: true,
    path: '/',
  });
}

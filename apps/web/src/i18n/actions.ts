'use server';

import { LANGS, type Lang } from './dictionary';
import { setLangCookie } from './lang';
import { guardedVoid } from '@/lib/action';

/** Form action behind the language button. Setting the cookie re-renders the page. */
export async function switchLanguage(formData: FormData): Promise<void> {
  return guardedVoid('switchLanguage', () => switchLanguageRun(formData));
}

async function switchLanguageRun(formData: FormData): Promise<void> {
  const next = formData.get('lang');
  if (typeof next !== 'string' || !(LANGS as readonly string[]).includes(next)) return;
  await setLangCookie(next as Lang);
}

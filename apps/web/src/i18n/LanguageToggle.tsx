import { switchLanguage } from './actions';
import { otherLang, type Dictionary, type Lang } from './dictionary';

/** One button, always showing the language you would switch to, in that language. */
export function LanguageToggle({ lang, t }: { lang: Lang; t: Dictionary }) {
  const target = otherLang(lang);
  return (
    <form action={switchLanguage}>
      <input type="hidden" name="lang" value={target} />
      <button
        type="submit"
        className="min-h-11 rounded-control border-2 border-slate px-4 font-medium text-slate hover:bg-board"
      >
        <span lang={target}>{t.lang.switchTo}</span>
      </button>
    </form>
  );
}

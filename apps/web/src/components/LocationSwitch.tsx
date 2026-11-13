import { switchLocation } from '@/app/admin/location-actions';
import type { Dictionary } from '@/i18n/dictionary';
import { getActor, locationsOf } from '@/lib/auth';

/** Shown only to someone who works at more than one location (B14): a small
 *  control with the current location's name; open it and tap another. The
 *  current location is named in the header as well. */
export async function LocationSwitch({ t }: { t: Dictionary['nav'] }) {
  const actor = await getActor();
  const places = actor ? locationsOf(actor) : [];
  if (places.length < 2) return null;
  const [here, ...others] = places;
  return (
    <details className="relative">
      <summary
        aria-label={`${t.location}: ${here!.name}`}
        className="flex min-h-11 cursor-pointer list-none items-center rounded-control border-2 border-slate/30 px-3 text-small font-semibold"
      >
        {t.location}
      </summary>
      <div className="absolute right-0 z-20 mt-1 flex min-w-48 flex-col gap-1 rounded-control border-2 border-slate/30 bg-board p-2">
        {others.map((p) => (
          <form key={p.id} action={switchLocation}>
            <input type="hidden" name="locationId" value={p.id} />
            <button
              type="submit"
              className="min-h-11 w-full rounded-control px-3 text-left font-semibold hover:bg-pumice"
            >
              {p.name}
            </button>
          </form>
        ))}
      </div>
    </details>
  );
}

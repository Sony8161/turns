import { switchLocation } from '@/app/admin/location-actions';
import type { Dictionary } from '@/i18n/dictionary';
import { getActor, locationsOf } from '@/lib/auth';

/** Shown only to someone who works at more than one location. The current
 *  location is named in every page's heading as well. */
export async function LocationSwitch({ t }: { t: Dictionary['nav'] }) {
  const actor = await getActor();
  const places = actor ? locationsOf(actor) : [];
  if (places.length < 2) return null;
  return (
    <form action={switchLocation} className="ml-auto flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2">
        <span className="text-small font-medium">{t.location}</span>
        <select
          name="locationId"
          defaultValue={places[0]!.id}
          className="min-h-11 rounded-control border-2 border-slate/30 bg-board px-3"
        >
          {places.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="min-h-11 rounded-control border-2 border-slate px-4 font-semibold text-slate hover:bg-board"
      >
        {t.switchLocation}
      </button>
    </form>
  );
}

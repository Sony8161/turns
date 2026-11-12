// The kiosk form to the check-in input. Pure: no database, no server. Only
// what the engine needs, in plain choices; nothing free-text but the first
// name, the phone and the optional design or special request (threat model T12).
import type { ClientGender } from '@turn/db/clients';
import { isUuid } from '@/lib/ids';

export const KIOSK_MAX_SERVICES = 6;

export type KioskForm =
  | {
      ok: true;
      name: string;
      /** v0.13.0: optional. */
      lastName: string | null;
      phone: string | null;
      serviceIds: string[];
      requestedTechnicianId: string | null;
      attributes: { gender: ClientGender | null; isKid: boolean; age: number | null };
      sameTime: boolean;
      note: string | null;
    }
  | { ok: false; reason: 'no_services' | 'unknown_service' | 'unknown_technician' | 'bad_age' };

export function kioskFromForm(fd: FormData): KioskForm {
  const ids = [...new Set(fd.getAll('service').map(String).filter(Boolean))];
  if (ids.length === 0) return { ok: false, reason: 'no_services' };
  if (ids.length > KIOSK_MAX_SERVICES || !ids.every(isUuid)) {
    return { ok: false, reason: 'unknown_service' };
  }
  const tech = String(fd.get('requestedTechnician') ?? '').trim();
  if (tech && !isUuid(tech)) return { ok: false, reason: 'unknown_technician' };
  const who = String(fd.get('who') ?? 'adult');
  const isKid = who === 'kid';
  const ageText = String(fd.get('age') ?? '').trim();
  let age: number | null = null;
  if (isKid && ageText !== '') {
    if (!/^\d{1,2}$/.test(ageText)) return { ok: false, reason: 'bad_age' };
    age = Number(ageText);
  }
  const gender = String(fd.get('gender') ?? '');
  return {
    ok: true,
    name: String(fd.get('name') ?? '').slice(0, 200),
    lastName:
      String(fd.get('lastName') ?? '')
        .trim()
        .slice(0, 200) || null,
    phone:
      String(fd.get('phone') ?? '')
        .trim()
        .slice(0, 32) || null,
    serviceIds: ids,
    requestedTechnicianId: tech || null,
    attributes: {
      gender: gender === 'female' || gender === 'male' ? gender : null,
      isKid,
      age,
    },
    sameTime: ids.length >= 2 && (fd.get('sameTime') === 'on' || fd.get('sameTime') === 'true'),
    // Cleaned again in the database layer (cleanKioskNote): one line, 200 max.
    note:
      String(fd.get('note') ?? '')
        .trim()
        .slice(0, 400) || null,
  };
}

export type KioskTech = { id: string; name: string; serviceIds: string[] | null };

/**
 * v0.15.0: the technicians the kiosk offers for the chosen services: those on
 * shift (the server sends only them) who do every one. The same rule as
 * techniciansFor in the database package, which the check-in enforces; it is
 * repeated here because the browser must not load that package.
 */
export function techsFor(technicians: KioskTech[], serviceIds: string[]): KioskTech[] {
  if (serviceIds.length === 0) return [];
  return technicians.filter(
    (t) => t.serviceIds === null || serviceIds.every((id) => t.serviceIds!.includes(id)),
  );
}

/** v0.16.0: the most people one group check-in carries from the form; the
 *  rules may allow fewer (the server checks). */
export const KIOSK_GROUP_MAX = 8;

export type KioskGroupForm =
  | {
      ok: true;
      phone: string | null;
      people: {
        name: string;
        lastName: string | null;
        serviceIds: string[];
        requestedTechnicianId: string | null;
        note: string | null;
      }[];
    }
  | {
      ok: false;
      reason:
        'no_services' | 'unknown_service' | 'unknown_technician' | 'bad_name' | 'party_too_big';
    };

/**
 * v0.16.0: the kiosk's group check-in. The screen sends the people as one JSON
 * field (built on the iPad, one person at a time) and the group's phone as its
 * own field. Shapes only: names, services and technicians are checked again
 * on the server against the menu and who is in today.
 */
export function kioskGroupFromForm(fd: FormData): KioskGroupForm {
  let raw: unknown;
  try {
    raw = JSON.parse(String(fd.get('people') ?? '[]').slice(0, 20_000));
  } catch {
    return { ok: false, reason: 'bad_name' };
  }
  if (!Array.isArray(raw)) return { ok: false, reason: 'bad_name' };
  if (raw.length > KIOSK_GROUP_MAX) return { ok: false, reason: 'party_too_big' };
  const people: Extract<KioskGroupForm, { ok: true }>['people'] = [];
  for (const p of raw) {
    if (typeof p !== 'object' || p === null) return { ok: false, reason: 'bad_name' };
    const r = p as Record<string, unknown>;
    const name = typeof r['name'] === 'string' ? r['name'].slice(0, 200) : '';
    if (!name.trim()) return { ok: false, reason: 'bad_name' };
    const ids = Array.isArray(r['serviceIds'])
      ? [...new Set(r['serviceIds'].filter((x): x is string => typeof x === 'string'))]
      : [];
    if (ids.length === 0) return { ok: false, reason: 'no_services' };
    if (ids.length > KIOSK_MAX_SERVICES || !ids.every(isUuid)) {
      return { ok: false, reason: 'unknown_service' };
    }
    const tech = typeof r['requestedTechnicianId'] === 'string' ? r['requestedTechnicianId'] : '';
    if (tech && !isUuid(tech)) return { ok: false, reason: 'unknown_technician' };
    const lastName = typeof r['lastName'] === 'string' ? r['lastName'].trim().slice(0, 200) : '';
    const note = typeof r['note'] === 'string' ? r['note'].trim().slice(0, 400) : '';
    people.push({
      name,
      lastName: lastName || null,
      serviceIds: ids,
      requestedTechnicianId: tech || null,
      note: note || null,
    });
  }
  return {
    ok: true,
    phone:
      String(fd.get('phone') ?? '')
        .trim()
        .slice(0, 32) || null,
    people,
  };
}

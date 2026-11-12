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

// The walk-in form to the engine's input. Pure: no database, no server. The
// desk asks only what the technician rules need (Duong, 2026-11-04); nothing
// here reaches a technician's phone.
import type { ClientGender } from '@turn/db/clients';

export type WalkInForm = {
  serviceIds: string[];
  requestedTechnicianId: string | null;
  note: string;
  /** v0.13.0: first and last name when the desk typed them separately, else a full name. */
  client:
    | { name: string | null; phone: string | null }
    | { firstName: string | null; lastName: string | null; phone: string | null };
  attributes: { gender: ClientGender | null; isKid: boolean; age: number | null };
  sameTime: boolean;
};

function text(raw: FormDataEntryValue | null, max: number): string | null {
  const s = String(raw ?? '').trim();
  return s ? s.slice(0, max) : null;
}

/** Builds the engine input from the form. Unknown values stay as typed where
 *  the engine checks them (age), and fall to "not asked" elsewhere. */
export function walkInFromForm(fd: FormData): WalkInForm {
  const gender = String(fd.get('gender') ?? '');
  const ageText = String(fd.get('age') ?? '').trim();
  const age = ageText === '' ? null : /^\d{1,3}$/.test(ageText) ? Number(ageText) : Number.NaN;
  return {
    serviceIds: fd.getAll('service').map(String).filter(Boolean),
    requestedTechnicianId: text(fd.get('requestedTechnician'), 64),
    note: String(fd.get('note') ?? ''),
    client:
      fd.has('clientFirstName') || fd.has('clientLastName')
        ? {
            firstName: text(fd.get('clientFirstName'), 60),
            lastName: text(fd.get('clientLastName'), 60),
            phone: text(fd.get('clientPhone'), 32),
          }
        : { name: text(fd.get('clientName'), 120), phone: text(fd.get('clientPhone'), 32) },
    attributes: {
      gender: gender === 'female' || gender === 'male' ? gender : null,
      isKid: fd.get('kid') === 'on' || fd.get('kid') === 'true',
      age,
    },
    sameTime: fd.get('sameTime') === 'on' || fd.get('sameTime') === 'true',
  };
}

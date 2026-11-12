// v0.16.0 (Duong, 2026-11-12): people who come in together. The kiosk and the
// desk add them one at a time (first name, optional last name, their own
// services, technician choice and request note), up to the rules'
// groups.max_people (Heavenly 8), then one submit. Every person is their own
// client and their own visit, linked by a party id (not the same-time group
// id, which links one client's visits). Each visit is called by turn on its
// own. Server only.
import { randomUUID } from 'node:crypto';
import type { ClientInput } from './clients';
import { createWalkIn, type ClientAttributes, type EngineError } from './engine';
import { activeRules } from './rules';
import type { Db } from './server';
import type { Actor } from './status';

export type PartyPerson = {
  firstName: string;
  lastName?: string | null;
  /** The desk may take a phone per person; the kiosk takes one for the group. */
  phone?: string | null;
  serviceIds: string[];
  requestedTechnicianId?: string | null;
  note?: string | null;
  attributes?: ClientAttributes | null;
};

class PartyRollback extends Error {
  constructor(
    readonly result: EngineError,
    readonly person: number,
  ) {
    super(result.reason);
  }
}

/**
 * The desk enters a group: one visit per person, in one transaction (all or
 * nothing), linked by a new party id. A person with no first name is refused.
 */
export async function createParty(
  db: Db,
  input: {
    organizationId: string;
    locationId: string;
    actor: Actor;
    people: PartyPerson[];
  },
): Promise<
  { ok: true; partyId: string; visitIds: string[] } | (EngineError & { person?: number })
> {
  const rules = await activeRules(db, input.locationId);
  if (input.people.length < 2) return { ok: false, reason: 'party_too_small' };
  if (input.people.length > rules.groups.max_people) {
    return { ok: false, reason: 'party_too_big' };
  }
  const blank = input.people.findIndex((p) => !p.firstName?.trim());
  if (blank >= 0) return { ok: false, reason: 'bad_name', person: blank };
  const partyId = randomUUID();
  try {
    const visitIds = await db.transaction(async (tx) => {
      const ids: string[] = [];
      for (const [i, p] of input.people.entries()) {
        const client: ClientInput = {
          firstName: p.firstName,
          lastName: p.lastName ?? null,
          phone: p.phone ?? null,
        };
        const r = await createWalkIn(tx as unknown as Db, {
          organizationId: input.organizationId,
          locationId: input.locationId,
          serviceIds: p.serviceIds,
          actor: input.actor,
          requestedTechnicianId: p.requestedTechnicianId ?? null,
          note: p.note ?? null,
          client,
          attributes: p.attributes ?? null,
          partyId,
        });
        if (!r.ok) throw new PartyRollback(r, i);
        ids.push(...r.visitIds);
      }
      return ids;
    });
    return { ok: true, partyId, visitIds };
  } catch (e) {
    if (e instanceof PartyRollback) return { ...e.result, person: e.person };
    throw e;
  }
}

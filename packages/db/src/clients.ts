// Clients (Part 6). Minimal on purpose: Fresha stays the client system
// (design doc). The phone, in E.164, is the match key so a later import of
// Fresha's client list lands on the same rows (Duong, 2026-11-04). Server only.
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Role } from './invites';
import { can } from './permissions';
import { consumeRateLimit } from './rate-limit';
import { appointments, clients, services, technicians, visitServices, visits } from './schema';
import type { Db } from './server';
import { writeAudit } from './status';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type ClientGender = 'female' | 'male' | 'unspecified';

// North American numbering plan: area code and exchange start with 2 to 9.
const NANP = /^[2-9]\d{2}[2-9]\d{6}$/;

/** A US phone number as E.164 (+1 and ten digits), or null when it is not one. */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return NANP.test(digits) ? `+1${digits}` : null;
}

export type ClientInput = {
  /** A full name; split into first and last at the first space when the two
   *  are not given separately. */
  name?: string | null;
  /** v0.13.0: first and last name, as Fresha keeps them. */
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  gender?: ClientGender | null;
};

const NAME_MAX = 60;
const clean = (v: string | null | undefined, max = NAME_MAX) =>
  v
    ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim() || null;

/** First and last name from the input: given separately, or split from a full
 *  name at the first space ("Lan Nguyen" -> Lan, Nguyen). */
export function nameParts(input: Pick<ClientInput, 'name' | 'firstName' | 'lastName'>): {
  firstName: string | null;
  lastName: string | null;
} {
  if (input.firstName !== undefined || input.lastName !== undefined) {
    return { firstName: clean(input.firstName), lastName: clean(input.lastName) };
  }
  const full = clean(input.name, 120);
  if (!full) return { firstName: null, lastName: null };
  const at = full.indexOf(' ');
  return at < 0
    ? { firstName: full.slice(0, NAME_MAX), lastName: null }
    : { firstName: clean(full.slice(0, at)), lastName: clean(full.slice(at + 1)) };
}

/** "First Last", or null. */
export function fullName(firstName: string | null, lastName: string | null): string | null {
  return [firstName, lastName].filter(Boolean).join(' ') || null;
}

/** "First L." for boards and lists other customers may see (Duong, 2026-11-12). */
export function shortName(firstName: string | null, lastName: string | null): string | null {
  if (!firstName) return lastName ? `${lastName.slice(0, 1).toUpperCase()}.` : null;
  return lastName ? `${firstName} ${Array.from(lastName)[0]!.toUpperCase()}.` : firstName;
}

/** Lower case, accents removed, đ as d: what search compares ("ngoc" finds "Ngọc").
 *  The migration backfills old rows the same way (0024). */
export function searchKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function searchNameOf(firstName: string | null, lastName: string | null): string | null {
  const full = fullName(firstName, lastName);
  return full ? searchKey(full) : null;
}

/**
 * The client row for a walk-in, when the desk typed a name or a phone. A phone
 * finds the existing row at this location and fills in a name or gender that
 * was blank (what is stored is never overwritten from the desk: that would be
 * an unaudited edit); a name alone makes a new row. Nothing typed: no row.
 * Returns the id, or null when there is nothing to keep. Anonymisation (the
 * retention job, Part 10) must null the phone, since the unique index is on it.
 */
export async function upsertClient(
  tx: Tx,
  input: {
    organizationId: string;
    locationId: string;
    /** false: a known phone is only linked, never filled in (kiosk input, v0.9.1). */
    fillBlanks?: boolean;
  } & ClientInput,
): Promise<{ ok: true; clientId: string | null } | { ok: false; reason: 'bad_phone' }> {
  const { firstName, lastName } = nameParts(input);
  const name = fullName(firstName, lastName);
  const rawPhone = input.phone?.trim() ?? '';
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (rawPhone && !phone) return { ok: false, reason: 'bad_phone' };
  const gender = input.gender ?? null;
  if (!name && !phone) return { ok: true, clientId: null };

  const now = new Date();
  if (phone) {
    const [existing] = await tx
      .select({
        id: clients.id,
        name: clients.name,
        firstName: clients.firstName,
        gender: clients.gender,
      })
      .from(clients)
      .where(
        and(
          eq(clients.locationId, input.locationId),
          eq(clients.phone, phone),
          isNull(clients.anonymisedAt),
        ),
      )
      .for('update');
    if (existing && input.fillBlanks === false) return { ok: true, clientId: existing.id };
    if (existing) {
      await tx
        .update(clients)
        .set({
          ...(name && !existing.name && !existing.firstName
            ? { name, firstName, lastName, searchName: searchNameOf(firstName, lastName) }
            : {}),
          ...(gender && !existing.gender ? { gender } : {}),
          updatedAt: now,
        })
        .where(eq(clients.id, existing.id));
      return { ok: true, clientId: existing.id };
    }
  }
  const [row] = await tx
    .insert(clients)
    .values({
      organizationId: input.organizationId,
      locationId: input.locationId,
      name,
      firstName,
      lastName,
      searchName: searchNameOf(firstName, lastName),
      phone,
      gender,
    })
    .onConflictDoNothing()
    .returning({ id: clients.id });
  if (row) return { ok: true, clientId: row.id };
  // Lost a race on the phone index: read the winner.
  const [winner] = await tx
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.locationId, input.locationId),
        eq(clients.phone, phone!),
        isNull(clients.anonymisedAt),
      ),
    );
  return { ok: true, clientId: winner?.id ?? null };
}

// Client search and detail (v0.13.0, Duong 2026-11-12) -------------------------
// For the owner, managers and the front desk only (the web checks the role;
// technicians never reach these). Search is by phone, in any format, or by
// name without accents. Fresha stays the client system; its list is imported
// before launch (backlog), landing on the same rows by phone.

export type ClientHit = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  visitCount: number;
  lastVisitAt: Date | null;
};

export const CLIENT_SEARCH_LIMIT = 25;

const likeSafe = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** v0.17.1 (review #4): the shortest search that is not a page through
 *  everyone: 4 digits of a phone, or 3 letters of a name. */
export const CLIENT_QUERY_MIN_DIGITS = 4;
export const CLIENT_QUERY_MIN_LETTERS = 3;

/** What a search box string asks for: digits (4 or more, a phone) or a name (3+ letters). */
export function parseClientQuery(raw: string): { phone: string } | { name: string } | null {
  const q = raw.trim().slice(0, 60);
  const digits = q.replace(/\D/g, '');
  if (/^[\d\s().+-]+$/.test(q) && /\d/.test(q)) {
    if (digits.length < CLIENT_QUERY_MIN_DIGITS) return null;
    return { phone: digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits };
  }
  const name = searchKey(q);
  const letters = name.replace(/[^\p{L}]/gu, '').length;
  return letters >= CLIENT_QUERY_MIN_LETTERS ? { name } : null;
}

export async function searchClients(
  db: Db,
  input: { locationId: string; query: string; limit?: number },
): Promise<ClientHit[]> {
  const parsed = parseClientQuery(input.query);
  if (!parsed) return [];
  const match =
    'phone' in parsed
      ? sql`${clients.phone} like ${`%${likeSafe(parsed.phone)}%`}`
      : sql`(${clients.searchName} like ${`${likeSafe(parsed.name)}%`} or ${clients.searchName} like ${`% ${likeSafe(parsed.name)}%`})`;
  const lastVisit = sql<Date | null>`(select max(v.arrived_at) from ${visits} v where v.client_id = ${clients.id} and v.status <> 'cancelled')`;
  const rows = await db
    .select({
      id: clients.id,
      firstName: clients.firstName,
      lastName: clients.lastName,
      name: clients.name,
      phone: clients.phone,
      visitCount: sql<number>`(select count(*) from ${visits} v where v.client_id = ${clients.id} and v.status = 'completed')`,
      lastVisitAt: lastVisit,
    })
    .from(clients)
    .where(and(eq(clients.locationId, input.locationId), isNull(clients.anonymisedAt), match))
    .orderBy(sql`${lastVisit} desc nulls last`, clients.searchName)
    .limit(Math.min(input.limit ?? CLIENT_SEARCH_LIMIT, 50));
  return rows.map((r) => {
    const parts =
      r.firstName || r.lastName
        ? { firstName: r.firstName, lastName: r.lastName }
        : nameParts({ name: r.name });
    return {
      id: r.id,
      ...parts,
      phone: r.phone,
      visitCount: Number(r.visitCount),
      lastVisitAt: r.lastVisitAt ? new Date(r.lastVisitAt) : null,
    };
  });
}

export type ClientDetail = ClientHit & {
  gender: ClientGender | null;
  notes: string | null;
  usualTechnician: string | null;
  recent: { at: Date; services: string[]; technician: string | null; status: string }[];
  /** v0.17.0: booked appointments the desk marked a no-show. */
  noShows: number;
};

/** One client at this location, or null (another location's client is not found). */
export async function clientDetail(
  db: Db,
  locationId: string,
  clientId: string,
): Promise<ClientDetail | null> {
  const [c] = await db
    .select()
    .from(clients)
    .where(
      and(
        eq(clients.id, clientId),
        eq(clients.locationId, locationId),
        isNull(clients.anonymisedAt),
      ),
    );
  if (!c) return null;
  const recent = await db
    .select({
      id: visits.id,
      at: visits.arrivedAt,
      status: visits.status,
      technician: technicians.displayName,
    })
    .from(visits)
    .leftJoin(technicians, eq(technicians.id, visits.assignedTechnicianId))
    .where(and(eq(visits.clientId, c.id), eq(visits.locationId, locationId)))
    .orderBy(desc(visits.arrivedAt))
    .limit(50);
  const items = recent.length
    ? await db
        .select({ visitId: visitServices.visitId, name: services.name })
        .from(visitServices)
        .innerJoin(services, eq(services.id, visitServices.serviceId))
        .where(
          inArray(
            visitServices.visitId,
            recent.slice(0, 10).map((r) => r.id),
          ),
        )
    : [];
  const [ns] = await db
    .select({ n: sql<string>`count(*)` })
    .from(appointments)
    .where(
      and(
        eq(appointments.clientId, c.id),
        eq(appointments.locationId, locationId),
        sql`${appointments.noShowAt} is not null`,
      ),
    );
  const done = recent.filter((r) => r.status === 'completed');
  const tally = new Map<string, number>();
  for (const r of done)
    if (r.technician) tally.set(r.technician, (tally.get(r.technician) ?? 0) + 1);
  const usual = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const parts =
    c.firstName || c.lastName
      ? { firstName: c.firstName, lastName: c.lastName }
      : nameParts({ name: c.name });
  return {
    id: c.id,
    ...parts,
    phone: c.phone,
    gender: c.gender,
    notes: c.notes,
    visitCount: done.length,
    lastVisitAt: recent.find((r) => r.status !== 'cancelled')?.at ?? null,
    usualTechnician: usual,
    recent: recent.slice(0, 10).map((r) => ({
      at: r.at,
      status: r.status,
      technician: r.technician,
      services: items.filter((i) => i.visitId === r.id).map((i) => i.name),
    })),
    noShows: Number(ns?.n ?? 0),
  };
}

// v0.17.1 (review #4): one budget per person for everything that shows a
// client: a search, a client's page, the fix lookup and "Show" on a phone.
// The same key the search used since v0.13.0, so nothing resets on upgrade.

export const CLIENT_LOOKUPS = { limit: 60, windowS: 5 * 60 } as const;

/** Someone at the desk (the role and location come from their membership). */
export type ClientViewer = {
  userId: string;
  role: Role;
  organizationId: string;
  locationId: string;
};

const DESK_ROLES: readonly Role[] = ['owner', 'manager', 'receptionist'];

/** One lookup against the person's budget; false once it is spent. */
export async function consumeClientLookup(db: Db, userId: string): Promise<boolean> {
  const r = await consumeRateLimit(
    db,
    `client-search:${userId}`,
    CLIENT_LOOKUPS.limit,
    CLIENT_LOOKUPS.windowS,
  );
  return r.allowed;
}

/** "(•••) •••-0199": the last four digits only. */
export function maskPhone(phone: string): string {
  return `(•••) •••-${phone.slice(-4)}`;
}

/** Search for the desk. Too short costs nothing; every search counts. The
 *  list never shows a whole phone, whoever is looking. */
export async function findClients(
  db: Db,
  input: { viewer: ClientViewer; query: string },
): Promise<
  { ok: true; hits: ClientHit[] } | { ok: false; reason: 'not_allowed' | 'too_short' | 'too_many' }
> {
  if (!DESK_ROLES.includes(input.viewer.role)) return { ok: false, reason: 'not_allowed' };
  if (!parseClientQuery(input.query)) return { ok: false, reason: 'too_short' };
  if (!(await consumeClientLookup(db, input.viewer.userId))) {
    return { ok: false, reason: 'too_many' };
  }
  const hits = await searchClients(db, {
    locationId: input.viewer.locationId,
    query: input.query,
  });
  return {
    ok: true,
    hits: hits.map((h) => ({ ...h, phone: h.phone ? maskPhone(h.phone) : null })),
  };
}

/** A client's page: counted like a search. Owners and managers see the full
 *  phone; everyone else the last four digits, with "Show". */
export async function viewClient(
  db: Db,
  input: { viewer: ClientViewer; clientId: string },
): Promise<
  | { ok: true; client: ClientDetail & { phoneMasked: boolean } }
  | { ok: false; reason: 'not_allowed' | 'too_many' | 'unknown_client' }
> {
  if (!DESK_ROLES.includes(input.viewer.role)) return { ok: false, reason: 'not_allowed' };
  if (!(await consumeClientLookup(db, input.viewer.userId))) {
    return { ok: false, reason: 'too_many' };
  }
  const c = await clientDetail(db, input.viewer.locationId, input.clientId);
  if (!c) return { ok: false, reason: 'unknown_client' };
  const full = can(input.viewer.role, 'see_client_phone');
  return {
    ok: true,
    client: {
      ...c,
      phone: c.phone && !full ? maskPhone(c.phone) : c.phone,
      phoneMasked: !!c.phone && !full,
    },
  };
}

/** "Show" on a masked phone: counted like a search and audited, never with
 *  the number (threat model T11). */
export async function revealClientPhone(
  db: Db,
  input: { viewer: ClientViewer; clientId: string },
): Promise<
  | { ok: true; phone: string | null }
  | { ok: false; reason: 'not_allowed' | 'too_many' | 'unknown_client' }
> {
  if (!DESK_ROLES.includes(input.viewer.role)) return { ok: false, reason: 'not_allowed' };
  if (!(await consumeClientLookup(db, input.viewer.userId))) {
    return { ok: false, reason: 'too_many' };
  }
  return db.transaction(async (tx) => {
    const [c] = await tx
      .select({ id: clients.id, phone: clients.phone })
      .from(clients)
      .where(
        and(
          eq(clients.id, input.clientId),
          eq(clients.locationId, input.viewer.locationId),
          eq(clients.organizationId, input.viewer.organizationId),
          isNull(clients.anonymisedAt),
        ),
      );
    if (!c) return { ok: false as const, reason: 'unknown_client' as const };
    await writeAudit(tx, {
      organizationId: input.viewer.organizationId,
      locationId: input.viewer.locationId,
      actorUserId: input.viewer.userId,
      entityType: 'clients',
      entityId: c.id,
      action: 'client_phone_shown',
      after: { by: input.viewer.role },
    });
    return { ok: true as const, phone: c.phone };
  });
}

export const CLIENT_NOTES_MAX = 500;

/** The desk edits a client's first and last name and notes. The audit row says
 *  which fields changed, never their values (threat model T11). */
export async function updateClient(
  db: Db,
  input: {
    actor: { userId: string | null; organizationId: string; locationId: string };
    clientId: string;
    firstName: string | null;
    lastName: string | null;
    notes: string | null;
  },
): Promise<{ ok: true } | { ok: false; reason: 'unknown_client' | 'name_required' }> {
  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);
  if (!firstName && !lastName) return { ok: false, reason: 'name_required' };
  const notes =
    input.notes
      ?.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, CLIENT_NOTES_MAX) || null;
  return db.transaction(async (tx) => {
    const [c] = await tx
      .select()
      .from(clients)
      .where(
        and(
          eq(clients.id, input.clientId),
          eq(clients.locationId, input.actor.locationId),
          eq(clients.organizationId, input.actor.organizationId),
          isNull(clients.anonymisedAt),
        ),
      )
      .for('update');
    if (!c) return { ok: false as const, reason: 'unknown_client' as const };
    const changed = [
      ...(c.firstName !== firstName ? ['firstName'] : []),
      ...(c.lastName !== lastName ? ['lastName'] : []),
      ...(c.notes !== notes ? ['notes'] : []),
    ];
    if (changed.length === 0) return { ok: true as const };
    await tx
      .update(clients)
      .set({
        firstName,
        lastName,
        name: fullName(firstName, lastName),
        searchName: searchNameOf(firstName, lastName),
        notes,
        updatedAt: new Date(),
      })
      .where(eq(clients.id, c.id));
    await writeAudit(tx, {
      organizationId: c.organizationId,
      locationId: c.locationId,
      actorUserId: input.actor.userId,
      entityType: 'clients',
      entityId: c.id,
      action: 'client_updated',
      after: { changed },
    });
    return { ok: true as const };
  });
}

export type VisitLabel = { client: string | null; services: string[] };

/**
 * "First L." and the services of each visit, for the audit viewer (v0.16.1),
 * which shows a visit as people know it instead of its id. Owners and managers
 * already see the same on the board; the CSV export never asks for this, so no
 * client name leaves the app through the log. Only visits at this location.
 */
export async function visitLabels(
  db: Db,
  locationId: string,
  visitIds: string[],
): Promise<Map<string, VisitLabel>> {
  const out = new Map<string, VisitLabel>();
  const ids = [...new Set(visitIds)];
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: visits.id,
      firstName: clients.firstName,
      lastName: clients.lastName,
      kioskName: visits.kioskName,
      kioskLastName: visits.kioskLastName,
      service: services.name,
    })
    .from(visits)
    .leftJoin(clients, eq(clients.id, visits.clientId))
    .leftJoin(visitServices, eq(visitServices.visitId, visits.id))
    .leftJoin(services, eq(services.id, visitServices.serviceId))
    .where(and(inArray(visits.id, ids), eq(visits.locationId, locationId)))
    .orderBy(visits.id, visitServices.createdAt);
  for (const r of rows) {
    let label = out.get(r.id);
    if (!label) {
      label = {
        client: shortName(r.firstName, r.lastName) ?? shortName(r.kioskName, r.kioskLastName),
        services: [],
      };
      out.set(r.id, label);
    }
    if (r.service && !label.services.includes(r.service)) label.services.push(r.service);
  }
  return out;
}

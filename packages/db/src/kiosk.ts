// Customer self check-in on a salon iPad (Part 9; design doc, Customer self
// check-in; threat model T7, T12, T20, T25). Server only: runs with the
// service connection, so the web callers check the staff role (pairing,
// revoking, confirming) or the device token (check-in) before calling.
//
// What a kiosk can do: create a waiting visit at its own location, which the
// desk confirms before anyone is called. Nothing else. It never reads a
// client, a visit or the board, and its answer is the same whether or not the
// phone typed is already on file (no enumeration).
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { upsertClient } from './clients';
import { createWalkIn, floorAttention, type ClientAttributes, type ManagerActor } from './engine';
import { generateCode, hashCode } from './invites';
import { loadLevels } from './levels';
import { doesEverything, loadProfiles } from './profile';
import { activeRules } from './rules';
import {
  kioskDevices,
  serviceCategories,
  services,
  technicianStatus,
  technicians,
  visits,
} from './schema';
import type { Db } from './server';
import { writeAudit } from './status';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const PAIRING_TTL_MIN = 15;
/** The right PIN opens the staff sign-in on this iPad for this long. */
export const UNLOCK_TTL_MIN = 2;
/** A token nobody has used for this long stops working (re-pair the iPad). */
export const TOKEN_IDLE_DAYS = 90;
export const KIOSK_NAME_MAX = 40;
const DEVICE_NAME_MAX = 60;
// lastSeenAt is a hint for the admin list; writing it on every tap is noise.
const SEEN_EVERY_MS = 60_000;
// Control, zero-width and direction-override characters: nothing a name needs.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

export type KioskDevice = {
  deviceId: string;
  organizationId: string;
  locationId: string;
  name: string;
};

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Exactly four digits. */
export function validPin(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function pinMatches(pin: string, stored: string): Promise<boolean> {
  const [kind, saltHex, hashHex] = stored.split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const got = await scrypt(pin, Buffer.from(saltHex, 'hex'), expected.length);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * The customer's first name as the desk will see it: control characters
 * removed, spaces collapsed, at most KIOSK_NAME_MAX characters. null when
 * nothing printable is left. Pure.
 */
export function cleanKioskName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(UNSAFE_CHARS, '');
  const name = s.replace(/\s+/g, ' ').trim().slice(0, KIOSK_NAME_MAX).trim();
  return name || null;
}

export const KIOSK_NOTE_MAX = 200;

/** The design or special request typed on the kiosk: one line, no control
 *  characters, at most 200 characters. Empty means none. */
export function cleanKioskNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(UNSAFE_CHARS, ' ');
  const note = s.replace(/\s+/g, ' ').trim().slice(0, KIOSK_NOTE_MAX).trim();
  return note || null;
}

// Staff side ----------------------------------------------------------------

/** An owner or manager registers an iPad at their own location. The pairing
 *  code is shown once; only its hash is kept. */
export async function createKioskDevice(
  db: Db,
  input: {
    actor: ManagerActor;
    name: string;
    pin: string;
    now?: Date;
    /** The development seed only: a code that lasts the day. */
    ttlMinutes?: number;
  },
): Promise<
  | { ok: true; deviceId: string; pairingCode: string; expiresAt: Date }
  | { ok: false; reason: 'bad_name' | 'bad_pin' }
> {
  const name = input.name.replace(/\s+/g, ' ').trim().slice(0, DEVICE_NAME_MAX);
  if (!name) return { ok: false, reason: 'bad_name' };
  if (!validPin(input.pin)) return { ok: false, reason: 'bad_pin' };
  const now = input.now ?? new Date();
  const code = generateCode();
  const expiresAt = new Date(now.getTime() + (input.ttlMinutes ?? PAIRING_TTL_MIN) * 60_000);
  const pinHash = await hashPin(input.pin);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(kioskDevices)
      .values({
        organizationId: input.actor.organizationId,
        locationId: input.actor.locationId,
        name,
        pinHash,
        pairingCodeHash: hashCode(code),
        pairingExpiresAt: expiresAt,
        createdBy: input.actor.userId,
      })
      .returning({ id: kioskDevices.id });
    if (!row) throw new Error('kiosk insert returned nothing');
    await writeAudit(tx, {
      organizationId: input.actor.organizationId,
      locationId: input.actor.locationId,
      actorUserId: input.actor.userId,
      entityType: 'kiosk_devices',
      entityId: row.id,
      action: 'kiosk_created',
      after: { name },
    });
    return { ok: true as const, deviceId: row.id, pairingCode: code, expiresAt };
  });
}

/** A new pairing code for a device that is not revoked (a new iPad, or the
 *  cookie was cleared). The old token keeps working until the code is used. */
export async function newPairingCode(
  db: Db,
  input: { actor: ManagerActor; deviceId: string; now?: Date },
): Promise<
  { ok: true; pairingCode: string; expiresAt: Date } | { ok: false; reason: 'unknown_device' }
> {
  const now = input.now ?? new Date();
  const code = generateCode();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MIN * 60_000);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(kioskDevices)
      .set({ pairingCodeHash: hashCode(code), pairingExpiresAt: expiresAt })
      .where(
        and(
          eq(kioskDevices.id, input.deviceId),
          eq(kioskDevices.locationId, input.actor.locationId),
          eq(kioskDevices.organizationId, input.actor.organizationId),
          isNull(kioskDevices.revokedAt),
        ),
      )
      .returning({ id: kioskDevices.id });
    if (!row) return { ok: false as const, reason: 'unknown_device' as const };
    await writeAudit(tx, {
      organizationId: input.actor.organizationId,
      locationId: input.actor.locationId,
      actorUserId: input.actor.userId,
      entityType: 'kiosk_devices',
      entityId: row.id,
      action: 'kiosk_pairing_code',
    });
    return { ok: true as const, pairingCode: code, expiresAt };
  });
}

/** Revoked at once: the token stops working on the next request (T25). */
export async function revokeKiosk(
  db: Db,
  input: { actor: ManagerActor; deviceId: string; now?: Date },
): Promise<{ ok: true } | { ok: false; reason: 'unknown_device' }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(kioskDevices)
      .set({
        revokedAt: now,
        revokedBy: input.actor.userId,
        tokenHash: null,
        pairingCodeHash: null,
        pairingExpiresAt: null,
      })
      .where(
        and(
          eq(kioskDevices.id, input.deviceId),
          eq(kioskDevices.locationId, input.actor.locationId),
          eq(kioskDevices.organizationId, input.actor.organizationId),
          isNull(kioskDevices.revokedAt),
        ),
      )
      .returning({ id: kioskDevices.id, name: kioskDevices.name });
    if (!row) return { ok: false as const, reason: 'unknown_device' as const };
    await writeAudit(tx, {
      organizationId: input.actor.organizationId,
      locationId: input.actor.locationId,
      actorUserId: input.actor.userId,
      entityType: 'kiosk_devices',
      entityId: row.id,
      action: 'kiosk_revoked',
      before: { name: row.name },
    });
    return { ok: true as const };
  });
}

export type KioskListRow = {
  id: string;
  name: string;
  paired: boolean;
  pairingOpen: boolean;
  createdAt: Date;
  pairedAt: Date | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
};

/** The admin list: names and dates, never a hash. */
export async function listKiosks(
  db: Db,
  locationId: string,
  now: Date = new Date(),
): Promise<KioskListRow[]> {
  const rows = await db
    .select({
      id: kioskDevices.id,
      name: kioskDevices.name,
      tokenHash: kioskDevices.tokenHash,
      pairingExpiresAt: kioskDevices.pairingExpiresAt,
      createdAt: kioskDevices.createdAt,
      pairedAt: kioskDevices.pairedAt,
      lastSeenAt: kioskDevices.lastSeenAt,
      revokedAt: kioskDevices.revokedAt,
    })
    .from(kioskDevices)
    .where(eq(kioskDevices.locationId, locationId))
    // Working iPads first, newest first; revoked ones below.
    .orderBy(sql`${kioskDevices.revokedAt} is not null`, desc(kioskDevices.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    paired: r.tokenHash !== null,
    pairingOpen: r.revokedAt === null && !!r.pairingExpiresAt && r.pairingExpiresAt > now,
    createdAt: r.createdAt,
    pairedAt: r.pairedAt,
    lastSeenAt: r.lastSeenAt,
    revokedAt: r.revokedAt,
  }));
}

// Device side ---------------------------------------------------------------

/** The iPad redeems the one-time code and gets its token. Only the token's
 *  hash is stored; the caller puts the token in an httpOnly cookie. */
export async function pairKiosk(
  db: Db,
  input: { code: string; now?: Date },
): Promise<{ ok: true; token: string; device: KioskDevice } | { ok: false; reason: 'bad_code' }> {
  const now = input.now ?? new Date();
  if (typeof input.code !== 'string' || input.code.length > 40) {
    return { ok: false, reason: 'bad_code' };
  }
  const token = randomBytes(32).toString('base64url');
  return db.transaction(async (tx) => {
    // One statement: two iPads typing the same code cannot both win.
    const [row] = await tx
      .update(kioskDevices)
      .set({
        tokenHash: hashToken(token),
        pairingCodeHash: null,
        pairingExpiresAt: null,
        pairedAt: now,
        lastSeenAt: now,
      })
      .where(
        and(
          eq(kioskDevices.pairingCodeHash, hashCode(input.code)),
          gt(kioskDevices.pairingExpiresAt, now),
          isNull(kioskDevices.revokedAt),
        ),
      )
      .returning({
        id: kioskDevices.id,
        organizationId: kioskDevices.organizationId,
        locationId: kioskDevices.locationId,
        name: kioskDevices.name,
      });
    if (!row) {
      // A code that once belonged to a device (expired): audited there. A code
      // that matches nothing has no salon to log it under; the caller's per
      // address limit covers guessing (v0.9.1, review finding 7).
      const [known] = await tx
        .select({
          id: kioskDevices.id,
          organizationId: kioskDevices.organizationId,
          locationId: kioskDevices.locationId,
          revokedAt: kioskDevices.revokedAt,
        })
        .from(kioskDevices)
        .where(eq(kioskDevices.pairingCodeHash, hashCode(input.code)));
      if (known) {
        await writeAudit(tx, {
          organizationId: known.organizationId,
          locationId: known.locationId,
          actorUserId: null,
          entityType: 'kiosk_devices',
          entityId: known.id,
          action: 'kiosk_pair_failed',
          after: { why: known.revokedAt ? 'revoked' : 'expired' },
        });
      }
      return { ok: false as const, reason: 'bad_code' as const };
    }
    await writeAudit(tx, {
      organizationId: row.organizationId,
      locationId: row.locationId,
      actorUserId: null,
      entityType: 'kiosk_devices',
      entityId: row.id,
      action: 'kiosk_paired',
    });
    return {
      ok: true as const,
      token,
      device: {
        deviceId: row.id,
        organizationId: row.organizationId,
        locationId: row.locationId,
        name: row.name,
      },
    };
  });
}

/** The device behind a token, or null when it is unknown or revoked. */
export async function kioskFromToken(
  db: Db,
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<KioskDevice | null> {
  if (!token || token.length > 100) return null;
  const [row] = await db
    .select({
      deviceId: kioskDevices.id,
      organizationId: kioskDevices.organizationId,
      locationId: kioskDevices.locationId,
      name: kioskDevices.name,
    })
    .from(kioskDevices)
    .where(
      and(
        eq(kioskDevices.tokenHash, hashToken(token)),
        isNull(kioskDevices.revokedAt),
        // Not used for TOKEN_IDLE_DAYS: the iPad must be paired again (finding 7).
        sql`coalesce(${kioskDevices.lastSeenAt}, ${kioskDevices.pairedAt}, ${kioskDevices.createdAt}) > ${new Date(now.getTime() - TOKEN_IDLE_DAYS * 86_400_000).toISOString()}::timestamptz`,
      ),
    );
  if (!row) return null;
  await db
    .update(kioskDevices)
    .set({ lastSeenAt: now })
    .where(
      and(
        eq(kioskDevices.id, row.deviceId),
        or(
          isNull(kioskDevices.lastSeenAt),
          lt(kioskDevices.lastSeenAt, new Date(now.getTime() - SEEN_EVERY_MS)),
        ),
      ),
    );
  return row;
}

/** The PIN that unlocks the iPad into the staff sign-in. Every try is audited;
 *  the caller rate-limits per device. */
export async function checkKioskPin(db: Db, device: KioskDevice, pin: unknown): Promise<boolean> {
  const [row] = await db
    .select({ pinHash: kioskDevices.pinHash })
    .from(kioskDevices)
    .where(and(eq(kioskDevices.id, device.deviceId), isNull(kioskDevices.revokedAt)));
  const ok = !!row && validPin(pin) && (await pinMatches(pin, row.pinHash));
  await db.transaction((tx) =>
    writeAudit(tx, {
      organizationId: device.organizationId,
      locationId: device.locationId,
      actorUserId: null,
      entityType: 'kiosk_devices',
      entityId: device.deviceId,
      action: ok ? 'kiosk_unlocked' : 'kiosk_pin_failed',
    }),
  );
  return ok;
}

/**
 * After the right PIN: a random token for a short-lived cookie that lets this
 * iPad reach the staff sign-in (v0.9.1, review finding 4). Only its hash is
 * stored; a new unlock replaces the old one.
 */
export async function openKioskUnlock(
  db: Db,
  device: KioskDevice,
  now: Date = new Date(),
  minutes: number = UNLOCK_TTL_MIN,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + minutes * 60_000);
  await db
    .update(kioskDevices)
    .set({ unlockTokenHash: hashToken(token), unlockExpiresAt: expiresAt, unlockOpenedAt: now })
    .where(and(eq(kioskDevices.id, device.deviceId), isNull(kioskDevices.revokedAt)));
  return { token, expiresAt };
}

/** Is this browser's unlock token the open one for this iPad? */
export async function kioskUnlockOpen(
  db: Db,
  device: KioskDevice,
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  if (!token || token.length > 100) return false;
  const [row] = await db
    .select({ id: kioskDevices.id })
    .from(kioskDevices)
    .where(
      and(
        eq(kioskDevices.id, device.deviceId),
        eq(kioskDevices.unlockTokenHash, hashToken(token)),
        gt(kioskDevices.unlockExpiresAt, now),
        isNull(kioskDevices.revokedAt),
      ),
    );
  return !!row;
}

/** However often a code is sent, one PIN opens the sign-in for at most this
 *  long (v0.10.1, Part 10 review finding 5). */
export const UNLOCK_CAP_MIN = 15;

/** Keep the open window a little longer (the sign-in code is on its way), but
 *  never past UNLOCK_CAP_MIN after the PIN, and never re-open a closed one. */
export async function extendKioskUnlock(
  db: Db,
  device: KioskDevice,
  until: Date,
): Promise<Date | null> {
  const [row] = await db
    .update(kioskDevices)
    .set({
      unlockExpiresAt: sql`least(${until.toISOString()}::timestamptz, coalesce(${kioskDevices.unlockOpenedAt}, ${kioskDevices.unlockExpiresAt}) + make_interval(mins => ${UNLOCK_CAP_MIN}))`,
    })
    .where(
      and(
        eq(kioskDevices.id, device.deviceId),
        sql`${kioskDevices.unlockTokenHash} is not null`,
        gt(kioskDevices.unlockExpiresAt, new Date()),
      ),
    )
    .returning({ until: kioskDevices.unlockExpiresAt });
  return row?.until ?? null;
}

/** Used up (signed in) or abandoned. */
export async function closeKioskUnlock(db: Db, device: KioskDevice): Promise<void> {
  await db
    .update(kioskDevices)
    .set({ unlockTokenHash: null, unlockExpiresAt: null, unlockOpenedAt: null })
    .where(eq(kioskDevices.id, device.deviceId));
}

/** What the kiosk offers: the menu and the technicians a customer may ask for.
 *  No points, no status, no other customer (design doc). */
export type KioskTechnician = {
  id: string;
  name: string;
  /** The services she does; null = every service. Used to narrow the list to
   *  the chosen services, never shown. */
  serviceIds: string[] | null;
};

/**
 * v0.15.0: the technicians a customer may ask for: on shift today and able to
 * do every chosen service. Nobody when no service is chosen yet. Pure; the
 * screen and the check-in both use it, so a changed form cannot ask for more.
 */
export function techniciansFor(
  technicians: KioskTechnician[],
  serviceIds: string[],
): KioskTechnician[] {
  if (serviceIds.length === 0) return [];
  return technicians.filter(
    (t) => t.serviceIds === null || serviceIds.every((id) => t.serviceIds!.includes(id)),
  );
}

export async function kioskMenu(db: Db, device: KioskDevice) {
  const [menu, techs, levels, profiles, rules] = await Promise.all([
    db
      .select({
        id: services.id,
        name: services.name,
        category: serviceCategories.name,
        categoryId: services.categoryId,
      })
      .from(services)
      .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
      .where(
        and(
          eq(services.locationId, device.locationId),
          isNull(services.archivedAt),
          // v0.16.0: a fix or repair is entered at the desk only.
          eq(services.isFix, false),
        ),
      )
      .orderBy(serviceCategories.name, services.name),
    // v0.15.0: only who is checked in today (any status but off). Names only:
    // no status and no points ever reach the kiosk.
    db
      .select({ id: technicians.id, name: technicians.displayName })
      .from(technicians)
      .innerJoin(technicianStatus, eq(technicianStatus.technicianId, technicians.id))
      .where(
        and(
          eq(technicians.locationId, device.locationId),
          eq(technicians.active, true),
          ne(technicianStatus.status, 'off'),
        ),
      )
      .orderBy(technicians.displayName),
    loadLevels(db, device.locationId),
    loadProfiles(db, device.locationId),
    activeRules(db, device.locationId),
  ]);
  const required = rules.eligibility.skill_match === 'required';
  return {
    /** v0.16.0: most people in one group check-in (rules). */
    groupMax: rules.groups.max_people,
    services: menu.map((m) => ({ id: m.id, name: m.name, category: m.category })),
    technicians: techs.map((t): KioskTechnician => {
      const lv = levels.get(t.id);
      const profile = profiles.get(t.id);
      const serviceIds = !required
        ? null
        : lv
          ? menu.filter((m) => lv.serviceIds.has(m.id)).map((m) => m.id)
          : !profile || doesEverything(profile)
            ? null
            : menu.filter((m) => profile.skillCategoryIds.includes(m.categoryId)).map((m) => m.id);
      return { id: t.id, name: t.name, serviceIds };
    }),
  };
}

/** The long-wait notice, when the desk has switched it on (Part 5). */
export async function kioskNotice(
  db: Db,
  device: KioskDevice,
): Promise<{ show: false } | { show: true; minutes: number | null }> {
  const a = await floorAttention(db, device.locationId);
  if (!a.noticeEnabled) return { show: false };
  return {
    show: true,
    minutes: a.estimatedWaitMin && a.estimatedWaitMin > 0 ? a.estimatedWaitMin : null,
  };
}

export type KioskCheckInError =
  'bad_name' | 'bad_phone' | 'bad_age' | 'no_services' | 'unknown_service' | 'unknown_technician';

/**
 * A customer checks in. The visit waits for the desk to confirm. The answer is
 * the same for a new phone and a known one, and nothing about the stored client
 * comes back (T12).
 */
export async function kioskCheckIn(
  db: Db,
  input: {
    device: KioskDevice;
    /** First name (required). */
    name: unknown;
    /** v0.13.0: last name, optional. */
    lastName?: unknown;
    phone?: string | null;
    serviceIds: string[];
    attributes?: ClientAttributes | null;
    sameTime?: boolean;
    requestedTechnicianId?: string | null;
    /** v0.10.2: design or special request, free text, optional. */
    note?: unknown;
  },
): Promise<{ ok: true; visitIds: string[] } | { ok: false; reason: KioskCheckInError }> {
  const name = cleanKioskName(input.name);
  if (!name) return { ok: false, reason: 'bad_name' };
  const phone = input.phone?.trim() || null;
  // v0.15.0: only a technician the screen would have listed: on shift today
  // and able to do every chosen service.
  if (input.requestedTechnicianId) {
    const menu = await kioskMenu(db, input.device);
    const listed = techniciansFor(menu.technicians, [...new Set(input.serviceIds)]);
    if (!listed.some((t) => t.id === input.requestedTechnicianId)) {
      return { ok: false, reason: 'unknown_technician' };
    }
  }
  const r = await createWalkIn(db, {
    organizationId: input.device.organizationId,
    locationId: input.device.locationId,
    serviceIds: input.serviceIds,
    actor: { userId: null },
    source: 'self_checkin',
    requestedTechnicianId: input.requestedTechnicianId ?? null,
    note: cleanKioskNote(input.note),
    // Nothing typed here edits or makes a client row: the phone waits on the
    // visit, and the desk's confirm links it (v0.9.1, review finding 1).
    client: null,
    attributes: input.attributes ?? null,
    sameTime: input.sameTime,
    kiosk: {
      deviceId: input.device.deviceId,
      name,
      lastName: cleanKioskName(input.lastName),
      phone,
    },
  });
  if (!r.ok) {
    const known: KioskCheckInError[] = [
      'bad_phone',
      'bad_age',
      'no_services',
      'unknown_service',
      'unknown_technician',
    ];
    return {
      ok: false,
      reason: (known as string[]).includes(r.reason)
        ? (r.reason as KioskCheckInError)
        : 'no_services',
    };
  }
  return { ok: true, visitIds: r.visitIds };
}

export type KioskGroupPerson = {
  name: unknown;
  lastName?: unknown;
  serviceIds: string[];
  requestedTechnicianId?: string | null;
  note?: unknown;
};

/**
 * v0.16.0: a group checks in on the kiosk ("We're a group"): one visit per
 * person, linked by a party id, all waiting for the desk to confirm. The
 * phone (optional, one for the group) waits on the first person's visit;
 * nothing touches a client row until the desk confirms. All or nothing: a
 * refusal names the person (0-based) so the screen can go back to them.
 */
export async function kioskGroupCheckIn(
  db: Db,
  input: { device: KioskDevice; phone?: string | null; people: KioskGroupPerson[] },
): Promise<
  | { ok: true; partyId: string; visitIds: string[] }
  | { ok: false; reason: KioskCheckInError | 'party_too_big' | 'party_too_small'; person?: number }
> {
  const menu = await kioskMenu(db, input.device);
  if (input.people.length < 2) return { ok: false, reason: 'party_too_small' };
  if (input.people.length > menu.groupMax) return { ok: false, reason: 'party_too_big' };
  const people: { name: string; lastName: string | null; p: KioskGroupPerson }[] = [];
  for (const [i, p] of input.people.entries()) {
    const name = cleanKioskName(p.name);
    if (!name) return { ok: false, reason: 'bad_name', person: i };
    const ids = [...new Set(p.serviceIds)];
    if (ids.length === 0) return { ok: false, reason: 'no_services', person: i };
    if (p.requestedTechnicianId) {
      const listed = techniciansFor(menu.technicians, ids);
      if (!listed.some((t) => t.id === p.requestedTechnicianId)) {
        return { ok: false, reason: 'unknown_technician', person: i };
      }
    }
    people.push({ name, lastName: cleanKioskName(p.lastName), p });
  }
  const partyId = randomUUID();
  const phone = input.phone?.trim() || null;
  const known: KioskCheckInError[] = [
    'bad_phone',
    'bad_age',
    'no_services',
    'unknown_service',
    'unknown_technician',
  ];
  try {
    const visitIds = await db.transaction(async (tx) => {
      const out: string[] = [];
      for (const [i, x] of people.entries()) {
        const r = await createWalkIn(tx as unknown as Db, {
          organizationId: input.device.organizationId,
          locationId: input.device.locationId,
          serviceIds: [...new Set(x.p.serviceIds)],
          actor: { userId: null },
          source: 'self_checkin',
          requestedTechnicianId: x.p.requestedTechnicianId ?? null,
          note: cleanKioskNote(x.p.note),
          client: null,
          partyId,
          partyIndex: i,
          kiosk: {
            deviceId: input.device.deviceId,
            name: x.name,
            lastName: x.lastName,
            // One phone for the group, kept on the first person's visit.
            phone: i === 0 ? phone : null,
          },
        });
        if (!r.ok) {
          throw new KioskGroupRollback(
            (known as string[]).includes(r.reason)
              ? (r.reason as KioskCheckInError)
              : 'no_services',
            i,
          );
        }
        out.push(...r.visitIds);
      }
      return out;
    });
    return { ok: true, partyId, visitIds };
  } catch (e) {
    if (e instanceof KioskGroupRollback) return { ok: false, reason: e.reason, person: e.person };
    throw e;
  }
}

class KioskGroupRollback extends Error {
  constructor(
    readonly reason: KioskCheckInError,
    readonly person: number,
  ) {
    super(reason);
  }
}

export type KioskDecision = 'confirm' | 'confirm_no_request' | 'decline';

/**
 * The desk confirms a kiosk check-in (the engine may then call), or declines
 * it (nobody there, a test, a duplicate): the visit is cancelled. A same-time
 * pair is confirmed or declined together.
 *
 * v0.9.1 (review findings 1, 2, 6): the whole group is locked in one ordered
 * statement, so two desks on the two halves cannot deadlock. Only a confirm
 * links the typed phone to a client: a known phone is linked and never filled
 * in, a new one gets a row with the typed name (never the gender). "confirm"
 * accepts a requested technician (the visit becomes a request); with
 * "confirm_no_request" the request is dropped and the line decides.
 */
export async function reviewKioskVisit(
  db: Db,
  input: {
    actor: ManagerActor;
    visitId: string;
    decision: KioskDecision;
    now?: Date;
    /** v0.16.0: the whole group (party) at once; otherwise one person. */
    wholeParty?: boolean;
  },
): Promise<
  | { ok: true; visitIds: string[] }
  | { ok: false; reason: 'unknown_visit' | 'wrong_location' | 'not_pending' }
> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [first] = await tx
      .select({ groupId: visits.groupId, partyId: visits.partyId })
      .from(visits)
      .where(eq(visits.id, input.visitId));
    if (!first) return { ok: false as const, reason: 'unknown_visit' as const };
    const party = input.wholeParty && first.partyId ? first.partyId : null;
    const rows = await tx
      .select({
        id: visits.id,
        locationId: visits.locationId,
        organizationId: visits.organizationId,
        needsConfirm: visits.needsConfirm,
        status: visits.status,
        source: visits.source,
        requestedTechnicianId: visits.requestedTechnicianId,
        kioskName: visits.kioskName,
        kioskLastName: visits.kioskLastName,
        kioskPhone: visits.kioskPhone,
        partyId: visits.partyId,
      })
      .from(visits)
      .where(
        party
          ? or(eq(visits.id, input.visitId), eq(visits.partyId, party))
          : first.groupId
            ? or(eq(visits.id, input.visitId), eq(visits.groupId, first.groupId))
            : eq(visits.id, input.visitId),
      )
      .orderBy(asc(visits.id))
      .for('update');
    const visit = rows.find((r) => r.id === input.visitId);
    if (!visit) return { ok: false as const, reason: 'unknown_visit' as const };
    if (
      visit.locationId !== input.actor.locationId ||
      visit.organizationId !== input.actor.organizationId
    ) {
      return { ok: false as const, reason: 'wrong_location' as const };
    }
    if (!visit.needsConfirm || visit.status !== 'waiting') {
      return { ok: false as const, reason: 'not_pending' as const };
    }
    const group = rows.filter(
      (r) => r.locationId === visit.locationId && r.needsConfirm && r.status === 'waiting',
    );
    const ids = group.map((g) => g.id);

    if (input.decision === 'decline') {
      await tx
        .update(visits)
        .set({
          needsConfirm: false,
          status: 'cancelled',
          cancelledAt: now,
          kioskPhone: null,
          updatedAt: now,
        })
        .where(inArray(visits.id, ids));
      for (const id of ids) {
        await writeAudit(tx, {
          organizationId: visit.organizationId,
          locationId: visit.locationId,
          actorUserId: input.actor.userId,
          entityType: 'visits',
          entityId: id,
          action: 'kiosk_declined',
        });
      }
      return { ok: true as const, visitIds: ids };
    }

    // v0.16.0: in a group every person is their own client. The group's phone
    // (on the first person's visit) goes with that person; the others get a
    // client row with the name they typed. One at a time works the same way.
    if (group.some((g) => g.partyId)) {
      for (const g of group) {
        const c = await upsertClient(tx, {
          organizationId: visit.organizationId,
          locationId: visit.locationId,
          firstName: g.kioskName ?? null,
          lastName: g.kioskLastName ?? null,
          phone: g.kioskPhone ?? null,
          gender: null,
          fillBlanks: false,
        });
        await confirmOne(tx, g, input, now, c.ok ? c.clientId : null);
      }
      return { ok: true as const, visitIds: ids };
    }
    const phone = group.find((g) => g.kioskPhone)?.kioskPhone ?? null;
    let clientId: string | null = null;
    if (phone) {
      const c = await upsertClient(tx, {
        organizationId: visit.organizationId,
        locationId: visit.locationId,
        firstName: group.find((g) => g.kioskName)?.kioskName ?? null,
        lastName: group.find((g) => g.kioskLastName)?.kioskLastName ?? null,
        phone,
        gender: null,
        fillBlanks: false,
      });
      clientId = c.ok ? c.clientId : null;
    }
    for (const g of group) await confirmOne(tx, g, input, now, clientId);
    return { ok: true as const, visitIds: ids };
  });
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Confirms one kiosk visit: the request kept or dropped, the client linked. */
async function confirmOne(
  tx: Tx,
  g: {
    id: string;
    organizationId: string;
    locationId: string;
    source: (typeof visits.$inferSelect)['source'];
    requestedTechnicianId: string | null;
    partyId: string | null;
  },
  input: { actor: ManagerActor; decision: KioskDecision },
  now: Date,
  clientId: string | null,
): Promise<void> {
  const keepRequest = input.decision === 'confirm' && !!g.requestedTechnicianId;
  const source = keepRequest ? 'request' : g.source;
  const requestedTechnicianId = keepRequest ? g.requestedTechnicianId : null;
  await tx
    .update(visits)
    .set({
      needsConfirm: false,
      confirmedBy: input.actor.userId,
      confirmedAt: now,
      source,
      requestedTechnicianId,
      kioskPhone: null,
      ...(clientId ? { clientId } : {}),
      updatedAt: now,
    })
    .where(eq(visits.id, g.id));
  await writeAudit(tx, {
    organizationId: g.organizationId,
    locationId: g.locationId,
    actorUserId: input.actor.userId,
    entityType: 'visits',
    entityId: g.id,
    action: 'kiosk_confirmed',
    after: {
      source,
      requestedTechnicianId,
      ...(g.requestedTechnicianId && !keepRequest
        ? { droppedRequestTechnicianId: g.requestedTechnicianId }
        : {}),
      hasClient: clientId !== null,
    },
  });
}

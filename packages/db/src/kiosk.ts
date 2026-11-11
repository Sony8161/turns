// Customer self check-in on a salon iPad (Part 9; design doc, Customer self
// check-in; threat model T7, T12, T20, T25). Server only: runs with the
// service connection, so the web callers check the staff role (pairing,
// revoking, confirming) or the device token (check-in) before calling.
//
// What a kiosk can do: create a waiting visit at its own location, which the
// desk confirms before anyone is called. Nothing else. It never reads a
// client, a visit or the board, and its answer is the same whether or not the
// phone typed is already on file (no enumeration).
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { createWalkIn, floorAttention, type ClientAttributes, type ManagerActor } from './engine';
import { generateCode, hashCode } from './invites';
import { kioskDevices, serviceCategories, services, technicians, visits } from './schema';
import type { Db } from './server';
import { writeAudit } from './status';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const PAIRING_TTL_MIN = 15;
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
    .orderBy(asc(kioskDevices.revokedAt), desc(kioskDevices.createdAt));
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
    if (!row) return { ok: false as const, reason: 'bad_code' as const };
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
    .where(and(eq(kioskDevices.tokenHash, hashToken(token)), isNull(kioskDevices.revokedAt)));
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

/** What the kiosk offers: the menu and the technicians a customer may ask for.
 *  No points, no status, no other customer (design doc). */
export async function kioskMenu(db: Db, device: KioskDevice) {
  const [menu, techs] = await Promise.all([
    db
      .select({ id: services.id, name: services.name, category: serviceCategories.name })
      .from(services)
      .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
      .where(and(eq(services.locationId, device.locationId), isNull(services.archivedAt)))
      .orderBy(serviceCategories.name, services.name),
    db
      .select({ id: technicians.id, name: technicians.displayName })
      .from(technicians)
      .where(and(eq(technicians.locationId, device.locationId), eq(technicians.active, true)))
      .orderBy(technicians.displayName),
  ]);
  return { services: menu, technicians: techs };
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
    name: unknown;
    phone?: string | null;
    serviceIds: string[];
    attributes?: ClientAttributes | null;
    sameTime?: boolean;
    requestedTechnicianId?: string | null;
  },
): Promise<{ ok: true; visitIds: string[] } | { ok: false; reason: KioskCheckInError }> {
  const name = cleanKioskName(input.name);
  if (!name) return { ok: false, reason: 'bad_name' };
  const phone = input.phone?.trim() || null;
  const r = await createWalkIn(db, {
    organizationId: input.device.organizationId,
    locationId: input.device.locationId,
    serviceIds: input.serviceIds,
    actor: { userId: null },
    source: 'self_checkin',
    requestedTechnicianId: input.requestedTechnicianId ?? null,
    // The phone alone is the match key; a name without a phone would make a
    // new client row on every check-in. A known phone keeps its stored name.
    client: phone ? { name, phone } : null,
    attributes: input.attributes ?? null,
    sameTime: input.sameTime,
    kiosk: { deviceId: input.device.deviceId, name },
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

/**
 * The desk confirms a kiosk check-in (the engine may then call), or declines
 * it (nobody there, a test, a duplicate): the visit is cancelled. A same-time
 * pair is confirmed or declined together.
 */
export async function reviewKioskVisit(
  db: Db,
  input: { actor: ManagerActor; visitId: string; decision: 'confirm' | 'decline'; now?: Date },
): Promise<
  | { ok: true; visitIds: string[] }
  | { ok: false; reason: 'unknown_visit' | 'wrong_location' | 'not_pending' }
> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [visit] = await tx
      .select({
        id: visits.id,
        locationId: visits.locationId,
        organizationId: visits.organizationId,
        groupId: visits.groupId,
        needsConfirm: visits.needsConfirm,
        status: visits.status,
      })
      .from(visits)
      .where(eq(visits.id, input.visitId))
      .for('update');
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
    const group = visit.groupId
      ? await tx
          .select({ id: visits.id })
          .from(visits)
          .where(
            and(
              eq(visits.groupId, visit.groupId),
              eq(visits.locationId, visit.locationId),
              eq(visits.needsConfirm, true),
              eq(visits.status, 'waiting'),
            ),
          )
          .for('update')
      : [{ id: visit.id }];
    const ids = group.map((g) => g.id);
    await tx
      .update(visits)
      .set(
        input.decision === 'confirm'
          ? {
              needsConfirm: false,
              confirmedBy: input.actor.userId,
              confirmedAt: now,
              updatedAt: now,
            }
          : { needsConfirm: false, status: 'cancelled', cancelledAt: now, updatedAt: now },
      )
      .where(inArray(visits.id, ids));
    for (const id of ids) {
      await writeAudit(tx, {
        organizationId: visit.organizationId,
        locationId: visit.locationId,
        actorUserId: input.actor.userId,
        entityType: 'visits',
        entityId: id,
        action: input.decision === 'confirm' ? 'kiosk_confirmed' : 'kiosk_declined',
      });
    }
    return { ok: true as const, visitIds: ids };
  });
}

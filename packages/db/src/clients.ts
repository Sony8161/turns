// Clients (Part 6). Minimal on purpose: Fresha stays the client system
// (design doc). The phone, in E.164, is the match key so a later import of
// Fresha's client list lands on the same rows (Duong, 2026-11-04). Server only.
import { and, eq, isNull } from 'drizzle-orm';
import { clients } from './schema';
import type { Db } from './server';

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
  name?: string | null;
  phone?: string | null;
  gender?: ClientGender | null;
};

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
  input: { organizationId: string; locationId: string } & ClientInput,
): Promise<{ ok: true; clientId: string | null } | { ok: false; reason: 'bad_phone' }> {
  const name = input.name?.trim().slice(0, 120) || null;
  const rawPhone = input.phone?.trim() ?? '';
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (rawPhone && !phone) return { ok: false, reason: 'bad_phone' };
  const gender = input.gender ?? null;
  if (!name && !phone) return { ok: true, clientId: null };

  const now = new Date();
  if (phone) {
    const [existing] = await tx
      .select({ id: clients.id, name: clients.name, gender: clients.gender })
      .from(clients)
      .where(
        and(
          eq(clients.locationId, input.locationId),
          eq(clients.phone, phone),
          isNull(clients.anonymisedAt),
        ),
      )
      .for('update');
    if (existing) {
      await tx
        .update(clients)
        .set({
          ...(name && !existing.name ? { name } : {}),
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

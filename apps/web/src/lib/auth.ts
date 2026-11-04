import 'server-only';
// Who is acting, and where. Every staff page and action starts here.
import { and, asc, eq } from 'drizzle-orm';
import { locations, memberships, profiles } from '@turn/db';
import type { Role } from '@turn/db/invites';
import { redirect } from 'next/navigation';
import { db } from './db';
import { getAuthUser } from './supabase/server';

export type Membership = {
  organizationId: string;
  locationId: string;
  locationName: string;
  role: Role;
};

export type Actor = {
  userId: string;
  displayName: string;
  memberships: Membership[];
};

/** Signed-in user with their active memberships, or null when signed out. */
export async function getActor(): Promise<Actor | null> {
  const user = await getAuthUser();
  if (!user) return null;
  const [profile, rows] = await Promise.all([
    db()
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .then((r) => r[0]),
    db()
      .select({
        organizationId: memberships.organizationId,
        locationId: memberships.locationId,
        locationName: locations.name,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(locations, eq(locations.id, memberships.locationId))
      .where(and(eq(memberships.userId, user.id), eq(memberships.active, true)))
      // Oldest membership first, so a multi-location user gets a stable default.
      // Part 3 adds an explicit location choice before any write uses it (T10).
      .orderBy(asc(memberships.createdAt)),
  ]);
  return {
    userId: user.id,
    displayName: profile?.displayName ?? user.email ?? user.phone ?? '',
    memberships: rows,
  };
}

/** Redirects to /login when signed out. Membership checks are separate. */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect('/login');
  return actor;
}

'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { LOCATION_COOKIE, locationsOf, requireActor } from '@/lib/auth';

/** Switch the location this browser works at. Only one of the actor's own
 *  locations is accepted; every page and action still checks the membership. */
export async function switchLocation(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const wanted = String(formData.get('locationId') ?? '');
  if (!locationsOf(actor).some((l) => l.id === wanted)) redirect('/admin');
  (await cookies()).set(LOCATION_COOKIE, wanted, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  redirect('/admin');
}

'use server';

// v0.17.1 (review #6): a technician's own Fresha link. The owner picks what
// happens when she adds one (owner_approves for Heavenly), and the owner or a
// manager approves or declines a waiting link here. Who and where come from
// the session (T10); no link and no hint ever comes back (T14).
import { isTechCalendarLinks, reviewFeed, setTechCalendarLinks, syncFeed } from '@turn/db/feeds';
import { revalidatePath } from 'next/cache';
import { guarded } from '@/lib/action';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { uuidOf } from '@/lib/ids';

export type FeedReviewState = {
  done?: 'approved' | 'declined';
  error?: string;
  ref?: string;
};
export type TechLinksState = { saved?: boolean; error?: string; ref?: string };

function refresh() {
  for (const p of ['/admin/appointments', '/admin', '/me', '/me/calendar']) revalidatePath(p);
}

/** Approve (it syncs at once) or decline (the link is removed) her link. */
export async function reviewFeedAction(
  _prev: FeedReviewState,
  formData: FormData,
): Promise<FeedReviewState> {
  return guarded('reviewFeedAction', { error: 'server' } as FeedReviewState, async () => {
    const actor = await requireActor();
    const m = membershipWith(actor, 'approve_calendar_links');
    if (!m) return { error: 'not_allowed' };
    const technicianId = uuidOf(formData.get('technicianId'));
    if (!technicianId) return { error: 'unknown_technician' };
    const decision = formData.get('decision') === 'approve' ? 'approve' : 'decline';
    const r = await reviewFeed(db(), {
      actor: {
        userId: actor.userId,
        role: m.role,
        organizationId: m.organizationId,
        locationId: m.locationId,
      },
      technicianId,
      decision,
    });
    if (!r.ok) return { error: r.reason };
    if (decision === 'approve') {
      // Bring her appointments in now; a failed first sync is retried by the
      // cron and shows on this page as usual.
      try {
        await syncFeed(db(), { feedId: r.feedId, actorUserId: actor.userId });
      } catch {
        // the poll tries again
      }
    }
    refresh();
    return { done: decision === 'approve' ? 'approved' : 'declined' };
  });
}

/** Owner only: what happens when a technician adds her own link (audited). */
export async function techLinksAction(
  _prev: TechLinksState,
  formData: FormData,
): Promise<TechLinksState> {
  return guarded('techLinksAction', { error: 'server' } as TechLinksState, async () => {
    const actor = await requireActor();
    const m = membershipWith(actor, 'manage_rules');
    if (!m) return { error: 'not_allowed' };
    const value = String(formData.get('value') ?? '');
    if (!isTechCalendarLinks(value)) return { error: 'bad_value' };
    const r = await setTechCalendarLinks(db(), {
      actor: {
        userId: actor.userId,
        role: m.role,
        organizationId: m.organizationId,
        locationId: m.locationId,
      },
      value,
    });
    refresh();
    return r.ok ? { saved: true } : { error: r.reason };
  });
}

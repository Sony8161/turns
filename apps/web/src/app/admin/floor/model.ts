// v0.18.0 "Simplify the desk": the board's words and choices, worked out from
// the engine's own data. Pure (no database, no React), so the tests pin them.
// No rule lives here: who may be called is the engine's queue; this only says
// it in words and picks which existing action a button sends.
import { fill, type Dictionary } from '@/i18n/dictionary';

type F = Dictionary['floor'];

/** One set of status words everywhere (B3). A tech held for her appointment
 *  is never "available". */
export type FloorStatus =
  'available' | 'held' | 'called' | 'in_service' | 'break' | 'out' | 'checked_in';

export function floorStatus(
  status: string,
  heldForAppointment: boolean,
  why?: string | null,
): FloorStatus {
  if (status === 'called') return 'called';
  if (status === 'available') {
    return heldForAppointment || why === 'appointment_soon' ? 'held' : 'available';
  }
  if (status === 'in_service' || status === 'break' || status === 'out') return status;
  return 'checked_in';
}

/** Whole minutes from `at` to `now`, never negative. */
export function minutesSince(at: Date | null | undefined, now: Date): number {
  if (!at) return 0;
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000));
}

/** The labelled time on a tech row (B4): "free 64 min", "called just now". */
export function timeText(
  t: F,
  s: FloorStatus,
  minutes: number,
  extra: { heldAt?: string | null; over?: boolean; limit?: number } = {},
): string {
  const n = { n: minutes };
  switch (s) {
    case 'available':
      return minutes < 1 ? t.time.freeNow : fill(t.time.free, n);
    case 'held':
      return extra.heldAt ? fill(t.time.held, { time: extra.heldAt }) : t.status.held!;
    case 'called':
      return minutes < 1 ? t.time.calledNow : fill(t.time.called, n);
    case 'in_service':
      return fill(t.time.with, n);
    case 'break':
      return fill(t.time.break, n);
    case 'out':
      return extra.over
        ? fill(t.time.outOver, { n: minutes, limit: extra.limit ?? 60 })
        : fill(t.time.out, n);
    default:
      return fill(t.time.checkedIn, n);
  }
}

/** "Next: Vân", or why nobody can be called, counted by status in a few words. */
export function nextLine(
  t: F,
  next: string | null,
  team: { status: FloorStatus }[],
): { title: string; why: string | null } {
  if (next) return { title: fill(t.next, { name: next }), why: t.nextLead };
  if (team.length === 0) return { title: t.nobodyNext, why: t.nobodyCheckedIn };
  const order: FloorStatus[] = ['called', 'in_service', 'held', 'break', 'out', 'checked_in'];
  const parts = order
    .map((s) => ({ s, n: team.filter((m) => m.status === s).length }))
    .filter((p) => p.n > 0)
    .map((p) => fill(t.whyCount[p.s] ?? '{n}', { n: p.n }));
  return { title: t.nobodyNext, why: parts.join(', ') || null };
}

/** The person first (B9): "Thu P. · Gel manicure · 13 min"; no name: "Walk-in". */
export function rowTitle(
  t: F,
  v: { clientName: string | null; kioskName: string | null; services: string[] },
  waitMinutes: number | null,
): { who: string; services: string; wait: string | null; title: string } {
  const who = v.clientName ?? v.kioskName ?? t.walkInName;
  const services = v.services.join(' + ');
  const wait =
    waitMinutes === null ? null : waitMinutes < 1 ? t.waitNow : fill(t.waitMin, { n: waitMinutes });
  return { who, services, wait, title: [who, services, wait].filter(Boolean).join(' · ') };
}

export type NotHere = 'kiosk_decline' | 'walked_out' | 'client_left';

/** One "Client isn't here" (C2): which existing action it sends, from where
 *  the visit stands. A booked client past the start is a no-show on
 *  Appointments; a visit in service has none. */
export function notHereAction(v: {
  status: string;
  needsConfirm: boolean;
  leftClaimPending?: boolean;
}): NotHere | null {
  if (v.status === 'waiting') return v.needsConfirm ? 'kiosk_decline' : 'walked_out';
  if (v.status === 'called' && !v.leftClaimPending) return 'client_left';
  return null;
}

/** "Call next" acts on the first waiting client who can be called by turn:
 *  confirmed, approved, not a desk pick, not waiting behind a first part,
 *  not held for a busy requested tech. */
export function firstCallable<
  V extends {
    status: string;
    needsConfirm: boolean;
    needsApproval: boolean;
    deskPicks: boolean;
    held: unknown;
    hold: unknown;
  },
>(waiting: V[]): V | undefined {
  return waiting.find(
    (v) =>
      v.status === 'waiting' &&
      !v.needsConfirm &&
      !v.needsApproval &&
      !v.deskPicks &&
      !v.held &&
      !v.hold,
  );
}

// ---------------------------------------------------------------------------
// The walk-in sheet's tiles (B7)

export type TileGroup = 'hands' | 'feet' | 'enhancements' | 'addons';
export const TILE_GROUPS: TileGroup[] = ['hands', 'feet', 'enhancements', 'addons'];

export type TileService = {
  id: string;
  name: string;
  category: string;
  isFillOrFullSet?: boolean;
  deskPicks?: boolean;
  isFix?: boolean;
};

/** Hands, Feet, Enhancements, Add-ons from the salon's own categories: a
 *  fill or full set is an enhancement, a service the desk picks the tech for
 *  (nail art, design) is an add-on, a pedicure category is feet, the rest is
 *  hands. A fix is not a tile: it has its own "Nail fix" choice. */
export function tileGroup(s: TileService): TileGroup | 'fix' {
  if (s.isFix) return 'fix';
  if (s.isFillOrFullSet) return 'enhancements';
  if (s.deskPicks) return 'addons';
  if (/pedi|foot|feet|chân/i.test(s.category)) return 'feet';
  return 'hands';
}

/** The tiles in their groups, most used first (visits in the last 30 days),
 *  ties by name. Empty groups are left out. */
export function groupTiles<S extends TileService>(
  services: S[],
  usage: Record<string, number>,
): { group: TileGroup; services: S[] }[] {
  return TILE_GROUPS.map((group) => ({
    group,
    services: services
      .filter((s) => tileGroup(s) === group)
      .sort((a, b) => (usage[b.id] ?? 0) - (usage[a.id] ?? 0) || a.name.localeCompare(b.name)),
  })).filter((g) => g.services.length > 0);
}

/** A category in words, never a code like full_set. */
export function categoryLabel(name: string, labels: Record<string, string>): string {
  return labels[name] ?? name.replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// The one "Pick someone" sheet (C1, B12)

export type QueueEntry = {
  technicianId: string;
  displayName: string;
  eligible: boolean;
  why: string;
  skilled: boolean;
  level?: string;
  appointmentAt?: string;
};

export type PickAction = 'call_next' | 'offer' | 'desk_pick' | 'reassign';

export type PickOption = {
  technicianId: string;
  name: string;
  /** Place in this visit's line, 1 = first. */
  place: number;
  level: string | null;
  /** What she is for this visit, in words: "next by turn", "busy". */
  label: string;
  /** Greyed with this reason when she cannot be picked. */
  why: string | null;
  action: PickAction | null;
  suggested: boolean;
};

const RESTRICTED = ['no_male_clients', 'no_kids', 'min_client_age', 'no_same_time'];

/**
 * Everyone able to do the visit, in its line, with a label and the action a
 * tap sends. The same choices the desk had on three screens: Call next (the
 * first by turn), Ask a higher-level tech (only while nobody gets it by
 * turn), Pick a tech (desk-pick services), and for owners and managers
 * sending her out of turn (reassign, with a reason). The server checks every
 * one of them again.
 */
export function pickOptions(
  t: F,
  entry: { deskPicks: boolean; queue: QueueEntry[]; originalTechnicianId: string | null },
  opts: { canReassign: boolean; clock: (iso: string) => string },
): PickOption[] {
  const reason = (c: QueueEntry) =>
    fill(t.why[c.why] ?? c.why, {
      time: c.appointmentAt ? opts.clock(c.appointmentAt) : '',
    });
  const able = entry.queue
    .map((c, i) => ({ c, place: i + 1 }))
    .filter(({ c }) => c.skilled && c.why !== 'no_skill');
  const first = able.find(({ c }) => c.eligible)?.c ?? null;
  const out: PickOption[] = able.map(({ c, place }) => {
    const base = {
      technicianId: c.technicianId,
      name: c.displayName,
      place,
      level: c.level ?? null,
      suggested: false,
    };
    const greyed = (why: string): PickOption => ({ ...base, label: why, why, action: null });
    if (RESTRICTED.includes(c.why)) return greyed(reason(c));
    if (entry.deskPicks) {
      if (c.eligible || c.why === 'not_by_turn') {
        const label =
          c.technicianId === entry.originalTechnicianId
            ? t.label.original!
            : c.eligible
              ? t.label.free!
              : t.label.higher!;
        return { ...base, label, why: null, action: 'desk_pick' };
      }
      return greyed(reason(c));
    }
    if (c.eligible) {
      if (first && c.technicianId === first.technicianId) {
        return { ...base, label: t.label.next!, why: null, action: 'call_next' };
      }
      const label = fill(t.label.after!, { name: first?.displayName ?? '' });
      return opts.canReassign ? { ...base, label, why: null, action: 'reassign' } : greyed(label);
    }
    if (c.why === 'not_by_turn') {
      if (!first) return { ...base, label: t.label.higher!, why: null, action: 'offer' };
      return greyed(fill(t.label.higherWait!, { name: first.displayName }));
    }
    return greyed(reason(c));
  });
  // The suggested one: the tech who did the original work (a fix), else the
  // first by turn, else the first who can be asked or picked.
  const pick =
    out.find((o) => o.action && o.technicianId === entry.originalTechnicianId) ??
    out.find((o) => o.action === 'call_next') ??
    out.find((o) => o.action === 'desk_pick' || o.action === 'offer');
  if (pick) pick.suggested = true;
  return out;
}

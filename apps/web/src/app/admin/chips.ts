// Pure helpers shared by the desk (client) and the overrides page (server).
// No 'use client' here on purpose: a server component cannot call a function
// exported from a client module.
import type { SkipReason } from '@turn/db/engine';
import { fill, type Dictionary } from '@/i18n/dictionary';

export type VisitAttributes = {
  clientGender: 'female' | 'male' | 'unspecified' | null;
  clientIsKid: boolean | null;
  clientAge: number | null;
  groupId: string | null;
};

/** The chips the desk sees on a waiting visit: what the rules were told. */
export function visitChips(v: VisitAttributes, t: Dictionary['desk']['chips']): string[] {
  const chips: string[] = [];
  if (v.clientGender === 'male') chips.push(t.male);
  if (v.clientGender === 'female') chips.push(t.female);
  if (v.clientIsKid) {
    chips.push(v.clientAge !== null ? fill(t.kidAge, { age: v.clientAge }) : t.kid);
  } else if (v.clientAge !== null) chips.push(fill(t.age, { age: v.clientAge }));
  if (v.groupId) chips.push(t.together);
  return chips;
}

export type SkippedLine = {
  displayName: string;
  why: SkipReason;
  detail?: string;
  /** The technician's free-text restriction, if they have one. */
  note?: string;
};

/** "does not do full_set", "appointment in 20 min": the reason in words. */
export function skipText(s: SkippedLine, skip: Dictionary['desk']['skip']): string {
  const why = fill(skip[s.why] ?? s.why, { detail: s.detail ?? '' });
  return s.note ? `${why} · ${s.note}` : why;
}

/** The engine's skipped list in the desk's shape (drops the technician id). */
export function toSkippedLines(
  skipped: { displayName: string; why: SkipReason; detail?: string; note?: string }[] | undefined,
): SkippedLine[] | undefined {
  return skipped?.map((s) => ({
    displayName: s.displayName,
    why: s.why,
    ...(s.detail ? { detail: s.detail } : {}),
    ...(s.note ? { note: s.note } : {}),
  }));
}

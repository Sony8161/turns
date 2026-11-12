import { fill, type Dictionary } from '@/i18n/dictionary';

/**
 * The line under the technician's name. A call waiting for her answer says so
 * (v0.16.1: it used to read "You are available" while the call card showed).
 * Pure.
 */
export function meStatusLine(t: Dictionary, status: string, hasOpenCall: boolean): string {
  if (hasOpenCall) return t.me.callWaiting;
  return fill(t.me.statusLine, {
    status: (t.board.status as Record<string, string>)[status] ?? status,
  });
}

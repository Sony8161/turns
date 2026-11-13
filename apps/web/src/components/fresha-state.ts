// Shared by the Connect Fresha card (client) and /me (server), v0.11.0.
import { fill, type Dictionary } from '@/i18n/dictionary';

export type FreshaRowState =
  | { kind: 'none' }
  | { kind: 'never' }
  /** v0.17.1: a technician's own link, waiting for the owner or a manager. */
  | { kind: 'pending' }
  | { kind: 'ok'; time: string }
  | { kind: 'stale'; time: string }
  | { kind: 'failing'; error: string };

export type FreshaRowItem = { id: string; name: string; state: FreshaRowState };

type T = Dictionary['fresha'];

export function stateLine(t: T, s: FreshaRowState): string {
  switch (s.kind) {
    case 'none':
      return t.stateNone;
    case 'never':
      return t.stateNever;
    case 'pending':
      return t.statePending;
    case 'ok':
      return fill(t.stateOk, { time: s.time });
    case 'stale':
      return fill(t.stateStale, { time: s.time });
    case 'failing':
      return fill(t.stateFailing, { error: s.error });
  }
}

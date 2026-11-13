// v0.18.0: what the board page hands the floor components. Words are worked
// out on the server (model.ts); ids are only what an existing action needs.
import type { Waiting } from './waiting';
import type { FloorStatus, PickOption } from './model';

export type TeamMember = {
  id: string;
  name: string;
  /** Place in the line, 1 = next. */
  place: number;
  status: FloorStatus;
  /** Points as the board writes them: 0, 00, ½, 1½. */
  points: string;
  pointsWords: string;
  /** "free 64 min", "called just now", "held: appt 2:30 PM". */
  time: string;
  /** Out over the limit, or a call nobody answered: in Polish, with words. */
  alert: boolean;
  callable: boolean;
  isNext: boolean;
  /** Why a plain call cannot go to her now, when the time label does not say it. */
  reason: string | null;
  // The drawer
  levelLine: string;
  diffLines: string[];
  limits: string[];
  apptLine: string;
  currentLine: string | null;
  lines: { delta: string; text: string; at: string }[];
  total: string;
  notes: string[];
  freeDenyBadge: string | null;
  openCallId: string | null;
  openCallKind: string | null;
  inServiceVisitId: string | null;
  penalties: { ledgerId: string; text: string; excused: boolean }[];
};

export type ClientRow = Waiting & {
  who: string;
  servicesText: string;
  wait: string | null;
  title: string;
  /** The open call's line: "Called Vân · just now". */
  callLine: string | null;
  pick: PickOption[] | null;
};

export type CheckoutItem = { visitId: string; who: string; parts: string[]; finished: string };

export type NeedsItem =
  | { kind: 'kiosk'; key: string; row: ClientRow }
  | { kind: 'fix'; key: string; row: ClientRow }
  | { kind: 'left'; key: string; row: ClientRow }
  | { kind: 'help'; key: string; id: string; title: string; detail: string }
  | { kind: 'unanswered'; key: string; callId: string; title: string }
  | { kind: 'hold'; key: string; row: ClientRow; title: string; detail: string }
  | { kind: 'links'; key: string; title: string }
  | { kind: 'sync'; key: string; title: string };

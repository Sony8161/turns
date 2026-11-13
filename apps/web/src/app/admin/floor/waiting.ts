// The desk's view of one open visit and of what needs a person (moved here
// from Desk.tsx in v0.18.0, unchanged: the board components share it).
export type Waiting = {
  id: string;
  status: string;
  services: string[];
  waitSeconds: number;
  calledTechnician: string | null;
  calledSeconds: number | null;
  assignedTechnician: string | null;
  requestedTechnician: string | null;
  note: string | null;
  clientName: string | null;
  clientGender: 'female' | 'male' | 'unspecified' | null;
  clientIsKid: boolean | null;
  clientAge: number | null;
  groupId: string | null;
  /** Part 9: checked in on the kiosk; waits for the desk until confirmed. */
  fromKiosk: boolean;
  kioskName: string | null;
  needsConfirm: boolean;
  /** v0.14.0: never called by turn; the desk picks the technician. */
  deskPicks: boolean;
  /** The services a technician sent back when she split a visit. */
  splitRest: boolean;
  /** The open call's kind: by turn, an offer to a higher level, or a desk pick. */
  callKind: string | null;
  /** v0.15.0: the earlier parts of this client's visit (the on-screen slip).
   *  v0.17.0: done = her part is finished ("did"), else she "is doing" it. */
  slip: { technician: string | null; services: string[]; done?: boolean }[] | null;
  /** v0.17.0: the open call and the technicians, so the desk can act for her. */
  callId: string | null;
  calledTechnicianId: string | null;
  assignedTechnicianId: string | null;
  /** v0.17.0: the called technician said the client left; the desk answers. */
  leftClaimPending: boolean;
  /** Not callable yet: it waits until this technician finishes her part. */
  held: { technician: string | null } | null;
  /** The requested technician was booked (an appointment), not asked for at the desk. */
  booked: boolean;
  /** The requested or booked technician is busy: what the desk needs to decide. */
  hold: {
    technicianName: string;
    /** The engine's reason she cannot be called (in_service, break, ...). */
    why: string;
    detail?: string;
    /** Minutes she has been in that status; null when not on shift. */
    forMinutes: number | null;
    /** Her next appointment, as a clock time at the salon; null = none. */
    nextAppointment: string | null;
    waitedMin: number;
    attention: boolean;
  } | null;
  /** v0.16.0: people who came in together; partySize counts them all. */
  partyId: string | null;
  partySize: number | null;
  /** v0.16.0: a nail fix or repair, the visit it fixes, and the approval. */
  isFix: boolean;
  needsApproval: boolean;
  fixOf: { date: string; services: string[]; technician: string | null } | null;
};
export type Attention = {
  unansweredCalls: { callId: string; technicianName: string; waitedMin: number }[];
  unansweredCallMin: number;
  estimatedWaitMin: number | null;
  longWait: boolean;
  longWaitMin: number;
  noticeEnabled: boolean;
  timers: {
    technicianId: string;
    technicianName: string;
    status: 'break' | 'out';
    minutes: number;
    over: boolean;
  }[];
  outOverMin: number;
  /** v0.16.0: technicians who tapped "Need help", oldest first. */
  help: { id: string; name: string; reason: string | null; waitedSeconds: number }[];
};

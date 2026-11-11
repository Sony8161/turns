# How the turn system works

What each part is for, what it does today, and what it is meant to do when
finished. Plain language; the code is the detail. Design source:
`../Turn System Design Doc.md`. Updated 2026-11-04 after Part 3.

## The idea in one paragraph

A nail salon runs on walk-ins. Who gets the next customer is decided by turns and
points: a technician who has done less today is called first; a bigger service
is worth more points than a small one. Today that lives on paper and in
arguments. This system puts the queue on a screen everyone can see, lets each
technician say "I'm here / ready / on break" from their own phone, and keeps a
record that cannot be edited, so "why did she get called before me" has an
answer.

## Who uses it

| Person            | Where                              | What they do                                                                                                                                                                                                                               |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner             | laptop or phone, `/admin`          | everything: rules, invites, overrides, archive, the full audit log, export                                                                                                                                                                 |
| Manager           | `/admin`                           | runs the floor and the staff: adjust turns and points, override with a reason, move a visit to another technician, change a tech's services and skills, invite, see archived records and their location's audit log. Not rules, not export |
| Receptionist      | iPad at the desk, `/admin`         | only the queue: sees the board, enters walk-ins, calls the next technician                                                                                                                                                                 |
| Technician        | own iPhone, `/me` (later the app)  | only their own day: check in, ready, break, out, upcoming appointments, the service they are called for, accept, deny (penalty shown first), finished                                                                                      |
| Customer          | a second iPad at the desk (Part 9) | checks themselves in                                                                                                                                                                                                                       |
| You, the operator | command line                       | makes salon setup codes, keeps the service running                                                                                                                                                                                         |

Every person belongs to one salon (an "organization") at one or more locations,
with one role per location. A role at salon A gives nothing at salon B.

## The parts, in the order they were built

### Part 1. The foundation (done)

The database and its rules. Every table carries the salon it belongs to, and
the database itself refuses to show one salon's rows to another salon's users
(row-level security). App users can only _read_; every _write_ goes through the
server, which checks who is asking first. Points are stored as a ledger of
entries, never as a running total, so a total can always be recomputed and
disputed line by line.

### Part 2. Accounts, sign-in, invites (done)

- **Sign-in** is an email address or a US phone number plus a 6-digit code.
  There are no passwords. Codes expire; too many requests get refused.
- **Nobody can create an account on their own.** New accounts exist only
  through a code, and the auth server itself has sign-up switched off.
- **Staff invite code**: the owner (and later managers) make one per person. It
  binds that person to one location and one role. Single use, expires in three
  days, stored only as a hash. (Owner-made invites in the app come in Part 5;
  today the dev seed and a command make them.)
- **Salon setup code**: you make it. Whoever uses it creates a brand-new salon
  with its first location and becomes its owner, with default services and
  rules copied from Heavenly's starting point. Single use, expires in 14 days.
- A code is never attached to someone who is already signed in; the page says
  so and offers sign-out. This is what stops a shared iPad from handing a role
  to the wrong person.
- **Language**: one button switches every word between English and
  Vietnamese. The choice is remembered on that device.

### Part 3. Status and the points ledger (done)

- **The technician's day** has six states: off, checked in, available, in
  service, break, out. The technician moves between them from `/me` with big
  buttons; only the moves that make sense from the current state are shown, and
  the server refuses any other move.
- **Check-in** records the time (server clock, never the phone's) and, if the
  location has a geofence and the rules require being on site, checks the
  phone's position against it on the server. Outside the fence, the check-in is
  refused with the distance.
- **Ready** means the technician tapped through the readiness checklist; the
  time is kept on the shift.
- **Points** are posted as ledger rows: +1 for a standard service, +0.5 for a
  fill or full set, −0.5 for an appointment, +1 for a deny, +1 for being out
  over the limit, manual adjustments with a reason. The day's total is the sum
  of the rows for that shift. Nothing stores a total.
- **The audit log** gets a row for every status move and every points posting:
  who, when, before, after, and the reason when one was required. The database
  refuses to update or delete audit rows, for every role including the
  operator's.
- **The admin board** lists checked-in technicians in queue order: lowest
  points first, then earlier check-in. The colour bar and the word say the
  status; the timer says how long.

### Part 4. The engine and the first demo (done)

Walk-in entry on the iPad, the engine that picks the first eligible technician
in queue order, the call on that technician's phone (the web `/me` screen until
the Expo app lands), accept or deny with the penalty shown first, the visit,
points posted when the technician taps Finished, and the board refreshing every
five seconds. The database enforces "one open call per technician" so two
receptionists cannot double-book. A called technician must answer: Break, Out
and Check out wait for the call. This is what Phu sees on Dec 4.

### Part 5. The rule builder, the staff screen, attention (done)

- **Rules** (owner only): every number the engine uses (points, points per
  service category, the appointment discount, late tiers, the deny penalty, the
  out-over timer, buffers, the attention timers) is a field. A save is checked
  first (text where a number goes, negative minutes, points that are not whole
  or half are refused) and becomes a new version with who saved it and why. The
  database refuses to edit or delete a version. The engine runs the newest
  version that passes the checks, so a bad row can never stall the floor. A
  preview re-sorts today's board under the typed rules without saving. The two
  values Phu has not decided show as "not set".
- **Staff** (owner and manager): invite codes made from the screen, role changes
  (the only way a role changes), archive and restore with a reason. Nothing is
  deleted; every change is in the audit log; a manager acts only at their own
  location.
- **Attention** (Duong, Nov 4): a call nobody answers for the rule's minutes
  (15) is flagged on the board for the desk and the manager, with "Clear the
  call" (no penalty, the visit waits again). The board shows an estimated wait
  for a new customer, worked out by simulating the queue (free technicians,
  services in progress and their minutes, visits waiting), and flags a long wait
  at the rule's minutes (30). The receptionist or manager can switch on a
  long-wait notice for customers; the kiosk (Part 9) will show it.

### Part 6. Eligibility, restrictions, overrides (done)

- **Skills and restrictions** (owner and manager, Staff → Skills and
  restrictions): skills are per service category ("does every service", or
  only the ticked categories); tags are free words for the desk; the five
  restrictions from the design doc (no male clients, no kids, client must be
  at least N, not for two-at-once visits, and a free-text one the desk sees
  but the engine does not apply). A new technician does everything with no
  restrictions. Every save is checked first and goes to the audit log with
  before and after.
- **Client attributes at the desk** (Duong, Nov 4): the receptionist can say
  whether the client is a woman or a man, a kid and about how old, whether two
  services are wanted at the same time (two linked visits, two technicians),
  and optionally a name and phone. The phone is the key a later Fresha import
  will match on. The name and phone never reach a technician's phone or the
  audit log; the attributes the engine used (woman or man, kid, age) are kept
  on the visit and in its audit row, and a technician's own call never shows
  them.
- **The engine's filters**, in order, each with its own test: status, no open
  call, no visit already in progress (the double-booking guard), skills,
  restrictions, no appointment inside the buffer (the table exists now; Part 7
  fills it). After "Call next" the desk sees who was passed over and why
  ("Linh: no kids", "Mai: does not do full_set"); when nobody can take it,
  the whole list. The rule builder's "skills: must match / preferred /
  ignored", "honor restrictions", "appointment buffer" and "a requested
  technician skips the queue" are now read.
- **Timers**: out longer than the rule's minutes (60) posts the penalty once,
  whether a manager is looking or not (the board and the phone sweep on load,
  and coming back posts it too); the board lists who is on break or out and
  for how long; the phone shows the technician their own timer and the
  penalty. A late check-in posts the tier's start points once per day (the
  60-minute tier stays unset until Phu decides). A shift left open from an
  earlier day is checked out when the board loads, unless the technician is in
  service or has an open call.
- **Overrides** (owner and manager, the Overrides tab): move an open visit to
  another technician, with "count it as a deny" and "override skills,
  restrictions and the appointment buffer" switches (status is never
  overridden: a technician on break stays on break); excuse any of today's
  penalties once (a reversing ledger row; a deny also marks its call); adjust a
  technician's points by half steps. Every one needs a reason, which goes to
  the audit log only (the ledger the floor can read carries a fixed word);
  nobody can excuse or adjust their own points; a manager at one location
  cannot touch another.

### Part 7. Appointments and the second location

Appointments arrive from Fresha through a calendar feed and show on the board
against the technician they are booked with. "Client arrived" turns one into a
visit with the −0.5 discount. The receptionist can also tap an appointment in by
hand. The second Heavenly location is configured.

### Part 8. The audit log viewer and reports

Filter the log by technician and date, export CSV, the queue snapshot on every
call ("who was ahead and why, at that second"), the daily turn report, an
end-of-day summary to the owner.

### Part 9. The customer kiosk

A second iPad at the desk. Phone and name, the services, who it is for, a few
preferences, one question per screen, English or Vietnamese. It creates a
waiting visit that the receptionist confirms with one tap.

### Part 10. Hardening, the App Store, handoff

Error handling, offline behaviour on the iPad, Vietnamese checked with the
staff, accessibility, Terms and Privacy pages, the full security review, App
Store (unlisted) submission, training, and a one-page guide in both languages.
**Also here: the compliance pass** (refund policy, terms, liability wording,
employee tracking consent, data retention) with a Florida attorney before a
second salon pays. See `../13-Turn-System-GRC-Scoping.md`.

## How the pieces talk to each other

```
iPhone (/me, later the app)     iPad (/admin, later kiosk)     laptop (/admin)
            \                          |                          /
             \                         |                         /
              -------------- the web server (Next.js) -----------
               checks the session, the membership, the role, the rate limit,
               then calls the status machine / invites / setup / engine
                                       |
                              Postgres (Supabase)
                 row-level security, append-only audit, one open call per tech
```

Phones and iPads never talk to the database directly for anything that
changes data. They can read what their salon is allowed to see; everything else
is the server's job.

## Where things live

- `apps/web`: every screen and every server action.
- `packages/db`: the schema, the migrations, the status machine, invites,
  setup codes, the rate limiter, the seeds. Shared by the web app and, later,
  the phone app.
- `supabase/`: local stack config and the sign-in email template.
- `scripts/`: `npm run up` and the secrets scan.
- `TESTING.md`: how to try it by hand. `design/DESIGN.md`: why it looks the way
  it does. `verification/refuted.md`: review findings that were checked and
  found not to be bugs.

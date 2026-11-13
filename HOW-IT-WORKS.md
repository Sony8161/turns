# How the turn system works

What each part is for, what it does today, and what it is meant to do when
finished. Plain language; the code is the detail. Design source:
`../Turn System Design Doc.md`. Updated 2026-11-13 after v0.17.0.

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

### Part 7. Appointments and the second location (done)

- **Appointments screen** (`/admin/appointments`, every desk role): today and
  the next week, each with its technician, the client's name when known, and
  whether it came from the calendar or the desk. The desk can add one by hand
  (technician, start, minutes, optional name), change or cancel a hand-entered
  one; a calendar row is changed in the calendar. Every change is in the audit
  log with times and technicians, never the client's name.
- **Client arrived**: pick the services and tap it. The appointment becomes a
  visit with source "appointment" for the technician it was booked with, and
  that technician is called at once. When they cannot take it (on break, busy)
  the visit waits on the board for them; whether an appointment may fall back
  to the line is Phu's call, like a request. At Finished the rules' appointment
  discount applies: an appointment full set posts 0, and the board shows **00**.
  At equal points, 00 sorts after a true 0 (the rule builder's queue order). An
  appointment whose client has arrived no longer holds its technician out of
  the queue.
- **Calendar feed**: Fresha gives one calendar link per team member, so the
  owner pastes a link per technician on the same screen. The link is a secret:
  no app role can read the table, the audit log and the screen get only its
  host and last four characters, and the input is never pre-filled. The server
  fetches it only over https, refuses any address that is not on the public
  internet (checked after DNS, with the connection pinned to the checked
  address, on every redirect), at most 2 MB, 10 seconds. Events from 12 hours
  ago to a month ahead are kept in step: new ones added, moved ones moved,
  dropped or cancelled ones cancelled; one that already became a visit is left
  alone. A scheduler calls `/api/feeds/poll` every 15 minutes with a secret
  (Fresha itself lags up to 15); the desk has "Sync now" (once a minute).
- **On the board**: "Calendar last synced", the next appointments, and a red
  line when a calendar failed ("tell the owner" for the desk) or has not
  synced for 45 minutes. A failed poll also writes an audit row.
- **Second location**: `db:add-location` (operator) creates it with the
  starting menu and rules, and makes the salon's owners owners there. Someone
  at two locations gets a Location switch in the admin bar; it only reorders
  their own memberships. Visits and calls are now read per location, like the
  Part 6 tables. The technician's phone lists their own coming appointments,
  times only.
- **Not yet checked**: what Heavenly's real Fresha feed contains (client names
  or only times, and its lag). Fifteen minutes on Phu's Fresha account.

### Part 8. The audit log viewer and reports (done)

This is the part that settles "who got called before whom".

- **The log** (Log, owners and managers). Every change the app makes writes one
  row to `audit_log`, which nobody can edit or delete, not even the server
  key. The Log screen reads it for one location: pick dates, a technician, an
  event. A call row opens the queue as it stood at that second, with everyone's
  points and status and why the ones ahead were passed over. Managers see their
  own location only.
- **CSV** (owner only). Downloads exactly the rows on screen. Spreadsheet
  formulas in a cell are defused, so a name typed as `=…` stays text.
- **Reports** (owners and managers). One day per technician: when they came and
  left, calls, accepts, denies, how fast they answered, visits, and points
  split by reason. Below it, the last 7 days of overrides by each owner or
  manager and desk entries by each receptionist, so a sudden rise shows.
- **End of day.** After a day ends, its summary is written once to
  `daily_summaries` and never changed. A nightly job writes it for every
  location; the owner's board shows yesterday's line and a link. Push to the
  owner's phone comes with the phone app.
- Nothing here shows a client's name or phone.

### Part 9. The customer kiosk (done)

A second iPad at the front, so a walk-in can check in when the desk is busy.

- **What the customer sees** (`/kiosk`). Four questions, one per screen, in
  English or Vietnamese: first name and an optional phone; the services; who
  it is for (adult or kid and age, woman or man or skip); a technician or
  anyone. Then "Please take a seat. The front desk will call your name." The
  screen wipes itself after each customer and after a minute untouched, so
  the next person sees nothing. It never shows the board, points or anyone
  else.
- **What the desk sees.** The check-in lands in the waiting list marked "Kiosk
  check-in, confirm before calling" with the typed first name. **Confirm**
  lets the engine call as usual; **Not here** cancels it. Nobody can be
  called before the confirm: the engine and the database both refuse.
- **How the iPad is trusted.** An owner or manager registers it in **Admin →
  Kiosk** and gets a pairing code that works once, for 15 minutes. The iPad
  keeps a random key in a cookie; the database keeps only a fingerprint of it.
  That key can do one thing: add a waiting customer at that one location. A
  lost iPad is switched off with **Revoke**. The kiosk never runs with a staff
  sign-in on the same browser.
- **Nothing typed is trusted until the desk says so** (v0.9.1). A phone typed
  on the kiosk waits on the visit; only **Confirm** links it to a client (a
  known one is never changed, a new one gets the typed name). A technician
  picked on the kiosk is only a wish until the desk presses **Confirm**;
  **Confirm, no request** sends the visit to the line instead.
- **Getting out of it.** Tap the salon name five times, then the 4-digit PIN
  the owner set: staff sign-in. The PIN opens a 2-minute window; without it,
  the sign-in page sends a paired iPad back to the kiosk. Staff signed in on a
  kiosk iPad are signed out after 5 minutes without a tap. A paired
  receptionist iPad has a **Kiosk mode** button to go the other way.
- **Abuse limits.** A phone can check in 3 times in 30 minutes, a kiosk 30
  times in 10 minutes; PIN and code guesses are capped. The answer is the same
  whether or not the phone is already known, so the kiosk cannot be used to
  look people up.

### Part 10. Hardening (done for the web app)

- **Secrets audit (SEC-001).** The code, all of git history and the files a
  browser downloads were scanned: clean. `npm run bundle:scan` fails if a key,
  a database address or a source map ever reaches the browser. Report:
  `docs/security/SEC-001-report.md`.
- **CI.** `.github/workflows/ci.yml` runs every check on each push: format,
  types, lint, both secret scans, gitleaks over the history, all tests against
  the same Postgres the local stack uses, the build and the bundle scan. It
  runs once the code is on GitHub.
- **When something breaks.** A missing page says so in both languages. A page
  that fails shows "Something went wrong on our side" with a reference number
  that matches the server log, never the error itself. A button whose action
  fails for an unplanned reason answers "try again" instead of an error page,
  on the desk, the technician phone and the kiosk.
- **Offline iPad.** When the Wi-Fi drops, a red bar says so, and every button
  is blocked, not queued: a tap does nothing and is not sent later, so nothing
  half-saves. **Try again** reloads once it is back.
- **Accessibility.** Error messages are announced to screen readers; every
  repeated button on the waiting list says which customer it is for; keyboard
  focus shows on the kiosk's big choice buttons and moves to each new kiosk
  question; small grey text is dark enough to read.
- **Security headers.** Every page has a strict Content Security Policy with
  a fresh random value per request, so only the app's own scripts run; no
  framing, no plugins, forms post only to the app; HTTPS pinned in production.
- **Terms and Privacy** (`/terms`, `/privacy`): drafts marked "needs attorney
  review". They describe what the app does; every legal term is a bracket for
  the attorney.

Still to come: Vietnamese checked with two techs and the front desk, the full
security run with the other scanners, browser tests for every role, the App
Store (unlisted), training and the one-page guide. **The compliance pass**
(refund policy, terms, liability wording, employee tracking consent, data
retention) with a Florida attorney comes before a second salon pays. See
`../13-Turn-System-GRC-Scoping.md`.

### Connect Fresha (v0.11.0)

Fresha has no open API, so each technician's Fresha calendar export link is
the way appointments come in. Adding the links is part of onboarding: the
owner's setup ends with an optional "Connect Fresha calendars" step (also on
Appointments), and a technician who joins is offered "Add your Fresha
calendar". Every link is tested before it is saved: the server fetches it the
same safe way the poll does, counts the coming appointments, reads the
calendar's name and suggests which technician it belongs to; the owner
decides. Only Fresha's export host is accepted from these screens. Saving runs
the first sync at once. The link stays on the server; screens show only
"connected, last synced" or a red "sync failing". The links are read-only:
nothing is written back to Fresha.

### Demo day and the tech board (v0.12.0)

`npm run up -- -Demo` loads a salon morning built by the engine itself, so the
board shows the numbers the engine really computes, and writes a cheat sheet
(`docs/DEMO-EXPECTED.md`) of what the next calls should do and why; a test keeps
the sheet honest. The admin board now has a card per technician: turn number,
points, what they do and do not take, the next appointment, who is in the
chair, and "Why this order?" with every ledger line behind the total and the
tie-break against the next tech.

### Tech settings, rule templates, clients (v0.13.0)

Each technician has a settings page: today's status and points (with a
reason), and what they do and do not take. Owners and managers use it, and
receptionists too unless the owner switches that off; technicians never.
The rule builder starts from a template (the Heavenly standard, or a simple
rotation) and previews today's line now and under the new rules side by side
before anything is saved. Clients have first and last names; the desk finds
a client by phone or name on Clients. The Fresha client list is imported
before launch (backlog).

### Skill levels, asking a higher level, split visits (v0.14.0)

Levels are a ladder (regular polish, gel, dip, acrylic) kept in
`packages/db/src/levels.ts`. A technician's level ticks services; the ticks
(`technician_services`) are what the engine matches a visit against. A
service lists the levels that get it by turn (`services.turn_levels`). In
`queueFor` (engine.ts) the level rule is checked last, so a technician whose
only reason is `not_by_turn` is exactly one the desk may ask: `deskCall` with
kind `offer` writes that call, and `respondToCall` posts no points when an
offer or a desk pick is declined. A service marked `desk_picks` makes
`callNext` answer `desk_picks`; the desk uses `deskCall` with kind
`desk_pick`. `deskOptions` gives the desk the names for both. A technician
accepting a visit with several services may pass `keepServiceIds`; the rest
move to a new visit linked by `split_from_visit_id` with the same arrival
time. Nothing here changes how points are worked out: a visit still posts
the points of its own services when it is finished.

### Rule answers (v0.15.0)

Five answers from Duong, each a setting in `rule_config` (rules.ts):

- `points.combined_fill_full_cap` is `null` for Heavenly: a visit's services
  simply add up (`visitPointsUnder`).
- `queue.sort` has a new key, `double_zero_last`: at zero points only, a
  technician whose last visit was an appointment sorts after a true 0
  (`compareQueue`, now in rules.ts so the board, the engine and the rule
  preview share it). `had_appointment_last` (every score) still exists.
- `penalties.deny_excused_reasons` lists the deny reasons that post nothing.
  `respondToCall` marks such a call `auto_excused`; `queueFor` then skips that
  technician for that visit (`said_no`).
- `attention.request_wait_min`: `requestHolds` (requests.ts) lists the waiting
  visits whose requested or booked technician cannot be called, with her
  status and next appointment. `keepWaiting`, `bookForLater` and `sendByTurn`
  are the desk's three answers. The engine itself never falls back.
- A visit of several services: `queueFor` calls a technician eligible when she
  does at least one of them that is hers by turn, and records what she takes.
  On accept she keeps only services she does; the rest becomes a linked visit
  (`split_from_visit_id`) that `callNext` refuses (`waits_for_first_part`)
  until the first part is finished. `openCallFor` and `waitingVisits` return
  the slip: the earlier parts and who did them.

The kiosk's technician list (`kioskMenu`, `techniciansFor` in kiosk.ts) is the
technicians on shift with the services each one does; the screen narrows it to
the chosen services and `kioskCheckIn` refuses anyone outside it.

### Fixes, groups, client left, need help (v0.16.0)

From Duong's list of 2026-11-12. Every rule is a setting; Heavenly's values in brackets.

- **Requests** count as a full normal turn (multiplier 1). A manager can still adjust points by hand.
- **Points per service** (Rules → "Points per service"): a service's own points come before its category's. The starting menu has Polish change (0) and Gel polish change (1).
- **Nail fix / repair** (`packages/db/src/fixes.ts`): free (0 points), desk only, never on the kiosk, on a visit of its own. When it is ticked, the desk looks the client up by phone or name and sees their finished visits inside the fix window [14 days; 7 is the other preset]: date, services, technician. Picking one links the fix to it (and to that client). A receptionist's fix waits for a manager or owner [setting on]: `visits.needs_approval`, the same pending pattern as an unconfirmed kiosk visit, and a database trigger refuses a call for it. A manager's or owner's fix is approved as it is entered. No visit in the window is a warning, not a stop. The desk picks the technician (a fix is a desk-pick service); the one who did the original work is listed first, marked. Saying no is never a penalty. A fix never moves anyone in line (it does not turn a 00 into a 0). Reports → "Fixes, by the technician who did the original work". Log: `fix_entered`, `fix_approved`, `fix_declined`.
- **Groups** (`packages/db/src/party.ts`, `kioskGroupCheckIn`): the kiosk starts with "Just me" or "We're a group"; the desk's New walk-in has "One client" or "A group". People are added one at a time (first name, optional last name, own services, technician and note) up to the rules' group size [8], then one submit. Each person is their own visit, linked by `visits.party_id` (not `group_id`, which links one client's same-time visits), and their own client: at the desk at once, from the kiosk only when the desk confirms. The desk row says "Group of N"; a kiosk group is confirmed all at once (**Confirm all N**) or one by one. Each visit is called by turn on its own. On the kiosk the group has one optional phone (kept with the first person) and counts once against the per-phone limit; the answer never says whether the phone is known.
- **Client left** (`clientLeft` in the engine): on a visit that was called but has not started, the desk or the called technician marks it. The call closes as `client_left`, the visit as `left`, no points post, and the technician is still available in the same place. Log: `client_left`. Visits in service are not affected.
- **Need help** (`packages/db/src/help.ts`, table `help_requests`): a button on the technician's phone with an optional short reason (80 characters). The desk board's "Needs attention" shows "Mai needs help" and the time waiting until someone presses **On my way**. One open request per technician, six taps an hour. Log: `help_requested`, `help_acknowledged` (whether there was a reason, never its text). The board's 5-second refresh shows it; no phone push.
- **Owners and managers** do not do nails: only a technician membership makes a technician row, so they are never in the rotation (a test holds this).
- Migration 0027 (`help_requests`, the new visit columns, `services.is_fix`, the `left` and `client_left` values, the approval trigger).

### First-week gaps (v0.17.0)

Release 1 of `../17-Next-Build-Plan.md`. Every rule is a setting
(`fairness` and `closing` in `rule_config`); Heavenly's values in brackets.

- **The desk acts for a tech** (`packages/db/src/act-for.ts`):
  `deskAnswerCall` and `deskFinishVisit` check the role and location
  (`mayActForTechnicians`: owners and managers always, receptionists while
  `locations.receptionist_acts_for_technicians` is on [on]) and then call the
  engine's own `respondToCall` and `finishVisit` with `onBehalf`, so the
  points are exactly those of her phone. The call keeps `answered_by`, the
  visit `finished_by`, and the audit row has the desk person as actor and
  `after.actedFor`. `actedForToday` gives her phone today's lines. The desk
  shows Accept and Finish only on her current visit; Deny is under More.
- **Day-end close-out** (`packages/db/src/day-end.ts`, `closeOutDay`), called
  by `sweepFloor` before anything else and so by every board and phone load,
  `ensureDailySummary` and the nightly `summarizeYesterdayEverywhere`. It
  closes what an earlier local day left open: waiting, called, kiosk and
  pending visits as `cancelled` with `close_reason = 'day_end'`; an
  in-service visit finished with its points on the shift of the day it
  started, `auto_finished` [`closing.day_end_in_service = finish`]; its open
  calls as `expired`; help requests. The sweep then checks out every shift
  from an earlier day. Audit rows carry `after.forDay`, which the daily report
  counts (`closedAtDayEnd`).
- **Walk-outs and no-shows**: `leftWithoutService` (engine) closes a waiting
  visit as `left` with `close_reason = 'walked_out'`; `markNoShow`
  (appointments) sets `no_show_at` once the start plus
  `closing.no_show_after_min` [0] has passed, and the queue, the board and the
  phone stop counting that appointment. Neither posts anything. The daily
  report counts walk-outs, client-left and no-shows; `clientDetail` counts a
  client's no-shows (`appointments.client_id`).
- **Fairness**: `clientLeft` from the tech's phone, under
  `fairness.client_left_by_tech = ask_desk` [ask_desk], only marks the open
  call (`left_claimed_at`); the desk answers with `clientLeft` (closes,
  `technician_confirmed`) or `clientHere` (`left_claim_outcome =
client_here`). `freeDeniesToday` counts her excused denies since check-in:
  the tech card's badge at `fairness.free_deny_flag` [3], and
  `fairness.free_deny_daily_limit` [none] in `respondToCall`.
  `fairnessReport` (reports.ts) builds the table from the calls, the ledger,
  the visits, the audit log and the call snapshots.
- Review #1: `staffSetStatus` refuses a tech in service. Review #12:
  `askForHelp` needs her on shift. Migration 0028.

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

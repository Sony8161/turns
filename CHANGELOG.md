# Changelog

One version per delivered part. Tags point at the commits.

## v0.17.1, 2026-11-13: Review fixes

Release 2 of `17-Next-Build-Plan.md`: findings #4 to #11 of the independent
review of v0.11.0 to v0.16.1, the permissions mismatch, and the parts the
review had not reached. Started by an earlier run that was cut off; its work
was saved as a WIP commit, checked and finished here. Heavenly's defaults
below; plain words, EN/VI, one new setting in view (Appointments).

- **Client list harvesting (review #4).** One per-person budget (60 in 5
  minutes, the same key search used since v0.13.0) now counts every client
  search, every client page, every fix lookup and every **Show** tap. A search
  needs at least 4 digits of a phone or 3 letters of a name (a two-letter
  surname is searched with the first name: "ngoc vo"); a search too short
  costs nothing. Still at most 25 results. The search list never shows a
  whole phone. On a client's page owners and managers see the full number; a
  receptionist sees "(•••) •••-0199" and taps **Show**: counted against her
  budget and written to the log as "Client phone shown in full" with no
  number in it. The results list no longer prefetches client pages, so only a
  real tap counts.
- **Kiosk groups (review #5).** Every person in a group counts against the
  device limit (30 per 10 minutes) and the address limit; the group's one
  phone still counts once (Duong, v0.16.0). **Confirm all** makes a client
  row only for the person with the group's phone, exactly like a single
  check-in without a phone. The limits moved to `@turn/db/kiosk`.
- **A technician's own Fresha link (review #6).** New owner setting on
  Appointments, "When a technician adds her own Fresha calendar": **The owner
  or a manager approves it first** (Heavenly), **Only if the calendar has her
  name**, or **Use it right away** (the v0.11.0 way). While a link waits it is
  never fetched, so it brings in nothing and holds her out of nothing; her
  phone says "Waiting for the owner or a manager to approve". Owners and
  managers see "Calendar links to approve" on Appointments (and a line on the
  board) with **Approve** (it syncs at once) and **Decline** (the link is
  removed; she can add it again). A new link from her waits again; a link the
  owner pastes never waits. Audited (set, approved, declined, the setting),
  never with the link or its hint.
- **Every redirect hop is checked (review #7).** The link test and the poll
  check the Fresha host list on the saved link and on every redirect. A link
  the owner pasted under "Other calendar link" (Part 7) keeps the
  public-address check on every hop, as before.
- **Reassign refuses a closed visit (review #8):** one the client left after
  the call, a walk-out, or one closed at day end.
- **One lock order (review #9):** visit first, then its call, then the
  technician, in `respondToCall` (the one that differed), `clientLeft`,
  `expireCall`, `reassignVisit`, the day-end close-out and the desk's act-for.
  A test runs the risky pairs at the same moment three times each and expects
  no error; with the old order it hit 13 deadlocks.
- **A fix is checked on the server (review #10):** it must point at a
  completed visit at this location that is not itself a fix, inside the fix
  window, whatever the screen sent.
- **A fix is always 0 points (review #11)**, whatever the rules say, at
  entry, at Finish and at the day-end close-out. The rules page shows "0
  points, always" for the fix instead of a box.
- **One permissions table (the mismatch).** `@turn/db/permissions` is the
  table; the web app re-exports it. Receptionists' edit techs, adjust points
  and act for a tech are in it as "the most she may have", and
  `allowedAt` adds the owner's switches on the server next to every write.
  Skill levels are their own right (`manage_levels`, owners and managers), so
  the receptionist switch never opens the levels pages.
- **Read-only checks, fixed what was found:** a new index for visits by day
  (`visits_location_arrived`, used by reports, fairness and the fix lookup)
  next to the run's two (`visits_assigned_open`, `turn_calls_location_called`);
  every server action since v0.11.0 is `guarded()` with a permission check;
  the free-no badge on the tech cards is the manager's flag and now shows to
  owners and managers only, like the fairness table; Reports (fixes and
  fairness) is owners and managers at their own location; the clock-change
  tests now cover the out-over penalty in the sweep and the tech card's
  appointment hold.
- **Small things:** "1 visit" on the client pages; a call just made says
  "Linh called just now" for the first minute, not "no answer for 0:00";
  **Pick a tech** shows a tech held for her appointment as "Held: 2:30 PM
  appt", not "available"; Admin → Kiosk says the PIN hint once, not under
  both PIN boxes.
- **Demo day** adds Vân's own calendar link waiting for approval.
  `docs/DEMO-EXPECTED.md` regenerated (Pick a tech: "held for her
  appointment").
- Database: migration 0029 (`calendar_feeds.needs_approval`, `approved_by`,
  `approved_at`; `locations.tech_calendar_links` with its check; three
  indexes). New module `permissions.ts`.

Tests: 467 database (48 new in `v0171.test.ts`; `demo`, `fresha`, `v013` and `v016` follow the new rules), 202 web (22 new).

Readings taken where the brief left room (say if any is wrong):

- "3 characters of name" counts letters (spaces and dots do not count);
  "4 digits" counts digits in a phone-shaped search.
- The budget is shared by search, client page, fix lookup and Show, 60 in 5
  minutes per person, as search had.
- The owner chooses `tech_calendar_links` (it is a salon setting), on
  Appointments next to Connect Fresha; managers approve links but do not
  change the setting.
- `name_must_match` reads the calendar when she saves and needs her name,
  and nobody else's, in the calendar name (the owner card's suggestion rule).
- Approving syncs the link at once; declining removes it, as the owner's
  Disconnect does.
- The poll keeps the public-address check (not the Fresha list) for a link
  the owner pasted under "Other calendar link"; every Fresha link, and every
  link a technician saved, is held to the list on every hop.
- The free-no badge is shown to owners and managers only (the plan calls it
  the manager's flag); receptionists still see the points.

## v0.17.0, 2026-11-13: First-week gaps

Release 1 of `17-Next-Build-Plan.md`, with review findings #1, #12 and #13.
Every new behaviour is a setting with Heavenly's default; EN/VI throughout;
readable on the iPad (landscape and portrait) and a phone. Built to Duong's
standing note "easy to use for everyone": the main next step is a button,
anything less common sits under the row's **More**, plain words, no new
confirm dialogs.

- **Changes v0.16.0: a technician's "Client left" now asks the desk.** Under
  Rules → "Client left" (Heavenly: "The front desk confirms first") her tap
  no longer closes the visit. The call stays open and the desk row says
  "Linh says the client left" with **Yes, the client left** (closes it: no
  points, she keeps her place) and **The client is here** (her phone then
  says so, and she accepts or denies as usual). The desk's own **Client
  left** still closes at once. "It closes right away" is the v0.16.0 way.
- **The desk acts for a tech** whose phone is not at hand. On her current
  visit only: **Accept for Linh** on a called row and **Finish for Hoa** on a
  row in service, and the same two on her tech card; **Deny for Linh** (with a
  reason, the same points as her phone) under the row's **More**. Accept is
  the start: there is no separate start step. Owners and managers always;
  receptionists while the owner leaves Staff → "Receptionists can accept, deny
  and finish for a technician" on (default on; a switch of its own, next to
  the one for receptionist edits). Her phone lists today's "Accepted for you
  by Hạnh, 2:14 PM" lines. The log names the desk person as "By" and the tech
  as "Done for". New permission `act_for_technician`.
- **Day-end close-out.** Whatever an earlier local day left open is closed by
  the floor sweep (every board and phone load) and by the nightly job, before
  the end-of-day summary is written: waiting, called, unconfirmed kiosk,
  pending-fix, held second parts and request holds close as "closed at day
  end" (no points, no penalty); a visit still in service is finished with its
  points on that day's shift, marked auto-finished (Rules → Advanced: or close
  it with no points); open calls expire with no penalty; help requests close;
  shifts check out. Every change is in the log with the day it belonged to,
  and the summary and Reports list the counts ("Closed at day end: …"); the
  owner's yesterday line adds "Closed at day end: N". Tests: a day-two
  test, and both 2026 clock-change days in the salon's zone (the reset, the
  late penalty, the out-over penalty and the appointment hold).
- **Left without service.** **More** → **Left without service** on any
  waiting row, a kiosk check-in, a fix waiting for approval and a held second
  part included. No points, no penalty, nobody moves. Reports counts walk-outs
  apart from clients who left after the call.
- **No-show.** Appointments → **More** → **No-show**, once the start time
  (plus Rules → Advanced minutes, Heavenly 0) has passed. The tech is free
  again at once; nobody's points change. The client's page counts no-shows
  (an appointment booked for a known client: "Book for later" now keeps the
  client). A client marked a no-show who comes after all can still be
  "Client arrived", and the mark is cleared.
- **Free-deny badge.** A small badge on the tech card, "Free no today: 3", at Rules → Advanced "Badge after this many free no's in a day"
  (Heavenly 3; 0 = never). A hard daily limit is a separate setting, blank
  for Heavenly (no limit); with one set, the next free no costs the deny
  penalty and the log says so.
- **Fairness table** in Reports (owner and manager), the 7 days up to the
  chosen day: tech, visits, points and "Worth a look" (free no's, client left
  hers / confirmed, fixes on her work); **Show details** opens penalty and free
  no's, no's when asked, splits, client left, fixes and skips by reason.
  Counts only, no client names.
- **Review #1:** the desk can no longer change the status of a tech who is in
  service ("She is with a client. Finish the visit first"); that used to leave
  her visit open for good.
- **Review #12:** Need help needs her on shift, and open requests close at day
  end, so yesterday's never swallows today's.
- **Leftovers:** "1 point", not "1 points" (log queue, tech settings); the slip
  says "Linh is doing Basic pedicure" until her part is finished; Admin → Kiosk
  shows the code's real expiry ("works until …"), and the kiosk's own pairing
  screen no longer promises 15 minutes; Pick a tech says "called" for a tech
  with an open call.
- **Rules:** one new choice in view ("When a technician taps Client left"),
  the rest under **Advanced**.
- **Demo day** adds: Linh's Client left waiting for the desk (Sara Kim), Hạnh
  accepted Kim Le for Hoa, Thảo's three free no's and badge, two walk-outs,
  Kim Le's no-show, and yesterday's leftovers (a client still with Tâm, a
  walk-in still waiting, Tâm's help request) closed by the morning sweep.
  `docs/DEMO-EXPECTED.md` regenerated; its drift test passes.
- Database: migration 0028 (`visits.close_reason`, `auto_finished`,
  `finished_by`; `turn_calls.answered_by`, `left_claimed_at`,
  `left_claim_outcome`; `appointments.no_show_at`, `no_show_by`, `client_id`;
  `locations.receptionist_acts_for_technicians`; checks on the new values). No
  new tables. New modules `act-for.ts`, `day-end.ts`. Rules sections
  `fairness` and `closing` (a config saved before v0.17.0 still validates).

Tests: 419 database (35 new: `v017.test.ts` 34 and the demo), 180 web (10 new).

Readings taken where the brief left room (say if any is wrong):

- "Following the existing owner toggle": a second switch of the same kind,
  not the same switch, so the owner can allow edits but not acting for, or the
  reverse. Both default on.
- "Start" for a tech: accepting starts the service, as on her phone; there is
  no separate start step to add.
- The desk can deny for her under the same rules, including the reasons that
  are free; a free no the desk taps counts toward her badge.
- A visit still in service at day end is finished with its points (Heavenly);
  the alternative (close with no points) is under Advanced.
- Day end is the salon's local midnight, as the points reset already was.
- No-show is offered from the start time (Heavenly 0 minutes after).
- "Skips by reason" counts the techs ahead of the one called who were passed
  over, by the first reason that applied (status reasons included).
- The fairness table's "Worth a look" shows free no's, client left and fixes;
  penalty no's are in the details (they already cost her points).
- The end-of-day summary lists counts per kind, not each item.

## v0.16.1, 2026-11-12: Fixes from demo filming

Four things the demo video showed (Duong, 2026-11-12, "fix these").

- **Waiting rows no longer squash.** The client info on a desk/owner row keeps
  a usable width (16rem) and wide actions (Approve fix / Decline fix, Confirm
  all 3, the open "Ask a higher-level tech" box) wrap onto their own line,
  right-aligned. Checked at iPad landscape (1366) and portrait (1024).
- **The Log reads in words.** Details shows "Client: Jenny K. · Gel manicure",
  technician and service names, "Status: available → break", "Points: 0 → 1",
  "Change: +1", reasons and yes/no, in English and Vietnamese. Raw ids are
  never shown: a visit is resolved to "First L. · services" on the page only
  (`clients.visitLabels`, this location only; owners and managers see the same
  on the board), and anything that can't be resolved is left out or shown as
  "a visit". The audit rows are unchanged, and the CSV keeps its ids exactly
  as before (`fields`); the viewer uses the new `readable` parts.
- **A called technician's phone says so.** The line under her name reads "A
  call is waiting for you" (polish, the colour for a call waiting) instead of
  "You are available". "Answer your call first: Accept or Deny." only shows
  when she taps Break, Out or Check out while the call is open (the server
  already refused those); it is no longer always on screen.
- **The rules preview really is blue.** A name that moves is lapis (#1D4ED8,
  6.7:1 on white, new design token) and bold, with ↑/↓ and the number of
  places, so it never rests on colour alone. The note says so in EN and VI.

Tests: 7 db (`test/v0161.test.ts`), 9 web (`log/readable.test.ts`,
`me/status-line.test.ts`, `rules/form.test.ts`).

## v0.16.0, 2026-11-12: Fixes, groups, client left, need help

From Duong's list of 2026-11-12 (A to I). Every rule is a setting in the rule
builder; the values below are Heavenly's defaults. EN/VI on every new screen,
sized for the iPad.

- **A. A request counts as a full normal turn** (Rules → "A requested visit
  earns": full points, the new default; half and none are still there). A
  manager can still adjust points by hand.
- **B. Points per service.** Rules → "Points per service": a service's own
  points come before its category's (blank = the category's). The starting
  menu gains **Polish change** (0 points) and **Gel polish change** (1), at
  the manicure levels.
- **C. Nail fix / repair.** A new service: free (0 points), desk only (never on
  the kiosk), entered on its own. Ticking it in New walk-in opens "Find the
  visit being fixed": phone or name → the client's finished visits inside the
  fix window (Rules → "Nail fix / repair": 14 days, 7 is the other preset):
  date, services, technician. Picking one links the fix to that visit and
  client. A receptionist's fix waits for a manager or owner (**Approve fix** /
  **Decline fix** on the row; the same pending pattern as an unconfirmed kiosk
  visit, and the database refuses a call for it); a manager's or owner's is
  approved at once. Nothing found in the window is a warning, not a stop. The
  desk picks the technician: the one who did the original work is first,
  marked "did the original work". Saying no is never a penalty. A fix never
  moves anyone in line (a 00 stays 00). Reports → "Fixes, by the technician
  who did the original work". Log: Fix entered, Fix approved, Fix declined.
- **D. Groups.** The kiosk starts with **Just me** or **We're a group**. A
  group adds people one at a time (first name, optional last name, their own
  services, technician and request note), up to 8 (Rules → "Groups"), then one
  submit; one optional phone for the group. Every person is their own visit,
  linked by a new `party_id` (not the same-time `group_id`), and their own
  client (made when the desk confirms). The desk row says "Group of 3";
  **Confirm all 3** or one by one. Each visit is called by turn on its own.
  The desk's New walk-in has the same **One client / A group** choice. A group
  counts once against the per-phone kiosk limit; the answer is the same
  whether or not the phone is known; nothing touches a client until the desk
  confirms.
- **E. Client left.** On a visit that was called but has not started, the desk
  (**Client left** on the row) or the called technician (under her call card)
  marks it: no points, she keeps her place, the call closes as `client_left`
  and the visit as `left`. In the log. Visits in service are unchanged.
- **F. Need help.** A button on the technician's phone with an optional short
  reason. The desk board (owner, manager, receptionist) shows "Mai needs help"
  and the time waiting, in Needs attention, until someone presses **On my
  way**. One open request per technician, six taps an hour, in the log
  (whether there was a reason, never its text). The board's own 5-second
  refresh; no phone push.
- **G. Owners and managers do not do nails.** They never get a technician row,
  so they are not in the rotation; a test now holds this (no code removed).
- **Demo day** adds: Sara Kim called to Linh who left (press Client left), a
  fix for Trang Ho entered by Hạnh waiting for approval, a kiosk group of three
  waiting for Confirm all 3, and Mai's help request. `docs/DEMO-EXPECTED.md`
  regenerated; its drift test passes.
- Database: migration 0027 (`help_requests`; visits `party_id`, `is_fix`,
  `fix_of_visit_id`, `needs_approval`, `approved_by`, `approved_at`,
  `left_at`; `services.is_fix`; the `left` and `client_left` values; the call
  trigger also refuses a fix waiting for approval). New modules `fixes.ts`,
  `party.ts`, `help.ts`. 24 new database tests (`v016.test.ts`, the demo
  test), 9 new web tests.

Readings taken where the answers left room (say if any is wrong):

- The fix window, "a receptionist's fix needs approval" and the group size are
  all settings; Heavenly: 14 days, on, 8.
- A fix goes on a visit of its own; a fix with other services is refused.
- A fix belongs to the client of the visit it fixes, when the desk picked one.
- A free fix never changes a technician's place, including 0 versus 00.
- On the kiosk a group gives one phone, kept with the first person; at the
  desk each person may have a phone. At confirm, each person in a group gets
  their own client row (the first by phone, the others by name); a single
  kiosk check-in without a phone still makes none, as before.
- "Client left" is neither a deny nor an override.
- One open help request per technician; a second tap is the same request.

## v0.15.0, 2026-11-12: Rule answers

From Duong's answers (2026-11-12, 02:00 and 02:05). Every one is a setting in
the rule builder; the values below are Heavenly's defaults.

- **Services in one visit add up.** A gel manicure with an acrylic fill is
  1 + ½ = 1½. The cap that held a visit with a fill or full set to 1 is off for
  Heavenly (Rules → "Cap for a visit with a fill or full set", blank = no cap;
  a salon that wants one types it). Same-time visits are unchanged: still one
  visit per service, each at its own points (how they should count is a
  question for Phu).
- **0, then 00, then everyone else.** The appointment rule now applies only at
  zero: a technician whose last visit was an appointment shows 00 and goes
  after a true 0, a 00 is still ahead of everyone above zero, and above zero
  an appointment makes no difference (the earlier check-in goes first). Rules →
  Queue → "A technician whose last client was an appointment": at zero only /
  at every score (the old rule) / no difference. The rule preview now uses the
  same order as the board.
- **Deny reasons that cost nothing.** "Need a break" and the new "Personal
  reason" excuse themselves: no points, no manager. Every other reason is +1
  unless a manager excuses it. Rules → "Deny reasons that cost nothing" has a
  tick per reason. The technician's phone marks the free reasons "(no points)".
  A technician who said no that way is **not called for that same client
  again** (skip reason `said_no`, in the skipped list and the Log's queue
  snapshot); she keeps her place for everyone else. Audited as `call_denied`
  with `excused: by_rule`; nothing is posted to the ledger, and her tech card
  lists it ("Said no: Need a break (excused by the rules, no points)").
- **The requested or booked technician is busy.** Never a fallback on its own:
  the visit waits for her (as before). New: the desk row shows her status and
  for how long, and her next appointment; after the rules' minutes (Rules →
  Attention → "Flag a client waiting for a requested technician after", 10 for
  Heavenly) the row turns red. Three desk actions, receptionist or manager,
  all in the Log: **Keep waiting** (`request_keep_waiting`; the flag comes
  back after the same minutes), **Book for later** (`request_booked_later`:
  an appointment with her at the time the desk picks, as long as the services
  take; the visit leaves the line), **Send by turn** (`request_sent_by_turn`:
  the request is dropped and the visit goes by turn as a walk-in).
- **A visit of several services goes by turn to the first technician who gets
  at least one of them.** She no longer has to do all of them. If she does
  all: Do all or Split, as before. If she does only some, her phone says "You
  do: … Not yours: …" and she takes her part (she ticks which, if she has time
  for only one). **The rest waits until her part is finished**, then goes by
  turn with the client's original arrival time; the desk row says "Waits until
  Linh finishes her part". This now also holds for a Split by a technician who
  does everything (in v0.14.0 the rest went back at once). The next
  technician's call card and the desk row show an **on-screen slip**: who did
  what before, what is left, and the client's request note. No paper printing
  yet.
- **Kiosk technician step.** Lists only technicians checked in today who do
  every chosen service, with **Anyone** first and chosen by default; only
  "Anyone" when nobody qualifies. Names only. The check-in enforces the same
  list on the server. The woman / man / skip question stays.
- **Fix:** two desks pressing Call next for the same technician at the same
  second: the loser now gets "nobody can be called" instead of a server error
  (it used to reach the database's one-open-call index and throw).
- **Demo day** shows each of these: Hoa's 1½ visit (acrylic fill + spa
  pedicure), Thảo at 0 ahead of Linh at 00, Thảo's "need a break" deny with no
  points, Thu Pham waiting for Hoa with the flag up, Ngoc Vo's dip powder +
  pedicure (Linh takes the pedicure, the dip waits for her), and the kiosk's
  technician list. `docs/DEMO-EXPECTED.md` regenerated; its drift test passes.
- Database: migration 0026 (`turn_calls.auto_excused`,
  `visits.request_ack_at`). New module `packages/db/src/requests.ts`. 24 new
  database tests (`v015.test.ts`), 5 new web tests.

Checked in the browser by Claude on the demo day: the desk hold block (Keep
waiting, Book for later, Send by turn), Ngoc Vo's split (Linh's phone "You
do: Basic pedicure. Not yours: Dip powder", the held dip row "Waits until Linh
finishes her part", then Mai's call card with the slip), the three new
rule-builder controls with Preview, and the kiosk technician list for the
three service sets in `docs/DEMO-EXPECTED.md`. Nothing needed fixing.

Readings taken where the answers left room (say if any is wrong):

- A technician who said no for an excused reason is not called again for
  that same client by turn; a manager can still reassign the visit to her.
- On a visit of several services she may keep any service she does, including
  one that is not her level's by turn (her choice; it costs her the points).
- "Send by turn" makes the visit a walk-in: no appointment discount and no
  request multiplier for whoever takes it.
- "Book for later" takes the client out of the line (the visit is cancelled);
  when they come back the desk presses "Client arrived" on the appointment.
- The 10 minutes before the flag is a guess; it is in the rule builder.

## v0.14.0, 2026-11-12: Skill levels, offer to a higher level, split visits

From Duong's answers (2026-11-12, 01:33).

- **Levels are a ladder:** regular polish, gel, dip, acrylic. Each technician
  has one level, set by an owner or a manager on the technician's page
  (**Level and services**); never a receptionist, never the technician.
  Picking the level ticks every service at or below it; the owner or manager
  then unticks single services (a gel pedicure but not a gel manicure) or
  ticks extras. **The ticks are what the engine uses.** A technician with no
  level set keeps the Part 6 category skills, so nothing changes for a salon
  until it sets levels. Audited as `technician_level_changed`.
- **Each service names the levels that get it by turn** (`/admin/levels`,
  linked from Staff, Rules and a technician's page; owners and managers).
  Starting values: regular manicure to regular polish and gel; gel manicure,
  gel pedicure, gel fill and Gel-X to gel, dip and acrylic; pedicures to
  everyone; dip to dip and acrylic; acrylic to acrylic. Audited as
  `service_levels_changed`. New on the starting menu: Gel pedicure, Dip
  powder, Nail art / design.
- **Calling:** the lowest turn among the technicians the service goes to. A
  higher-level technician whose turn it is, is skipped with **no penalty and
  no change to her place**; the reason (`not_by_turn`, with the service) is in
  the skipped list, in the call's queue snapshot in the Log, and on the cheat
  sheet. A client who asked for her, or booked her, still gets her.
- **Ask a higher-level tech.** When a service waits and a higher-level
  technician is free but held out only by that rule, the desk (receptionist or
  manager) gets "Ask a higher-level tech" under Call next. Her phone says "The
  desk is asking you"; **No, thanks** adds no points; taking it posts the
  normal points. Never automatic. Audited: `offer_sent`, `offer_accepted`,
  `offer_declined`.
- **Visits with two or more services:** the called technician chooses **Do
  all** or **Split**. On a split she ticks what she keeps; the rest goes back
  to the line as a linked visit ("Rest of a split visit") with the client's
  original arrival time, for the next technician it goes to. Each technician
  gets points only for the visit she finishes. Audited: `visit_split`, and the
  choice (`all` or `split`) on the accept. Same-time visits are unchanged
  (they were already one visit per service). How combined points are capped
  or summed is **not** changed: still open with Duong.
- **Services the desk picks the technician for** (a tick per service; on for
  Nail art / design). Never called by turn: the desk row shows **Pick a tech**
  with everyone who does it, their level, turn and status. The picked
  technician may say no without a penalty; points post as normal. Audited:
  `desk_pick_sent`, `desk_pick_declined`.
- **Tech cards** show the level and the services ticked.
- **Demo day:** six technicians at four levels (Tâm does a gel pedicure but
  not a gel manicure); waiting rows now include a nail art visit (desk pick),
  a regular manicure whose next free technician is acrylic level (skip, then
  "Ask a higher-level tech"), and a two-service visit (Do all or Split).
  `docs/DEMO-EXPECTED.md` regenerated; its drift test passes.
- Database: migration 0025 (`skill_level` type, `technicians.skill_level`,
  `services.min_level / turn_levels / desk_picks`, `technician_services`,
  `turn_calls.kind`, `visits.split_from_visit_id`). 25 new tests
  (`levels.test.ts`).

Readings taken where the answers left room (say if any is wrong):

- A visit with several services is called by turn only to a technician who
  does all of them and gets all of them by turn; she then splits if she
  wants. A technician who does only one half is not called for it by turn.
- Gel fill and Gel-X full set are placed at the gel level.
- A declined desk pick, like a declined offer, is never a penalty.
- The rest of a split visit goes by turn as a walk-in: a request or an
  appointment stays with the first technician's part.

## v0.13.0, 2026-11-12: Tech settings, rule templates, client names and search

- **A technician's settings page** (`/admin/staff/<id>`, from "Change this
  technician" on a tech card or Staff). Today: status buttons for them (check
  in, ready, break, out, check out; in service stays the engine's) and a points
  adjustment in half steps with a required reason. Below it, skills, tags and
  restrictions as before. Owners and managers always; **receptionists too,
  unless the owner turns it off** (Staff → "Receptionists can change
  technicians", on by default, audited as `technician_edits_setting`).
  Technicians never: the check is in the database layer next to each write
  (`tech-settings.ts`, `saveProfile`), and the database itself refuses a
  technician writing points, skills, status, the setting or clients (tests).
  Every change is in the Log with who made it, before and after.
- **Make it yours: rule templates** on Rules. "Standard (Heavenly Nails)" and
  "Simple rotation" (every service is 1 turn, appointments count like any
  other visit, no cap, line by turns then check-in) fill the form; the salon's
  attention timers and per-category points are kept. Nothing is saved until
  Save. "Points by price tier" is not offered: services have no prices yet; per
  category points already exist in the rule builder.
- **Preview side by side.** Preview (and a template) shows today's line now
  and under the typed rules next to each other, in the engine's own order (0
  before 00 included); names that move are in blue. Fixed on the way: an
  excused deny now stays cancelled in the preview when the deny penalty
  changes (it used to leave the difference).
- **Clients get a first and last name.** Existing names were split at the
  first space (migration 0024). The kiosk asks first name (required) and last
  name (optional); the desk's walk-in form has both; the desk edits both on the
  client's page. Boards and the desk show "First L."; the full name is on the
  client's page only.
- **Client search** (`/admin/clients`, nav "Clients"; owner, managers,
  receptionists). By phone in any format (3+ digits) or by name without
  accents ("ngoc" finds "Ngọc"; a lower-case, accent-free copy is kept and
  indexed). Shows visits, last visit; the client's page adds the usual
  technician, the last ten visits and notes. No download of the list; 60
  searches per person per 5 minutes. Opening a client is not written to the
  audit log (the log would fill with reads; edits are logged, as
  `client_updated` with the fields changed, never their values).
- Backlog: importing the Fresha client list (DATA-001 in `08-backlog.md`).
- Tests: `packages/db/test/v013.test.ts` (12), `apps/web/src/components/tech-lines.test.ts` (2), one more each in the desk and kiosk form tests.

## v0.12.0, 2026-11-12: Demo day, the tech board, "Why this order?"

So the calling can be watched and the numbers checked by hand.

- **Demo day: `npm run up -- -Demo`.** Resets the local database, then loads a
  salon morning at Heavenly main built by the engine itself (every point from a
  real check-in, call, deny, excuse, finish or out-over; nothing written to the
  ledger by hand). Six technicians (Hoa, Tâm and Vân are new, phones
  +18135550110 to 0112): varied skills, tags and restrictions (no kids, no male
  clients, age 12+, no both-at-once), a deny, an excused deny, a late start, an
  out over 60 minutes, a break, one tech with a client. Appointments: a Fresha
  calendar client who arrived (−½ posted), one starting in 20 minutes (holds
  her out of the line), a calendar no-show, two desk-entered ones later today.
  Six clients waiting: a kid, a walk-in, a man, one who asked for a tech, a
  two-service visit, and a kiosk check-in with a design note waiting for
  Confirm. Châu stays at the second location. Also `npm run -w @turn/db
db:seed:demo` on an empty day. Needs an hour of today behind it (the out-over
  needs 60 minutes): it refuses in the first 66 minutes after midnight.
- **Demo calendars never fetched.** The demo's calendar rows (one per tech with
  calendar appointments, "connected, synced 5 minutes ago") carry a link under
  the reserved `.invalid` name. The feed code never makes a request for such a
  link, in any environment; locally it reads as synced, in production as a
  broken link. The Fresha host allowlist and the fetch checks are unchanged.
- **Cheat sheet: `docs/DEMO-EXPECTED.md`.** Written by the demo seed from the
  engine's own answers: the rules in force, the board in queue order with every
  ledger line, why each tech is ahead of the next, which tech each waiting row
  should call and who is skipped and why, and the appointments. The calls are
  simulated in a transaction that is rolled back. `packages/db/test/demo.test.ts`
  rebuilds the demo and fails if the sheet drifts by a byte, and checks the order
  and points against numbers worked out by hand from the rules.
- **The tech board (`/admin`, owner, manager, receptionist).** Under the desk,
  one card per technician on shift in the order the next call goes: turn number
  and "next up", points, status or the client in the chair, what they do and
  their tags, who they do not take, the next appointment. "Why this order?"
  opens every ledger line with its time, the total, the check-in time and rank,
  the 00 note, and why they are ahead of the next card. Owners and managers get
  a link to change the technician. Two cards a row on an iPad in landscape.
- Tests: `packages/db/test/demo.test.ts` (7).

## v0.11.0, 2026-11-12: Connect Fresha onboarding

Fresha's calendar export link is the way in (no open API), so adding the links
is now part of onboarding instead of a hidden owner setting.

- **Owner setup, last step (optional).** After a new salon is set up,
  `/setup/calendars` offers "Connect Fresha calendars": one row per technician
  with a paste box. Skip goes to the board. The same card is on Appointments.
- **Test before save.** "Test link" fetches the calendar through the same
  pinned, size- and time-limited fetch the poll uses, and says "Found N
  upcoming appointments", "Link works, no appointments yet", or what is wrong
  (not a Fresha link, Fresha did not answer, not a calendar). Nothing is saved
  by a test; Save stays off until the link in the box is the one tested.
- **Whose calendar is it.** The calendar's name (`X-WR-CALNAME`, e.g. "Fresha
  - DUONG LAM Heavenly Nails") is matched against the technicians, without
    accents or case. A mismatch shows "This calendar looks like Dương's, not
    Linh's" and a second button to save it for Dương. Never assigned without the
    owner pressing one.
- **Fresha links only from these screens.** `https` on
  `calendar-export.fresha.com`, exact host. More hosts by config
  (`FEED_ALLOWED_HOSTS`, comma separated, plain host names). The old generic
  link form stays on Appointments, folded under "Other calendar link (not
  Fresha)".
- **Technicians add their own.** A new technician lands on `/me/calendar`
  after joining ("Add your Fresha calendar", optional); `/me` shows
  "Calendar: Connected, last synced …" with Add or Manage. A technician can
  set or disconnect their own calendar only, while their membership is active
  (`feedTechnician`). They never see the link again, not even its hint.
- **Sync now.** Saving runs the first sync straight away, so the appointments
  are there when the screen comes back; the cron keeps it in step after that.
- **State on Appointments.** Each technician shows Not connected, Connected
  (last synced), not synced since … (stale), or Sync failing (red).
- **Audit.** `feed_tested` (new, with the outcome), `feed_set` and
  `feed_removed` (now with who: owner or technician). Never the URL or token.
  Tests and saves are rate limited per person (20 per 15 minutes).
- Tests: `packages/db/test/fresha.test.ts` (15), `apps/web/src/components/fresha-state.test.ts` (3).

## v0.10.2, 2026-11-12: kiosk step fix, request notes

From Duong's first kiosk test.

- **The kiosk skipped the technician step.** Next and I'm here were one reused
  button: the tap on Next turned it into a submit and sent the check-in from
  step 3. Each button now has its own key, so every step waits for its Next.
- **Design or special request on the kiosk.** A fifth, optional screen: "Any
  design or special request?" (200 characters, one line, cleaned in
  `cleanKioskNote`). Stored in `visits.note`; the audit row says `hasNote`,
  never the text.
- **Requests stand out on the desk.** A requested technician shows as an
  "Asked for {name}" tag and the note as "Request: …", on every waiting,
  called and in-service row, so the owner working the floor sees them. The
  desk can add, edit or clear a note on any open visit (`setVisitNote`,
  audited as `visit_note_changed` with `hasNote` only).
- **The called technician sees it.** `/me`'s call card shows "The client asked
  for you" and the request, for that technician's own call only.
- Privacy draft mentions the request note.

## v0.10.1, 2026-11-11: Part 10 review fixes

All eight findings from the independent review of v0.10.0.

- **No contact details in logs (1).** Every server action now goes through
  `guarded()` (login, setup, join, staff, rules, manage, appointments, kiosk
  admin, location and language switches too). `instrumentation.ts` adds
  `onRequestError` for page and route failures, and in production filters
  `console.error` so a database error (whose message quotes the query's
  parameters) is replaced by the scrubbed line.
- **A useful log line and a reference (2).** `lib/failure.ts`: the error's
  class, the Postgres code read from the cause, and a six-character
  reference. The reference comes back in the action state and is shown under
  "Something went wrong" in both languages.
- **Session refresh on every page a signed-in browser opens (3).** The proxy
  refreshes when a Supabase session cookie or the kiosk cookie is present, so
  a rotated token is never thrown away. Paths now match whole sections:
  `/meow` is a 404, not a sign-in redirect.
- **Kiosk idle clock from the future counts as idle (4),** with a minute of
  slack for a fast tablet clock.
- **Kiosk unlock capped at 15 minutes after the PIN (5),** however often a
  code is sent; a closed window is never re-opened. Migration 0023 adds
  `kiosk_devices.unlock_opened_at`.
- **Scanners (6).** The tracked-file scan reads every text file (it skipped
  `.sql`, `.pem`, `.key`, `.txt`, `.svg`) and flags database URLs with a
  password that are not the local stack's. The bundle scan adds
  `apps/web/public`. New `npm run pages:scan` fetches the public pages from a
  running production server and scans their HTML; CI runs it after the build.
- **Wording (7).** Privacy: a kiosk phone is saved to the customer list when
  the desk confirms and deleted when the desk declines. Terms and docs:
  offline taps are blocked, not queued.
- **CSP reports (8).** `report-uri` and `report-to` point at the new
  `/api/csp-report`: small bodies only, rate limited per address and overall,
  logs only the directive and the blocked origin. Answers 204.

## v0.10.0, 2026-11-11: Part 10, hardening

- **SEC-001 secrets audit: clean.** gitleaks 8.30.1 over all history and the
  source folders, the tracked-file scan, and a new browser bundle scan
  (`npm run bundle:scan`: secret shapes, connection strings, server-only
  variable names, source maps). Only hit: the local Supabase CLI's own keys in
  the git-ignored `supabase/.temp`. Report in `docs/security/SEC-001-report.md`
  with a draft rotation runbook. Nothing rotated, nothing found.
- **CI** (`.github/workflows/ci.yml`, not run yet: not pushed): format,
  typecheck, lint with no warnings, both secret scans, gitleaks on the full
  history, every test against `supabase/postgres:17.11.0.018` as a service
  (checked locally: the db suite passes against that image alone), build,
  bundle scan.
- **Errors.** Bilingual not-found page; `global-error` for a failing root
  layout; the error page shows only the reference digest. Desk, technician
  and kiosk actions go through `guarded()`: an unplanned failure answers "try
  again" in the person's language and logs the action name and error class
  only.
- **Offline iPad.** A banner, held submits (window capture listener, so no
  action starts offline), paused-looking buttons, and **Try again**.
- **Accessibility.** Errors are `role="alert"`; row buttons name their
  customer; the desk's gender choice is a labelled radio group; visible focus
  on the kiosk's hidden-input choices; focus moves to each new kiosk question
  and the step counter is announced; 13 px grey text raised to 6.7:1.
- **Security headers.** Per-request nonce CSP from the proxy on every page
  (`script-src 'self' 'nonce-…' 'strict-dynamic'`, `object-src 'none'`,
  `frame-ancestors 'none'`, `form-action 'self'`, `connect-src` to the
  Supabase origin only), checked in a browser: every script carries the
  nonce, no violations. Plus `Cross-Origin-Opener-Policy`, HSTS in
  production, no `X-Powered-By`, browser source maps off explicitly.
- **Terms and Privacy drafts** at `/terms` and `/privacy`, marked "DRAFT,
  needs attorney review". They state only what the code does; legal terms are
  brackets.
- **Fix found in the browser check:** a browser holding a revoked or expired
  kiosk cookie was signed out right after every staff sign-in (the idle check
  found no clock). Signing in now drops the stale kiosk cookie.

## v0.9.1, 2026-11-11: Part 9 review fixes

The independent review of Part 9 found three medium and four low issues. All
fixed, each with a test that failed first (10 new database tests, 3 web).

- **Kiosk input never edits a client** (finding 1). The typed phone waits on
  the visit (`visits.kiosk_phone`, migration 0022) and no client row is made or
  touched until the desk confirms. Confirm links a known phone without filling
  in its name or gender; a new phone gets a row with the typed name and no
  gender. Decline leaves nothing. A check constraint keeps the phone to
  unconfirmed kiosk visits.
- **The desk decides a kiosk request** (finding 2). A kiosk visit stays
  `self_checkin` with its requested technician until the desk presses
  **Confirm** (it becomes a request) or **Confirm, no request** (the request is
  dropped and the line decides). Audit rows now record the stored source and
  `requestedTechnicianId`, for desk walk-ins too.
- **Reassign** refuses an unconfirmed kiosk visit with a clear message instead
  of an error page (finding 3).
- **The PIN guards the sign-in** (finding 4). The right PIN opens a 2-minute
  window (a random token in an httpOnly cookie, only its hash stored); on a
  paired iPad the sign-in page and its actions need it, and it stretches to 10
  minutes once the code is sent. A staff session on a kiosk iPad signs out
  after 5 minutes without a tap.
- **Wait estimate** leaves out unconfirmed check-ins (finding 5).
- **No deadlock** when two desks confirm both halves of a pair: the group is
  locked in one ordered statement (finding 6).
- **Pairing** (finding 7): an expired code is audited as `kiosk_pair_failed`; a
  token unused for 90 days stops working (re-pair the iPad).

## v0.9.0, 2026-11-11: Part 9, customer kiosk check-in

- Kiosk `/kiosk` on a salon iPad, English or Vietnamese: one question per
  screen (first name and an optional phone; the services; who it is for, kid
  and age, woman or man or skip; a technician or anyone), "2 of 4" in words,
  Back bottom left, "I'm here" at the end, then "Please take a seat". The
  screen clears after every check-in and after 60 seconds untouched. The
  long-wait notice shows on the thank-you screen when the desk switched it on.
- The visit waits for the desk: the waiting list shows "Kiosk check-in,
  confirm before calling" with the typed first name, and **Confirm** or **Not
  here** (cancels it). A same-time pair is confirmed or declined together.
  The engine refuses a call before the confirm (`needs_confirm`) and so does a
  database trigger. A check constraint keeps `needs_confirm` to kiosk visits,
  and a trigger keeps a kiosk visit at its kiosk's own location.
- Devices (`kiosk_devices`, threat model T20, T25): an owner or manager
  registers an iPad in **Admin → Kiosk** with a name and a 4-digit PIN and
  gets a one-time pairing code (15 minutes). The iPad types the code at
  `/kiosk` and gets a random token in an httpOnly cookie; only SHA-256 hashes
  of the code and token and an scrypt hash of the PIN are stored, and no app
  role can read the table. **New pairing code** moves a kiosk to another iPad
  (the old token stops when the code is used); **Revoke** stops it at once.
  **Make this iPad the kiosk** pairs the current browser and signs the person
  out. A receptionist iPad that is also paired gets a **Kiosk mode** button.
- Leaving the kiosk: five quick taps on the salon name, then the PIN, go to
  staff sign-in. Every try is audited (`kiosk_unlocked`, `kiosk_pin_failed`).
  The kiosk refuses to run while a staff session is on the same browser.
- No enumeration (T12): the answer is the same for a new phone and a known
  one; a known phone keeps its stored name; nothing about a client comes back.
  A name without a phone makes no client row. The kiosk shows no board, no
  points and no other customer.
- Rate limits: 30 check-ins per kiosk and 60 per address per 10 minutes, 3 per
  phone per 30 minutes, 5 PIN tries per kiosk and 10 pairing tries per address
  per 15 minutes. Over a limit the kiosk says "Please check in at the front
  desk".
- Audit: `kiosk_check_in` (instead of `visit_created`, with the kiosk id and
  the attributes, never the name or phone), `kiosk_confirmed`,
  `kiosk_declined`, `kiosk_created`, `kiosk_pairing_code`, `kiosk_paired`,
  `kiosk_revoked`, `kiosk_unlocked`, `kiosk_pin_failed`; all in the Log
  filter. Confirms and declines count as desk entries in Reports.
- Sample data: a "Sample kiosk" with a 24-hour pairing code and PIN 1234 in
  `dev-codes.txt`, and one kiosk check-in "Ngoc" waiting for the desk.
- Migration 0021. Tests: 22 database (pairing, hashes only, revoke, PIN,
  check-in, no enumeration, confirm and decline, triggers, no app role reads
  the kiosk table, location scoping) and 5 web (the kiosk form).

## v0.7.1, 2026-11-11: Part 7 review fixes

Fixes from the independent review of Part 7, each with a test that failed
before the fix. Built on top of v0.8.0.

- Appointment buffer: the booked technician is never held out of their own
  appointment, so back-to-back bookings call the right person. A client more
  than the buffer (30 minutes) past their start time is a no-show and stops
  blocking the technician, even when the row came from the calendar and the
  desk cannot cancel it.
- Duplicates: the desk cannot add or move an appointment onto one the
  technician already has within 10 minutes (`duplicate`). When the calendar
  brings in a copy of a hand entry, an open hand entry gives way to it
  (`appointment_replaced`); an arrived one stays the visit and the copy is
  marked arrived with it. When two copies are already there, the first to
  arrive takes both (`appointment_merged`), so the −0.5 discount posts once.
- Poll: each feed runs in its own try/catch; an unexpected error marks that
  feed failed (`sync_failed`, last attempt written) instead of stopping the
  run, and the error text (which can hold the URL) is never kept. Feeds go
  oldest attempt first, four at a time. A bad location timezone falls back to
  America/New_York.
- Size limits: the 2,000-event cap counts only the sync window, so past
  history no longer breaks a feed; the byte ceiling is 8 MB for the whole
  file, and at most 50,000 events are read.
- A file without `END:VCALENDAR` was cut off and is refused (`truncated`). An
  event the parser cannot read keeps its appointment instead of cancelling it.
- Fetch: the DNS lookup counts inside the 10-second request limit, all hops of
  one feed share 20 seconds, and a malformed redirect is `bad_redirect`.
  Site-local (fec0::/10), discard-only (100::/64) and IPv4-translated
  (::ffff:0:0/96) addresses are refused.

## v0.8.0, 2026-11-11: Part 8, audit log viewer and reports

- Audit log `/admin/log` (owner, manager at their own location; receptionists
  and technicians get "only the owner and managers"). Filters: from and to
  date (at most 31 days, newest 2000 rows), technician, event. Each row shows
  who did it, their role, the technician it is about, the fields the design
  doc's audit table lists for that event (geofence and late minutes on a
  check-in, response time and deny reason on an answer, ledger row and delta
  on points, before and after on an adjustment and on a rule or role change),
  and the reason. A call row opens the queue at that second: everyone on
  shift, points, status, and why each one ahead was skipped.
- CSV download `/admin/log/export` (owner only, per the permissions table): the
  same rows from the same builder, so the file matches the screen row for row.
  UTF-8 with a BOM for Excel; a cell that starts with `=`, `+`, `-`, `@`, tab
  or carriage return gets a leading apostrophe so a spreadsheet keeps it text.
- Reports `/admin/reports` (owner, manager): the daily turn report per
  technician (check-in and out, late minutes, calls, accepted, denied, average
  answer time, visits, appointments, points by reason), the end-of-day summary
  for a closed day, and "who changed what, last 7 days": overrides per owner
  or manager and desk entries per receptionist (threat model T4).
- End-of-day summary: `daily_summaries`, one row per location and day, written
  once after the day ends and never changed (trigger refuses update, delete,
  truncate; owner and own-location manager read only). Nightly job at
  `/api/reports/daily` (Bearer `CRON_SECRET`). The owner's board shows
  "Yesterday: …" with a link to the report. Push to the phone waits on the
  Expo app.
- Manual point adjustments now log the total before and after.
- No client name, phone, calendar address, check-in coordinates or rule
  config dump reaches the viewer, the CSV or a summary (tested).
- Migration 0020. Tests: 217 database, 107 web.
- **Open**: the per-technician end-of-day summary on the phone was not in the
  Part 8 request, so it is not built. Whether the log's two-year retention
  should be enforced now or with the deletion rule (threat model T17).

## v0.7.0, 2026-11-11: Part 7, appointments, calendar feed, second location

- Appointments screen `/admin/appointments` (owner, manager, receptionist):
  today and the next week; add by hand, change and cancel a hand-entered one
  (a calendar row is changed in the calendar); every change audited with times
  and technicians, never the client's name.
- Client arrived: the appointment becomes a visit (source `appointment`) for
  the booked technician, who is called at once; when they cannot take it the
  visit waits for them. The discount applies at Finished; an appointment full
  set posts 0 and the board shows 00. The rules' queue order is now applied
  (`had_appointment_last`: 0 before 00). An arrived appointment no longer holds
  its technician in the buffer.
- Calendar feed per technician (Fresha gives one link per team member): owner
  sets or removes the link; stored server-side only (`calendar_feeds`, no app
  grant), shown as host and last four characters, never in the audit log.
  Fetch: https only, public addresses only (checked after DNS, connection
  pinned, every redirect re-checked), 2 MB, 10 s. Upserts the window (12 h back,
  31 days ahead), moves moved events, cancels dropped ones, leaves arrived ones.
  Scheduled poll at `/api/feeds/poll` (Bearer `CRON_SECRET`), "Sync now" on the
  screen. Board: last synced, next appointments, a red line for a failed or
  stale (45 min) calendar; a failed poll writes `feed_sync_failed`.
- Second location: `db:add-location` (starting menu, rules v1, the salon's
  owners become owners there); a Location switch in the admin bar for someone
  at two locations. Visits, visit services and calls are now read per location
  (they were salon-wide for managers and receptionists).
- The technician's phone lists their own coming appointments (times only).
- Dev: second location with Kim (receptionist) and Châu (technician), two
  sample appointments, `feed:local` to sync from an .ics file or `--sample`.
- Migration 0019. Tests: 191 database, 103 web.
- **Open**: what Heavenly's Fresha feed actually contains (client names or only
  times, lag): needs fifteen minutes on Phu's Fresha account. Whether an
  appointment may fall back to the line when its technician cannot take it
  (with Phu, like a request). The second location's real name.

## v0.6.0, 2026-11-05: Part 6, eligibility, restrictions, overrides

- Technician skills per service category, tags, and the five restrictions
  (`/admin/staff/[technician]`, owner and manager); a new technician does
  everything; every save audited with before and after.
- Client attributes on a walk-in (woman or man, kid and age, two services at
  the same time, optional name and phone with the phone as the Fresha match
  key); `clients` table; the name and phone never reach a technician's phone
  or the audit log, and a technician's own call row hides the queue snapshot.
- The engine runs every eligibility filter from the design doc: status, open
  call, double-booking guard, skills (must match / preferred / ignored),
  restrictions, appointment buffer (table added; Part 7 fills it). The desk
  sees who was passed over and why; a requested technician skips the queue
  only when the rules say so.
- Timers: out over the limit posts the penalty once (sweep on load, and on
  return); the board lists who is on break or out; the phone shows the timer;
  a late check-in posts the tier's start points once; shifts left open from an
  earlier day are closed on load.
- Overrides tab (owner and manager): reassign with optional deny penalty and an
  explicit override of skills, restrictions and the buffer (never status);
  excuse one of today's penalties once (reversing ledger row); adjust points
  by half steps. Every one needs a reason (audit log only), is refused across
  locations and on one's own points.
- Migration 0017: technician_skills, technician_tags, technician_restrictions,
  clients, appointments, visit attributes, ledger reversal link, `excuse`
  ledger reason, read policies.
- Sample data: three technicians with attributes and four canned walk-ins.

## v0.5.1, 2026-11-04: QA pass fixes

- A salon made from a setup code gets the starting menu (eight services), not
  only the four categories, so its desk can take a walk-in on day one.
- Phone wording: "Denying adds 2 to your points today" (no stray singular).
- Full QA pass by Claude in the browser: every role against every screen it must
  not reach, sign-in failure cases, join by invite code, new salon by setup code
  with email sign-in, rules preview/save/stale guard, staff invite/role/archive/
  restore, the called technician's screen, unanswered-call flag and clear,
  Vietnamese on every new screen. See the session report.

## v0.5.0, 2026-11-04: Part 5, rule builder, staff screen, attention

- Rule builder at `/admin/rules` (owner only): every value in `rule_config` as a
  field, validated on save (text in a number field, negative minutes, points not
  in half steps are refused), saved as a new version with who and why; the
  database refuses an edit or delete of any version; the engine runs the newest
  version that validates; preview re-sorts today's board under the typed rules;
  points per service category; the two values Phu has not decided stay "not set".
- Staff screen at `/admin/staff` (owner and manager): invite codes, role changes
  (the only way a role changes), archive and restore with a reason, all audited;
  a manager only at their own location.
- Attention (Duong, 2026-11-04): a call with no answer for the rule's minutes
  (15) is flagged to the desk with "Clear the call" (no penalty); an estimated
  wait for a new customer from a queue simulation, flagged as a long wait at the
  rule's minutes (30); a receptionist or manager switches the customer notice
  the kiosk will show (Part 9).
- Fixes from the Part 4 click-through: a called technician cannot take Break, Out
  or Check out until they answer (server refuses, phone hides the buttons); the
  "visits today" sentence is counted, not hard-coded; the deny penalty on the
  phone comes from the rules, with no fallback.
- Tests: 121 database, 92 web.

## v0.3.0, 2026-11-04: Part 3, status and ledger (+ security sweep)

- Technician status machine: off, checked in, available, in service, break, out; every
  transition tested; server time; server-side geofence with the raw position logged.
- Points ledger and shift totals; audit log that refuses update, delete and truncate.
- Technician screen `/me`; admin board in queue order; technicians sent to `/me`.
- Security sweep fixes: active-membership check for technicians, no leaving
  in_service from the phone, per-contact and per-code limits, location-scoped audit
  reads, audit rows for joins and new salons, security headers.
- `npm run down`, `HOW-IT-WORKS.md`.

## v0.2.1, 2026-11-04: join fix, salon setup codes, one-command start

- A code is never attached to an already signed-in account.
- Salon setup codes (operator-made) create a new salon with its owner.
- `npm run up` starts Docker, the local stack, migrations, seed and the web app.
- `TESTING.md`.

## v0.2.0, 2026-11-04: Part 2, accounts, sign-in, invites

- Next.js web app with the design tokens; English with a one-button Vietnamese switch.
- Sign-in by email or US phone with a 6-digit code; sign-up disabled at the auth
  server; accounts created only behind a valid invite.
- Invite codes: hashed, single use, expiring. Permissions table as code. Rate limiter.

## v0.1.0, 2026-11-04: Part 1, foundation

- Schema with tenancy on every table, row-level security (read only for app users),
  composite tenant keys, restrict-on-delete, Heavenly seed, 25 tests.

# Changelog

One version per delivered part. Tags point at the commits.

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

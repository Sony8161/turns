# Refuted review findings

Claims from reviewers that were checked and found not to be bugs. Kept so they
are not re-raised.

## 2026-11-11, Part 7 (REQ-0c2b89ef)

Review: the build ran as a sub-agent, which cannot start a second reviewer, so
the security and correctness pass was a self-review of the diff (SSRF, feed URL
leakage, RLS, the 00 order). One certain bug found and fixed before delivery:
visits, visit services and calls were readable salon-wide by any manager or
receptionist, so a second-location receptionist saw the first location's
visits (now per location in 0019, tested). An independent review is still owed
before Part 10 ships.

- **A technician can read the client name on their own appointments** through
  the row-level policy from 0017 (`appointments_select_own`). Declined for now:
  the phone screen shows times only, the name is what Fresha already shows the
  technician, and the web app reads through the server. Revisit with the Expo
  app (T11, T16).
- **The rule builder's preview sorts by points and check-in only**, not by
  `had_appointment_last`. Declined: rules.ts cannot import the engine (cycle);
  the preview is about points, and the board and the engine do use the full
  order.
- **Recurring calendar events (RRULE) are not expanded.** Declined: an
  appointment feed has single events; revisit if Heavenly's feed shows
  otherwise.
- **The owner is not alerted outside the app** when a calendar fails (the board
  line and the audit row only). Push and text come with the Expo app.

## 2026-11-05, Part 6 (REQ-5336cf7a)

- **General reviewer: "on a successful call the skipped list includes eligible
  technicians ahead of a requested pick, labelled available."** Refuted by
  reading `skippedOf` (engine.ts): it filters to `!eligible` first, so an
  eligible technician never appears. Only the `detail` string on the
  nobody_eligible error lists everyone, and it is a debugging string.
- **General reviewer: "the `busy` guard's `called` half never matches because
  assigned_technician_id is set only on accept."** True today, and kept on
  purpose: the guard is the database-side backstop the design doc asks for
  ("not already assigned to an open visit"), and a later writer (Part 7's
  appointment arrival, the kiosk) may assign before accept.
- **General reviewer: "a requested technician who is ineligible blocks the
  call instead of falling back to the line."** Decided, not refuted: with
  `requested_tech_bypasses_queue` on, the client asked for that person and
  waits for them; the desk sees why (skipped list) and can clear the request
  by re-entering the walk-in, or a manager can move it. The comment in
  `callNext` now says so. Revisit with Phu (16-Questions, request handling).
- **Both reviewers: "the eligibility tests share one database and depend on
  order."** Accepted, as for the Part 4 engine tests: each file resets and
  migrates once and the tests tell one story in order; the follow-up block
  uses fresh technicians and rests the floor by SQL so it does not depend on
  the earlier point totals. A fresh-database-per-test harness is a Part 10
  item (Playwright and CI).
- **General reviewer: "`normalizePhone` duplicates `parseContact`."** The two
  share a regex but serve different callers: the sign-in page (email or
  phone, with iOS invisible marks) and the engine (phone only). The db
  package cannot import the web app, and the web app importing clients.ts
  would pull server code into a client bundle. Each has its own test.
- **TypeScript reviewer: "the Desk form sends isKid as true or false, never
  'not asked'."** By design: the checkbox is the desk's answer; a kid of
  unknown age is caught by `min_client_age` only when the box is ticked, which
  is the information the receptionist has.
- **TypeScript reviewer: "the Passed-over box stays up for a different visit
  until the next call."** Known; it is the last call's result, labelled as
  such, and the auto-refresh does not clear action state. Cosmetic; revisit
  with the kiosk screens.
- **Database reviewer: "a technician left in `out` from yesterday gets an
  out-over penalty on yesterday's shift."** Fixed differently: the sweep now
  closes a stale shift first and posts no out-over on a day that is over.
- **Database reviewer: "nothing ties `turn_ledger.reverses_id` to the excuse
  reason type."** The code refuses to excuse anything but a deny, out-over or
  late row, the row is locked, and `unique(reverses_id)` blocks a second
  excuse. A CHECK would need the `excuse` enum value in SQL, which the same
  migration cannot use (see the comment in 0017). Add it in a later migration
  if a second writer ever appears.
- **Database reviewer: "the profile tables are not tied to the technician's
  own location."** `saveProfile` reads the technician row in the same
  transaction and copies its organization and location; the composite
  location key still holds. A trigger is not worth its cost until a second
  writer exists (Part 7's appointment import, which will get the same review).
- **Security reviewer: "a manager can excuse any past penalty."** Fixed: today
  only, and never one's own (`not_today`, `own_points`).
- **Security reviewer: "clients and appointments are readable org-wide."**
  Fixed: owners read the salon, managers and receptionists their own
  location (0017, as 0009 does for the audit log).

## 2026-11-04, Part 5 (REQ-ecc2ba80)

- **Security reviewer: "`rule_configs.created_by ... on delete restrict` blocks
  deleting a login account for ever, because the row can never be edited."**
  Declined, consistent with the existing design: accounts are never deleted,
  only archived (schema comment on `technicians.user_id`, grc scoping 6.3), and
  `technicians.user_id`, `audit_log.actor_user_id` and `invite_codes.created_by`
  already restrict the same deletion. Erasure blanks contact fields on the
  profile; the ids stay as history. Revisit with the attorney (Part 10) if
  erasure must remove the account row itself.
- **Security reviewer: "the table owner can still disable the append-only
  triggers."** True and already accepted for `audit_log` (refuted list, Part 3,
  F7b): the cloud setup gives the app a non-owner database role (Part 10).
- **Database reviewer: "a location with no valid rule_config now throws instead
  of running on `{}`."** By design (threat model T18): the engine runs the newest
  version that validates; if none does, that is a deployment fault to surface,
  not to paper over with a config that has no numbers. Every path that creates a
  location (`seed.ts`, `setup.ts`) writes version 1; the migration's data step
  now guards non-object configs.
- **Database reviewer: "the append-only triggers and the RESTRICT keys mean a
  location, salon or account can never be deleted."** Consistent with the
  design: nothing is deleted, only archived (Duong, 2026-11-04); the same
  RESTRICT keys already exist on technicians, shifts, ledger and audit rows.
- **Database reviewer: "`previewBoard` does not limit shifts to today."** The
  board itself reads the same shift (`technician_status.shift_id`); a stale
  shift is a Part 6 item (daily reset, out and break timers), not a preview bug.
- **Database reviewer: "`locations.timezone` is not validated."** Only the seed
  and setup write it today (a fixed default); a location settings screen (Part
  7, second location) validates it when it exists.
- **TypeScript reviewer: "the builder offers settings the engine never reads"
  (late tiers, out-over, auto-pass, skills, restrictions, appointment buffer,
  requested-technician bypass).** True today and said on the screen: those
  sections carry "the engine starts reading these in Part 6". The values are
  stored now so Parts 6 and 7 read a complete config.
- **TypeScript reviewer: "`todayCounts` counts `deny_excused` and
  `points_adjusted`, which nothing writes yet."** Those are the Part 6 excuse
  and adjust actions; counting them now costs nothing and avoids a second edit.
- **TypeScript reviewer: "a user who is receptionist at A and manager at B sees
  A's board but the staff page acts on B."** The known location-choice gap
  (STATE: carry into Part 3, T10); each action still scopes to one membership's
  location, so nothing crosses a location. An explicit location switch is due
  with the second location (Part 7).

## 2026-11-04, roles set by Duong (after the sweep)

- **Sweep F3 "a technician can leave in_service"**: the fix was tightened too far.
  Duong's roles: technicians mark a service **finished** themselves (as the design
  doc also says). Now: from in_service the only move is "finish" (Part 4 posts the
  points there); a plain "available" from in_service is still refused.

## 2026-11-04, Part 3 security sweep (REQ-09c1e578)

- **"Every org member can read shifts, status and turn_ledger" (F6a).** Declined,
  by design: the board is on a screen in the salon and the design doc makes points
  visible to the floor; hiding them in the API would hide nothing. The audit log is
  the sensitive table and is restricted (owner, manager at their location).
- **"`db:seed` has no local-only guard" (F12).** By design: `db:seed` is the
  production seed for Heavenly; `db:seed:dev` is the one that must stay local.
- **"x-forwarded-for can be spoofed" (F9b).** Accepted for now: the target host is
  Vercel, which sets the header itself. Revisit if the host changes.
- **"Run the app as a non-owner database role" (F7b).** Deferred to the cloud setup
  (Part 10): the local stack uses the postgres role; cloud will use a dedicated
  role with INSERT and SELECT only on audit_log. TRUNCATE is blocked by trigger now.

## 2026-11-04, Part 2 (REQ-a5e7a172)

- **check.py BLOCK: `supabase/config.toml` `auth_token = "local-placeholder"` flagged as
  a secret assignment.** Refuted: the value is the literal string `local-placeholder`.
  It exists only so the local auth server has an SMS provider enabled for the fixed
  test code; no message can be sent with it. Cloud Twilio credentials live in the
  Supabase dashboard, never in this file.

- **TypeScript reviewer: "`next/font/google` fails an offline CI build; `--webpack`
  builds lose Tailwind CSS."** Not refuted, declined for now: there is no CI yet and
  builds use Turbopack. Revisit when CI is set up (Part 10).
- **TypeScript reviewer: "`.points` unlayered beats `text-[56px]`."** Not verified
  either way; the layer wrap was applied because it is correct regardless.

## 2026-11-04, Part 1 (REQ-63a6ce89)

- **"update/delete tests should accept 0 rows, not only permission denied"**
  (typescript reviewer). Refuted: the test asserts that app roles hold no write
  right at all (threat model T2). If a later migration grants UPDATE, this test
  must fail. 0001_rls.sql now also revokes Supabase's default grants, so
  "permission denied" is the correct and only acceptable outcome.
- **"`as T` cast in asRole hides a wrong T"** (typescript reviewer). Benign:
  postgres.js types `begin()` as `UnwrapPromiseArray<T>`; the runtime value is
  the same. Kept, with a comment.
- **"missing indexes on organization_id / location_id"** (database reviewer,
  self-dismissed). At tens of rows a scan is cheaper. Only the membership lookup
  the policy runs per row got an index.

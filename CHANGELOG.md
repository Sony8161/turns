# Changelog

One version per delivered part. Tags point at the commits.

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

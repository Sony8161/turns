# Changelog

One version per delivered part. Tags point at the commits.

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

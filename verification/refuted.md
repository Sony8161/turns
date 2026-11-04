# Refuted review findings

Claims from reviewers that were checked and found not to be bugs. Kept so they
are not re-raised.

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

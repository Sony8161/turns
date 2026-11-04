# Refuted review findings

Claims from reviewers that were checked and found not to be bugs. Kept so they
are not re-raised.

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

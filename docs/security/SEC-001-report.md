# SEC-001: secrets and client-side exposure audit

**Run:** 2026-11-11, Part 10 (v0.10.0), on Duong's PC against the local repo.
**Result:** clean. No secret in the code, the git history or the browser
bundle. Nothing was rotated, because nothing real was found.
**Scope not covered yet:** the cloud (no Supabase cloud project or Vercel
deploy exists), GitHub repository settings, and a deployed site. See "Still
open" below.

## 1. Inventory

| Secret                                                    | Where it lives                                                    | Who reads it                                                                                          | Public?                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `SUPABASE_SERVICE_ROLE_KEY`                               | `apps/web/.env.local` (git-ignored, written by `scripts/dev.ps1`) | `apps/web/src/lib/supabase/admin.ts` (`server-only`), `packages/db/src/seed-dev.ts` (local script)    | No                                                                             |
| `DATABASE_URL`                                            | same                                                              | `apps/web/src/lib/db.ts` (`server-only`), db scripts and tests                                        | No                                                                             |
| `CRON_SECRET`                                             | not set locally (the endpoints refuse every call)                 | `app/api/feeds/poll/route.ts`, `app/api/reports/daily/route.ts` (route handlers, timing-safe compare) | No                                                                             |
| `NEXT_PUBLIC_SUPABASE_URL`                                | same                                                              | browser and server                                                                                    | Yes, by design                                                                 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`                           | same                                                              | browser and server                                                                                    | Yes, by design: row-level security is on for every table (`isolation.test.ts`) |
| Kiosk tokens, PINs, pairing codes, invite and setup codes | database, hashes only (SHA-256 or scrypt)                         | server                                                                                                | No                                                                             |
| Stripe, Twilio, Resend, Sentry                            | not in the product yet (Phase 2)                                  |                                                                                                       |                                                                                |

`.env.example` holds placeholders only. `.gitignore` ignores `.env` and
`.env.*` except `.env.example`, `supabase/.temp/`, `supabase/.env`,
`dev-codes.txt` and `security/scans/`.

## 2. Checks and results

| #   | Check                                                                                                                          | Tool                                                   | Result                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Full git history, all refs (27 commits)                                                                                        | gitleaks 8.30.1 `git --log-opts=--all`                 | No leaks                                                                                                                                                                                                    |
| 2   | Working tree: `apps/web/src`, `packages/db/src`, `packages/db/drizzle`, `scripts`, `supabase`                                  | gitleaks `dir`                                         | No leaks in tracked code. 4 hits in `supabase/.temp/start-secrets/.../docker.env`: the local Supabase CLI's own runtime keys for the local stack, git-ignored and never committed. Expected, not a finding. |
| 3   | Tracked and staged files: public variable names and secret shapes                                                              | `npm run secrets:scan`                                 | OK                                                                                                                                                                                                          |
| 4   | Browser bundle (`apps/web/.next/static`, 28 files): secret shapes, connection strings, server-only variable names, source maps | `npm run bundle:scan` (new, `scripts/scan-bundle.mjs`) | OK, 0 source maps                                                                                                                                                                                           |
| 5   | Server bundle: baked-in JWTs                                                                                                   | search of `.next/server` for `eyJhbGci`                | None (env is read at run time with bracket access, never inlined)                                                                                                                                           |
| 6   | `NEXT_PUBLIC_` / `EXPO_PUBLIC_` names                                                                                          | `secrets:scan` allow list                              | Only the URL and the anon key                                                                                                                                                                               |
| 7   | Client components importing server modules                                                                                     | review of every `'use client'` file                    | None; `app/admin/chips.ts` has a type-only import. `lib/db.ts`, `lib/supabase/admin.ts` and `lib/supabase/server.ts` import `server-only`, so a client import fails the build                               |
| 8   | Public source maps                                                                                                             | `next.config.ts`                                       | `productionBrowserSourceMaps` not set (off by default); bundle scan fails on any `.map`                                                                                                                     |

Raw scanner output is in `security/scans/` (git-ignored: it names paths).

## 3. Backlog tasks (08-backlog.md, SEC-001)

1. Inventory: **done** (section 1).
2. No secret under a public prefix or in a client component: **done**.
3. Privileged calls server-side behind a session and role check, `server-only`
   on those modules: **done** for what exists (service role, database). Stripe,
   Twilio, Resend and payroll exports do not exist yet.
4. Secrets only in Vercel and Supabase settings, split staging and production:
   **open**, no cloud project yet. `.env.example` and `.gitignore`: done.
5. History scan: **done**, clean. Nothing to rotate.
6. Public source maps off: **done**.
7. Production bundle scan that fails the build: **done** locally
   (`npm run bundle:scan`) and in CI. The deployed site: open (no deploy yet).
8. CI gates: **written** (`.github/workflows/ci.yml`: secret scans, gitleaks on
   the full history, bundle scan), not run yet because nothing is pushed. A
   local pre-commit hook and GitHub secret scanning with push protection
   (repository settings): **open, Duong**.
9. Stripe webhook signatures: not applicable yet. Row-level security with a
   second salon's user: covered by `isolation.test.ts` and the per-part tests.
   No API route returns data without a session or the cron secret: checked
   (two route handlers, both bearer-guarded).
10. Rotation runbook: **draft below**; the access review with Phu is open.

## 4. Rotation runbook (draft)

- **Supabase service role key or JWT secret:** Supabase dashboard, Project
  settings, API, roll the key. Update it in Vercel (production and preview),
  redeploy, and check that sign-in and invites still work. Who: Duong.
- **Database password:** Supabase dashboard, Database settings, reset. Update
  `DATABASE_URL` in Vercel, redeploy.
- **`CRON_SECRET`:** generate 32+ random characters, update Vercel and the
  scheduler that calls `/api/feeds/poll` and `/api/reports/daily` together.
- **A kiosk iPad lost or stolen:** Admin, Kiosk, Revoke. The token stops on
  the next request. Pair a replacement with a new code.
- **A leaked secret in git:** rotate first, then clean history, then rescan.
- **Access review:** once a year with Phu (partnership terms): who has the
  Supabase, Vercel, GitHub and shared-email accounts.

## 5. Still open (owner: Duong)

- Create the cloud projects with secrets in their settings only (task 4).
- Push to GitHub when ready, turn on secret scanning and push protection, and
  watch the first CI run (task 8).
- Scan the deployed site once it exists (task 7).
- Repeat this audit before v1.0, before POS (Phase 2) and on every
  production deploy (CI does the scans automatically).

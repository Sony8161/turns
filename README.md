# Turn system

Digital technician turn system for nail salons. Design: `../Turn System Design Doc.md`.
Threat model: `../11-Turn-System-Threat-Model.md`. Decisions: `../12-Turn-System-Decisions.md`.

## Layout

- `packages/db`: Drizzle schema, migrations, row-level security, seed. Shared by web and mobile.
- `apps/web`: Next.js admin, receptionist iPad and kiosk pages (Part 2 onward).
- `apps/mobile`: Expo technician app (Part 4 onward).

Trying it by hand: see `TESTING.md`.

## Local development

Needs Node 22+, Docker Desktop running, and the Supabase CLI (`npx supabase`).

```sh
npm install
npx supabase start          # local Postgres, Auth, Realtime; prints keys
cp .env.example .env        # paste the local keys it printed
npm run -w @turn/db db:migrate
npm test
```

## Gates before merging a slice

`npm run format:check`, `npm run typecheck`, `npm test`, `npm run secrets:scan`.
Every part gets a migration, a test for the engine logic, and a manual test on the iPad.
The rule engine never reads a hard-coded number; if a value is not in `rule_config`, it is a bug.
Any change to how points are calculated is a new `rule_configs` version, never an edit in place.

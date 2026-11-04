# Testing the turn system on your machine

Everything here runs locally. No real text message or email leaves your computer,
and nothing touches a cloud account.

What exists after Parts 1 and 2: the public page, sign-in by email or phone code,
joining a salon with an invite code, and the admin home with an empty board.
Check-in, points and the live board come in Parts 3 and 4.

## 0. The one-command way

In a terminal in the repo folder:

```
cd "C:\Users\jeffl\Desktop\business\mvp md\salon management\turn-system"
npm run up
```

It starts Docker Desktop if it is closed, starts the local stack, writes the web
app's local keys, applies migrations, seeds Heavenly, prints fresh invite codes and
a salon setup code, starts the web app in its own window, and opens the browser.
Run it again any time; it skips what is already running. `npm run down` stops the
web app and the stack (data kept); `npm run down -- -docker` also quits Docker
Desktop. Steps 1 and 6 below are what `up` does by hand.

## 1. Start the two things it needs (by hand)

Open a terminal in the repo folder:

```
cd "C:\Users\jeffl\Desktop\business\mvp md\salon management\turn-system"
```

1. **Docker Desktop** must be running (the whale icon in the tray).
2. **The local database and auth server:**
   ```
   npx supabase start
   ```
   It prints a block of values. For step 6 you need the service role key, which this
   block does not show. Get it with `npx supabase status -o env` and copy the long
   `SERVICE_ROLE_KEY="eyJ..."` value. Not the Storage Access Key, not the Secret.
   If it says it is already running, fine.
3. **The web app:**
   ```
   npm run dev -w web
   ```
   Leave this terminal open. The app is at http://localhost:3000.

First time only, or after the database was reset, load the tables and the Heavenly
seed (step 6 does this too).

## 2. The public page

Open http://localhost:3000.

- You see the demo board: six technicians, points on the left (0, 00, ½, 1, 1½, 2),
  a colour bar per status, a pink "waiting" row.
- Press **Tiếng Việt** (top right). Every word switches, board included. The button
  now says **English**; press it to switch back. The choice is remembered.

## 2b. Sample accounts (made by `npm run up`)

`npm run up` creates these every time and writes them, with fresh codes, to
`dev-codes.txt` in the repo folder. Every sign-in code is **123456**. The phones
are 555 numbers; they only work on your machine.

| Role         | Name | Phone        | Email             | Screen   |
| ------------ | ---- | ------------ | ----------------- | -------- |
| owner        | Phu  | 813 555 0100 | phu@example.test  | `/admin` |
| manager      | Vy   | 813 555 0101 | vy@example.test   | `/admin` |
| receptionist | Hạnh | 813 555 0102 | hanh@example.test | `/admin` |
| technician   | Thảo | 813 555 0103 | thao@example.test | `/me`    |
| technician   | Linh | 813 555 0104 | linh@example.test | `/me`    |
| technician   | Mai  | 813 555 0105 | mai@example.test  | `/me`    |

Sign in at http://localhost:3000/login with the phone, then `123456`. Owners,
managers and receptionists land on the board; technicians land on their own
screen. Sign out before switching accounts (shared browser).

**Only these 555 numbers work locally.** A random phone number cannot receive a
text on your machine, so no code exists for it and `123456` says "didn't match".
For a brand-new person use the spare `813 555 0109`, or a new `name@example.test`
email (code in Mailpit). An invite code only creates a _new_ account: a phone that
already has a staff account at the salon is refused ("ask the owner or manager to
change your role"); role changes are an owner or manager screen (Part 5).

**If anything says "something went wrong" or a code is "not valid":** the stack is
probably off or the data was reset. Run `npm run up` again; it fixes both and
prints new codes.

## 3. Join a salon with an invite code (a new person)

1. Sign out if you are signed in.
2. http://localhost:3000/join → the technician or receptionist invite code from
   `dev-codes.txt`, your name → **Continue**.
3. Sign in with the spare phone `813 555 0109` → `123456` (or any new
   `name@example.test` email, code in Mailpit).
4. You land on `/me` (technician) or `/admin` (receptionist) at Heavenly.

Each code works once; `npm run up` prints new ones.

**Codes are for new accounts.** If you are already signed in (as Phu, say) and open
/join or /setup, the page tells you so and offers Sign out. The code is never
attached to whoever happens to be signed in.

## 3b. Set up a brand-new salon (owner)

A **salon setup code** is different from a staff invite: you, as the operator, make
it, and whoever uses it creates a new salon and becomes its owner.

1. Get a code: the "Salon setup code" line in `dev-codes.txt` (new each `npm run up`),
   or `npm run -w @turn/db db:setup-code -- "note"` with `DATABASE_URL` set (step 6).
2. Sign out if you are signed in. Go to http://localhost:3000/setup (also linked
   from the front page as "Set up a new salon").
3. Enter the code, your name, the salon name and the location name → **Continue**.
4. Sign in with the spare phone `813 555 0109` → `123456`, or a new
   `name@example.test` email (code in Mailpit, step 4).
5. You land on `/admin` as the owner of the new salon, with its own empty board,
   the four default service categories and rule config version 1.

Staff of that salon then join with invite codes the owner makes (owner-made invites
come in Part 5; until then, `db:seed:dev` makes codes for Heavenly only).

## 4. Sign in by email as the owner

1. http://localhost:3000/login → `phu@example.test` → **Send me a code**.
2. Open the local inbox: http://127.0.0.1:54324 (Mailpit). The newest mail is
   "Your sign-in code / Mã đăng nhập của bạn" with a 6-digit code in both languages.
3. Enter the code. You are in as Phu, owner.

## 5. Things that should fail, and do

| Try                                                  | You should see                                                |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| A made-up invite code on /join                       | "That invite code isn't valid. Ask the owner for a new one."  |
| The technician code `MSGYD-TTC3K` (already used)     | "That invite code has been used."                             |
| Phone `123 456 7890` on sign-in                      | "Enter an email address or a US phone number."                |
| `phu@example.com,` (trailing comma)                  | same message                                                  |
| Request a code 6 times in a row for the same contact | "Too many codes requested. Wait a few minutes and try again." |
| A wrong 6-digit code                                 | "That code didn't match. Check it and try again."             |
| Visit /admin without signing in                      | bounced to /login                                             |

## 6. New invite codes, or a fresh start

In a terminal in the repo folder (PowerShell):

```
$env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
$env:SUPABASE_SERVICE_ROLE_KEY = "<paste SERVICE_ROLE_KEY from npx supabase status -o env, starts with eyJ>"
npm run -w @turn/db db:migrate
npm run -w @turn/db db:seed:dev
```

It prints a new technician code, a new receptionist code, a salon setup code, the
owner email, and the test phone. Run it again any time you need more codes.

To wipe everything and start clean:

```
npx supabase db reset
```

then run the two commands above again.

## 7. Look inside the database

Supabase Studio: http://127.0.0.1:54323.

- **Table editor** → `organizations`, `locations`, `service_categories`,
  `rule_configs` (Heavenly's rules as JSON, two values still `null` for Phu),
  `profiles`, `memberships`, `invite_codes` and `setup_codes` (only hashes, never
  the code), `rate_limits`.
- **SQL editor**, to see the protection work:
  ```sql
  set role authenticated;
  select * from organizations;          -- 0 rows: no membership, nothing visible
  insert into organizations (name) values ('x');   -- permission denied
  reset role;
  ```

## 8. Run the automated tests

```
npm test
```

Expect 80 database tests and 49 web tests to pass. They reset the local database
before each test file and leave the last file's data behind, so run
`npx supabase db reset` and then step 6 afterwards if you want clean seed data.

## 8b. A technician's day (Part 3)

1. Join as a technician (step 3, with the technician code from step 6), sign in,
   then open http://localhost:3000/me.
2. You see your name, "You are off", 0 points, and one button: **I'm here**.
3. Tap through the day: **I'm here** → **I'm ready** → **Break** → **I'm ready**
   → **Out** → **I'm ready** → **Check out**. Only the moves allowed from the
   current state are shown.
4. Open http://localhost:3000/admin in between: you appear on the board with
   your status, points and a timer; order is lowest points first.
5. Studio → `audit_log`: one row per move with before, after and who. Try to
   edit or delete one in the SQL editor: "audit_log is append-only".

## 8c. A walk-in from desk to finish (Part 4)

Two browsers (or one normal window and one private window): the desk and a phone.

1. **Phone**: sign in as a technician (Thảo, 813 555 0103), open /me, tap
   **I'm here** then **I'm ready**.
2. **Desk**: sign in as the receptionist (Hạnh, 813 555 0102) or the owner, open
   /admin. Under **New walk-in** tick a service, **Add to the queue**, then
   **Call next**. The board shows Thảo as "called" in pink with a timer.
3. **Phone**: within 5 seconds the call appears: the services, **Accept** or
   **Deny**. Deny first shows "Denying adds 1 point" and the reasons; pick one.
   Your points go to 1. Back on the desk, **Call next** again calls the next
   available technician (or Thảo again if nobody else is on).
4. Accept: you are "in service". Tap **Finished**: the visit's points post
   (1 for a manicure, ½ for a full set) and you are available again.
5. Studio → `turn_calls` has the queue snapshot for each call; `audit_log` has
   every step.

Heavenly's seed has no geofence, so check-in needs no location. To try the fence,
set `geofence_lat`, `geofence_lng` and `geofence_radius_m` on the location in
Studio; check-in from a browser that shares a position outside it is refused with
the distance.

## 9. If something is off

- **"Something went wrong on our side"** on sign-in: the local stack is probably
  not running. `npx supabase start`, then try again.
- **Page is blank or errors at the top**: the web app may have lost its
  environment. Stop it (Ctrl+C) and run `npm run dev -w web` again.
- **No mail in Mailpit**: wait a few seconds and refresh; if still nothing, the
  stack was started before the email template existed. `npx supabase stop` then
  `npx supabase start`.
- **Port 3000 already in use**: another dev server is still running. Close that
  terminal, or in PowerShell:
  `Get-NetTCPConnection -LocalPort 3000 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`

## What is not here yet

Check-in and status (Part 3), the rule engine, walk-in entry, push to a phone and
the live board (Part 4), the rule builder (Part 5), and everything after.

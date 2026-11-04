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
stack. Steps 1 and 6 below are what it does by hand.

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

## 3. Join a salon as a receptionist

1. Go to http://localhost:3000/join.
2. Invite code: `5BWGV-F7JKX` (unused as of Nov 4). Your name: anything. **Continue**.
3. On the sign-in page, enter the test phone `813 555 0100` and press **Send me a code**.
4. Enter `123456`. (This number and code only work on your machine.)
5. You land on `/admin`: "Heavenly Nails main, receptionist", an empty board, and
   "0 visits today, 0 denies, 0 overrides".
6. Press **Sign out**. Then type http://localhost:3000/admin in the address bar: you
   are sent back to sign-in.

If the code says "has been used", get a fresh one in step 6.

**Codes are for new accounts.** If you are already signed in (as Phu, say) and open
/join or /setup, the page tells you so and offers Sign out. The code is never
attached to whoever happens to be signed in.

## 3b. Set up a brand-new salon (owner)

A **salon setup code** is different from a staff invite: you, as the operator, make
it, and whoever uses it creates a new salon and becomes its owner.

1. Get a code: `npm run up` prints one, or `npm run -w @turn/db db:setup-code -- "note"`
   with `DATABASE_URL` set (step 6).
2. Sign out if you are signed in. Go to http://localhost:3000/setup (also linked
   from the front page as "Set up a new salon").
3. Enter the code, your name, the salon name and the location name → **Continue**.
4. Sign in with a new email (any `name@example.test`) or the test phone; read the
   code in Mailpit (step 4).
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

Expect 40 database tests and 49 web tests to pass. They reset the local database,
so run step 6 again afterwards if you want the seed data back.

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

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

Expect 217 database tests and 107 web tests to pass. They reset the local database
before each test file and leave the last file's data behind, so run
`npx supabase db reset` and then step 6 (or `npm run up`) afterwards if you want
clean seed data.

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

## 8d. Rules, staff and attention (Part 5)

**Rules** (owner only). Sign in as Phu, open **Rules** in the top bar
(http://localhost:3000/admin/rules).

1. Every number the engine uses is a field: points, points per service category,
   penalties, late tiers, queue, who can be called, requested technician, and the
   attention timers (unanswered call after 15 min, long wait at 30 min).
2. Type `one` into **Deny penalty** and press **Save as version 2**: the page says
   "Fix the fields marked" and the field says "Enter a number". Nothing was saved.
3. Put `1.5` back, write a note, **Save as version 2**: "Saved as version 2" and
   the history lists version 2 with your name and the note. Version 1 is kept.
4. **Preview on today's board** re-sorts the technicians on shift under the typed
   rules without saving (nobody on shift = nothing to re-sort).
5. The two values Phu has not decided show as "Not set yet (ask Phu)" (requested
   visit) and a blank start-points box on the 60-minute late tier.
6. Sign in as Vy (manager): the Rules page says only the owner changes rules.
7. Studio → `rule_configs`: try to edit or delete a row in the SQL editor:
   "rule_configs is append-only: save a new version".

**Staff** (owner or manager). Open **Staff** (http://localhost:3000/admin/staff).

1. **Make a code** for a technician: the code shows once with its expiry. It works
   on /join like the codes in `dev-codes.txt`.
2. On Mai's row pick **receptionist**, write a reason, **Change role**: her role
   line changes; Studio → `technicians` shows her row inactive, `audit_log` has
   `role_changed` with the reason. Change her back to technician: the same row
   comes back active.
3. **Archive** Hạnh with a reason: she drops to the bottom as "archived" with a
   **Restore** button. Nothing was deleted. Restore her.
4. A manager cannot pick owner anywhere; nobody can change their own row; a
   technician who is checked in cannot be moved or archived ("Ask them to check
   out first").

**Attention** (on the board, for owner, manager and receptionist).

1. With Thảo ready and a Basic manicure waiting, the **Needs attention** block
   shows the estimated wait for a new customer and flags a long wait at the rule's
   30 minutes. **Show the long-wait notice to customers** switches the notice the
   kiosk will show (Part 9); the switch is audited.
2. Call Thảo and do not answer. On her phone the only buttons are **Accept** and
   **Deny**: Break, Out and Check out wait until the call is answered.
3. After 15 minutes (or, to see it now, in Studio run
   `update turn_calls set called_at = now() - interval '16 minutes' where responded_at is null`)
   the block says "Thảo has not answered for 16 min" with **Clear the call**. Clear
   it: no penalty, the visit waits again, **Call next** is back.

## 8e. Skills, client attributes, timers and overrides (Part 6)

`npm run up` seeds three technicians with attributes and, the first time the
salon has no visits, four sample walk-ins (see `dev-codes.txt`): Thảo takes no
male clients; Linh takes no kids and nobody under 12; Mai does everything but
full sets and no both-at-once visits.

**Skills and restrictions** (owner or manager). Open **Staff**: each technician
row now has a one-line summary ("all services · no men · fast") and a **Skills
and restrictions** link.

1. On Mai's page: "Only these categories" with full_set unticked, "Not for
   two-at-once visits" ticked, the free-text note. Tick "No kids", **Save**:
   "Saved."; back on Staff the line reads "no kids". Studio → `audit_log` has
   `technician_profile_changed` with before and after.
2. Untick every category under "Only these": "Pick at least one category, or
   choose does every service". Put 0 in the minimum age: "Enter an age from 1
   to 120". Nothing was saved either time.
3. Sign in as Hạnh (receptionist): the page says owners and managers set skills.

**Who is skipped and why** (anyone at the desk). Check Thảo, Linh and Mai in on
their phones (/me, "I'm here", "I'm ready"). On the board the four sample
walk-ins wait with chips: "man", "kid, 8", "together", and a plain full set.

1. **Call next** on the man: Thảo is passed over; the amber box under Waiting
   says "Thảo: no male clients". Accept and finish on that phone.
2. **Call next** on the kid of 8: "Linh: no kids" (or, if Linh is not first,
   nobody is skipped: the engine only reports who was ahead of the pick).
3. The both-at-once pair is two lines, each with **Call next**; Mai is never
   called for either ("Mai: not for same-time visits").
4. The full set: with Thảo and Linh busy, "Nobody can be called right now.
   Nobody can take it: Mai: does not do full_set; ...".
5. New walk-in: tick "A kid", age 9, pick Linh as requested technician: Linh
   cannot be called for it; with "Anyone", Linh is skipped with "client too
   young for them".
6. Enter a phone with the walk-in, e.g. (813) 555-0199, twice: Studio →
   `clients` has one row with `+18135550199`. A phone like "12" says "Enter a
   US phone number, or leave it blank."

**Timers.** On Mai's phone tap **Out**: the phone says "Out for 0 min. After 60
min, 1 is added to your points"; the board's Needs attention block lists "Mai
out 0 min". To see the penalty now, in Studio run
`update technician_status set since = now() - interval '61 minutes', out_started_at = now() - interval '61 minutes' where status = 'out'`
and reload the board: "Mai out 61 min, over 60: penalty posted"; Mai's points
went up by 1 once (reload again: still once). Mai taps "I'm ready": no second
penalty.

**Overrides** (owner or manager). Open **Overrides** in the top bar
(http://localhost:3000/admin/manage).

1. **Today's penalties** lists Mai's "+1 for out over the limit" (and any deny).
   **Excuse** it with a reason: "Penalty excused.", the row shows "excused",
   Mai's points are back down. Excuse it again: not possible (the button is
   gone; the server also refuses: "already excused").
2. **Open visits**: move the man's visit to Thảo with a reason: "That technician
   cannot take it right now (no male clients)". Tick "Override skills,
   restrictions and the appointment buffer", move again: "Visit moved."; Thảo's
   phone shows the call. Studio → `audit_log`: `visit_reassigned` with
   `"forced": "no_male_clients"` and the reason.
3. Put Linh on break, try to move a visit to Linh with the override ticked:
   still refused ("on break"). Status is never overridden.
4. **Adjust points**: −½ for Thảo with a reason: "Points posted."; the board
   re-sorts; `audit_log` has `points_adjusted`.
5. Sign in as Hạnh: the Overrides tab is not in the bar and /admin/manage says
   owners and managers make overrides.
6. Two locations (automated only, `packages/db/test/eligibility.test.ts`): a
   manager at Brandon cannot reassign, excuse or adjust at Heavenly main.

## 8f. Appointments, the calendar feed, the second location (Part 7)

`npm run up` (or `db:seed:dev`) adds two appointments at the desk: Thảo in 25
minutes and Linh in two hours.

1. Sign in as Hạnh (`813 555 0102`) → **Appointments**. Both are listed,
   "entered at the desk". Check Thảo in on her phone: on the board, Call next on
   any walk-in skips her with "appointment in 25 min".
2. **Client arrived** on Thảo's: tick "Acrylic full set", press it. The board
   shows "Acrylic full set · for Thảo" and her phone is called (only her, even
   if someone else is ahead in line). Accept, Finished: she posts 0, and her
   row on the board reads **00**, under anyone else at a true 0.
3. Put Linh on break, then Client arrived on Linh's: "The visit is open and
   waits on the board for the booked technician." Back from break, Call next
   calls Linh.
4. **Add an appointment** by hand, then **Change** it and **Cancel it** with a
   reason. Studio → `audit_log`: `appointment_added`, `appointment_changed`,
   `appointment_cancelled`, with times only, no client name.
5. **The calendar feed from a local file** (the real fetch refuses anything not
   on the public internet, so a local server cannot be used):
   ```
   $env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
   npm run -w @turn/db feed:local -- "Mai" --sample
   ```
   It prints `added: 2` (a third, cancelled event is skipped). Appointments now
   shows two rows for Mai "from the calendar", without a Change button; the
   board says "Calendar last synced …". Run it again: `added: 0`. Any .ics file
   works in place of `--sample`; `packages/db/test/fixtures/sample.ics` is the
   test fixture.
6. **Calendar links** (owner): sign in as Phu → Appointments → Calendar links.
   Paste `http://example.com/a.ics`: "must start with https://". Paste
   `https://127.0.0.1/a.ics`: "points inside a private network". A real https
   link is saved and shown only as its host and last four characters; Studio
   cannot show the URL to an app user (`calendar_feeds` has no app grant).
7. **A failing calendar**: Studio → `calendar_feeds` → set `last_error` to
   `http_404` on Mai's row. The board shows a red line naming Mai's calendar,
   with "Tell the owner." for the desk.
8. **The scheduled poll**: set `CRON_SECRET` (32+ characters) in
   `apps/web/.env.local`, restart the web app, then
   `curl.exe -H "Authorization: Bearer <secret>" http://localhost:3000/api/feeds/poll`
   answers counts. Without the header: 401. Without `CRON_SECRET` set: always 401.
9. **The second location**: Phu's admin bar has a **Location** switch;
   choose "Heavenly Nails second" and the board, the desk and appointments are
   that location's. Kim (`813 555 0106`) signs in there as receptionist and
   sees only its rows; Châu (`813 555 0107`) is its technician.

## 8g. The audit log and reports (Part 8)

Do 8c or 8e first so the day has calls, a deny and an override.

1. Sign in as Hạnh (receptionist): the admin bar has no Log or Reports; open
   http://localhost:3000/admin/log by hand: "Only the owner and managers can
   open the log." A technician on `/admin/log` lands on `/me`.
2. Sign in as Vy (manager) → **Log**. Today's rows, newest first: check-ins,
   calls, the deny with its reason and answer time, points posted. Pick a
   technician: only their rows. Pick "Call denied": only denies. There is no
   Download button ("Only the owner can download the log.").
3. On a **Call sent** row open **Queue at that second**: everyone on shift with
   points and status; anyone on break shows "skipped: on break".
4. Sign in as Phu (owner) → Log → **Download CSV**. Open it in Excel: the same
   rows and columns as the screen, Vietnamese names intact, `-0.5` shown as
   text. Visit http://localhost:3000/admin/log/export signed in as Vy: 403.
5. **Reports**: today per technician (calls, denies, points by reason), and
   "Who changed what, last 7 days" with Vy's overrides and Hạnh's walk-ins.
   End of day says today is still open.
6. **End of day**: with `CRON_SECRET` set (see 8f.8),
   `curl.exe -H "Authorization: Bearer <secret>" http://localhost:3000/api/reports/daily`
   answers `{"locations":2,"written":…}`. Pick yesterday on Reports to see the
   stored summary; the owner's board shows "Yesterday (…)". Studio: an
   `update` on `daily_summaries` is refused ("append-only").

## 8h. The customer kiosk (Part 9)

Use two browser windows: a normal one signed in as staff, and a **private**
(incognito) window for the kiosk, so the kiosk never shares a sign-in.

1. **Pair.** In the private window open http://localhost:3000/kiosk: "Set up
   this iPad for customer check-in". Type the pairing code from
   `dev-codes.txt` (Sample kiosk). The check-in screen opens. Type the same
   code again in another private window: "That code did not work".
2. **Check in.** First name "Lan", phone `813 555 0142`, Next; pick a manicure,
   Next; "An adult", "A woman", Next; pick a technician (or "Anyone is fine"),
   Next; the fifth screen asks "Any design or special request?": type "french
   tip", **I'm here**. Every screen waits for its own Next: the technician
   screen must never be skipped (v0.10.2). "Thank you, Lan! Please take a
   seat." After about 12 seconds the screen is blank again. Try it in
   Vietnamese with the language button.
3. **Desk.** As Hạnh (or Phu) on `/admin`: the row says "Kiosk check-in,
   confirm before calling: Lan" with **Confirm** and **Not here**, and no Call
   next. A picked technician shows as a dark "Asked for An" tag and the note
   as "Request: french tip". **Edit request** on any waiting row changes or
   clears it (the Log shows "Special request changed", never the text). When
   An is called, An's `/me` call card shows "The client asked for you" and
   the request. Confirm,
   then Call next works as usual. The sample "Ngoc" row is there too: press
   **Not here** and it leaves the list.
4. **Things that should fail.** Leave the name empty and press Next: "Please
   type your first name." Phone `12`: sent back to the first question. Check in
   the same phone four times in a row: the fourth says "Please check in at the
   front desk". Type a phone you know is on file with a different name: the
   kiosk answers exactly the same. Nothing the kiosk typed touches a client
   until the desk confirms; after Confirm the row shows the stored name, which
   stays as it was. Press **Not here** on a new phone instead: no client is
   made at all.
   With a technician picked on the kiosk the row also has **Confirm, no
   request**: the visit goes to the line instead of waiting for that person.
5. **Idle.** Type a name and wait a minute without touching anything: the
   screen starts over, blank.
6. **Leave the kiosk.** Tap the salon name five times fast, type `0000`:
   "Wrong PIN". Type `1234`: staff sign-in. In the Log both tries are there.
   Typing http://localhost:3000/login on the paired window without the PIN
   goes back to the kiosk; so does waiting more than 2 minutes after the PIN.
   Sign in through the PIN, then leave the screen untouched for 5 minutes:
   the session signs out and the kiosk comes back.
7. **Admin → Kiosk** (Phu or Vy; Hạnh does not see it). The Sample kiosk shows
   "paired" and "last used". **Revoke** it, then go back to the private window
   and press I'm here: "This iPad is not set up for check-in". **Register an
   iPad** gives a new code; **Make this iPad the kiosk** in a normal window
   signs you out and opens the kiosk there.
8. **Kiosk mode.** On a browser that is paired, sign in as Hạnh (through the
   PIN): the admin header has **Kiosk mode**. It signs her out and opens the
   kiosk.
9. **Long wait.** On the desk switch "Show the long-wait notice to
   customers" on; the kiosk's thank-you screen says "We are busy right now".

## 8i. Hardening (Part 10)

1. **Not found.** Open http://localhost:3000/no-such-page: "This page does not
   exist", in both languages, with a way back.
2. **Offline.** On the desk or the kiosk, turn the computer's Wi-Fi off (or in
   the browser's developer tools, Network, choose Offline). A red bar says
   "No internet connection" and the buttons look paused; tapping one does
   nothing, and it is not sent later when Wi-Fi returns (blocked, not queued). Turn Wi-Fi back on: the bar goes away; **Try again** reloads.
3. **Drafts.** http://localhost:3000/terms and /privacy show the red "DRAFT,
   needs attorney review" box. Links at the bottom of the start page.
4. **Scans.** `npm run secrets:scan`, then `npm run build -w web` and
   `npm run bundle:scan`: both say "ok". Then `npm run start -w web` and, in
   a second window, `npm run pages:scan`: it fetches the public pages and says
   "ok" (v0.10.1). The full report is `docs/security/SEC-001-report.md`.
5. **Error reference (v0.10.1).** When an action fails for a reason nobody
   planned, the screen shows "Something went wrong" with a line such as
   "Reference: K7Q2MX", and the server window shows one line
   `failed { where, ref, kind, code }` with the same reference and no names
   or phones. `src/lib/failure.test.ts` checks the scrubbing.
6. **Screen reader (optional).** With VoiceOver on the iPad (or Narrator on
   Windows), a wrong kiosk answer is read out, and each **Call next** says
   whose visit it is.

## 8j. Connect Fresha calendars (v0.11.0)

You need a Fresha calendar export link (Fresha: your team member profile, the
calendar sync / export link; it starts with
`https://calendar-export.fresha.com/`). Treat it like a password.

1. **Owner, Appointments.** Sign in as Phu, open Appointments. At the top is
   "Connect Fresha calendars" with a row per technician.
2. **Wrong link.** Paste `https://calendar.google.com/x.ics` on Linh's row and
   press Test link: "That is not a Fresha calendar link…". Nothing is saved.
3. **Your link.** Paste your Fresha link, Test link. Expect "Link works, no
   appointments yet" (or "Found N upcoming appointments") and the calendar's
   name. If the name matches another technician you see "This calendar looks
   like …" and two Save buttons. Change one character in the box: Save
   disappears until you test again.
4. **Save.** Press Save for Linh. The row turns to "Connected, last synced …"
   and any appointments in the next month appear in the list below right
   away. View the page source: the link is not in it.
5. **Book a test appointment in Fresha** for that team member, wait for Fresha
   to update its file (it can lag up to 15 minutes), then press Sync now. It
   shows here and on Linh's `/me`.
6. **Disconnect.** Press Disconnect: "Not connected"; appointments it brought
   in stay.
7. **Technician.** Sign in as Linh (+18135550104). `/me` shows "Calendar: Not
   connected" and "Add your Fresha calendar". Open it, test, Save. `/me` now
   says "Connected, last synced …"; the link is never shown back.
8. **New technician.** Join with the technician invite code from
   `dev-codes.txt`: after sign-in you land on "Add your Fresha calendar" with
   Skip for now.
9. **New salon.** Set up a salon with the setup code: after sign-in you land
   on "Connect Fresha calendars" (no technicians yet, so it says so) with Skip.
10. **Log.** Log → "Calendar link tested", "Calendar link set", "Calendar link
    removed": who and when, never the link.

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

Push to the phone (the end-of-day summary included) and the Expo app. Heavenly's real Fresha feed has not been opened yet.

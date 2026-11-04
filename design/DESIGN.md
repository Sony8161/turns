# Turn system: design plan

2026-11-04 · Draft for Duong's review before Part 2 screens are built.

## Subject and job

A nail salon front desk. Four surfaces, one visual system:

| Surface                                            | Who                                  | Distance          | Job                                                  |
| -------------------------------------------------- | ------------------------------------ | ----------------- | ---------------------------------------------------- |
| Turn board (receptionist iPad, landscape, mounted) | front desk, techs glancing over      | 1 to 3 m          | who is next, who is busy, how long a call has waited |
| Customer kiosk (second iPad)                       | walk-in customers, any age, EN or VI | 40 cm             | check in in under a minute without help              |
| Admin web (laptop or phone)                        | owner, manager                       | normal            | invite staff, set rules, read the log                |
| Tech app (Expo, later)                             | technicians                          | phone in a pocket | accept or deny a call in one tap                     |

The memorable thing is the **points column**: 0, 00, ½, 1, 1½, 2 set large, the way the paper turn card wrote them. Everything else stays quiet so that column reads from the back of the salon.

## Tokens

### Colour

The proposal PDFs Phu has already seen use navy, pink and teal. Keep those so the product looks like the thing he agreed to. Drop the cream paper from the PDFs: iPads in a salon sit under bright light and glare, and a warm cream background is also the most common generated-design tell. Surfaces are white and a cool grey.

| Name   | Hex       | Use                                                                |
| ------ | --------- | ------------------------------------------------------------------ |
| Board  | `#FFFFFF` | the board and kiosk surface                                        |
| Pumice | `#EEF0F3` | page background behind boards, dividers, disabled                  |
| Slate  | `#2B3444` | text and the in-service state; a blue-grey ink, not tinted black   |
| Navy   | `#1F2A37` | admin chrome, primary buttons                                      |
| Polish | `#C2185B` | one job: attention. A call waiting for an answer, an error, a deny |
| Teal   | `#2A9D8F` | available, confirmed, success                                      |
| Amber  | `#D9A441` | break, out, late (never alone: always with the word)               |

Status is always colour **and** a word **and** position in the list. Colour alone carries nothing (WCAG, and the board is read in sunlight).

### Type

One family: **Be Vietnam Pro** (Google Fonts). Chosen because it was drawn for Vietnamese first, so every diacritic stack (ậ, ữ, ở) sits correctly at display size, and because its wide weight range covers a 120 px scoreboard number and 15 px admin text without a second face. Tabular figures on, so points and timers line up.

Scale (major third, 1.25, from 16 px):

- Points on the board: 112 px / weight 800, with real fraction glyphs for ½ (`font-variant-numeric: diagonal-fractions`), never "1.5"
- Tech name on the board: 40 px / 600
- Status word and timer on the board: 24 px / 500
- Kiosk question: 40 px / 600; kiosk buttons: 28 px / 600
- Admin headings: 25 px / 600; admin body: 16 px / 400, line length 70 ch max
- Small labels: 13 px / 500, sentence case. No all-caps labels, no tracked eyebrows.

Vietnamese and English strings are equals: every screen is designed with the longer of the two, which is usually Vietnamese.

### Layout

**Board** (the hero on every surface that shows it, including the public landing page). One column, the queue order top to bottom, no cards, no borders. Each tech is a row; the left edge of the row carries a 12 px bar in the status colour; points sit left in the big size like the number on a turn card; name and status follow; the timer sits right. A call waiting for an answer gets the Polish bar and the time it has waited, counting up. Position in the list is the only numbering, because position **is** the sequence.

```
┌─────────────────────────────────────────────────────────┐
│ Heavenly Nails, main             Tue Nov 4   2:14 pm  VI │
├─┬───────────────────────────────────────────────────────┤
│▌│  0    Linh        available                      0:42 │
│▌│ 00    Mai         available                      1:05 │
│▌│  ½    Thảo        called, pedicure         waiting 0:38 │  <- Polish bar
│▌│  1    Hương       in service, full set            0:21 │
│▌│ 1½    An          break                     back 0:12 │
│▌│  2    Kim         out                            0:47 │
└─┴───────────────────────────────────────────────────────┘
```

Left aligned throughout. The board scrolls only if more than eight techs are on; it is sized to fit a salon's floor on one iPad screen.

**Kiosk.** One question per screen, centred, the question at the top, answers as large buttons in a single column or a 2 by 2 grid, one "Back" at bottom left, language toggle top right (EN / VI, both always visible). Progress shown as "2 of 4" in words, not a bar. Last screen says what happens next: "Take a seat. The front desk will call your name."

**Admin.** Left navigation (Board, Staff, Rules, Log, Settings), content column max 72 ch, left aligned, forms one field per row, primary button Navy, destructive actions Polish and always with a reason field. No dashboard tiles: the admin home is the live board, smaller, with today's counts beneath it as a sentence ("14 visits today, 2 denies, 1 override").

**Login and invite.** Single centred column, the salon name as the heading once the invite code is recognised, phone or email, then the code. Three screens, each with one input.

### Motion

One kind of motion, on one trigger: when the queue order changes, rows slide to their new position over 300 ms so the desk can see who moved and why. Nothing animates on page load. Hover does nothing on an iPad, so nothing depends on it. `prefers-reduced-motion` turns the slide into an instant swap.

## Principles

1. Readable from three metres, in sunlight, by someone glancing while holding a phone.
2. One glance answers "who's next". Anything that slows that glance is cut.
3. Colour and word and position, never colour alone.
4. Vietnamese is not a translation layer; both languages are designed for.
5. Structure carries information: a bar means status, position means order, a reason field means the action is logged. No decoration.
6. Targets 44 px or larger on every touch surface; visible focus for keyboard users on admin.

## Writing

Plain verbs, sentence case, the same name for the same action everywhere: "Call next" produces "Called Thảo". Errors say what happened and what to do: "That invite code has been used. Ask the owner for a new one." Empty board: "Nobody is checked in yet." Kiosk never says "Submit"; it says "I'm here".

## Review against the generic defaults

- Cream background with serif display and a clay accent: **avoided**; white and cool grey, one sans, pink from the client's own palette.
- Near-black with one acid accent: **avoided**.
- Broadsheet hairlines and dense columns: **avoided**; the board has no rules at all, only the status bar.
- SaaS card kit: **avoided**; no cards anywhere, no shadows, radius only on buttons (8 px) and inputs.
- Template chrome (caps eyebrows, middle dots, arrows on buttons, monospace data): **avoided**.
- Numbered markers: used only as list position on the board, where position is the sequence.

What is specific to this brief and would not appear on a generic dashboard: the points column as the hero with fraction glyphs, a typeface chosen for Vietnamese, the status bar replacing borders, and motion only when the order changes.

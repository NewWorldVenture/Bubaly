# FamilyOS — Friction Backlog ("Project Zero Friction")

A **living, prioritized list of remaining friction** — the measurable roadmap
toward *"Less Managing Life. More Living It."* Every session should: pick the
top actionable item, implement a materially better experience, verify, ship,
then **update this file** (mark done, re-rank, add newly-discovered friction).

**How to read it**
- **Impact** = how much cognitive load / taps / stress it removes (High/Med/Low).
- **Effort** = build size (S ≤ ~1 session · M = 1–2 · L = multi-session).
- **Score** = rough priority = Impact ÷ Effort (do High/S first).
- **Lane** — to avoid colliding with parallel sessions: `engine` (pure libs +
  Moments/AI, this thread's lane) · `ui` (layout/design-system) · `platform`
  (infra/push/cron/Stripe) · `admin`.

Keep entries small and independently shippable. Prefer **inferring the answer**
over adding another form.

**Companion artifact:** `docs/EXPERIENCE_SCORECARD.md` measures how good each
journey is *now* (taps / time / a11y / recovery). Read both before every cycle —
this Register = *what to fix next*, the Scorecard = *current journey health*.

---

## ✅ Already shipped (do NOT redo — see AGENT_HANDOFF.md for detail)
- **Anticipatory "Moments"** — one event/birthday → coordinated cross-module prep
  (leave-by, **real weather** advisory, snacks→one-tap Grocery, budget, health,
  photos), with **conflict detection** ("Overlaps Sam's recital"). `/dashboard/moments`
  + Home "Get ready" banner. Engines: `lib/moments/{prep,birthdays,weather,conflicts}.ts`.
- **Delight** — "On this day" memory resurfacing (Home strip + Memories card).
- **Mobile foundation** — safe-area chrome, dialog focus-trap, 44px touch targets,
  wide-table overflow (family-facing).
- **Customization** — Navigation Choices (sidebar + sub-pages), Capture shortcuts
  (chosen-only, Customize-gated, 10 rows), in-app camera on Create Memory.

---

## 🔥 Prioritized backlog

| # | Friction (the felt problem) | Fix (infer / remove / merge) | Impact | Effort | Score | Lane | Deps | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | Home surfaces the next moment but to act you must open `/dashboard/moments` — an extra screen switch for the single most common action (setting the leave-by reminder). | Add a **one-tap "Set reminder"** inline on the Home "Get ready" banner (reuses `createMomentReminderAction`). | High | S | ★★★ | engine | — | ✅ **DONE** (892241b+) |
| 2 | No universal natural-language entry on every screen — users still navigate to the assistant. "Plan Emma's birthday" should work from anywhere. | Global **⌘K / "+" command bar** that routes NL → assistant/capture/moment actions. Capture already parses; extend to a floating omni-input. | High | L | ★★ | engine+ui | assistant, capture parse | Todo |
| 3 | Weather advisory only appears on the Moments page, not the Home "Get ready" banner (which shows a generic "check forecast" chip). | Pass the forecast advisory into `HomeMomentCard` too (reuse `weatherAdvisory`), or fetch once at the Home level. | Med | S | ★★★ | engine | `lib/moments/weather` | ✅ **DONE** (3a362d5+) |
| 4 | Moment prep steps are all manual checkoffs; high-confidence ones (e.g. "add team snacks") could self-complete or pre-stage. | Fold moment prep into the **Autopilot confidence engine** so ≥90% steps auto-execute reversibly (it already does this for reminders). | High | M | ★★ | engine | `lib/autopilot/*` | Todo |
| 5 | Nothing reaches the family when they're **not** in the app — an imminent moment/birthday should push. | Push-notify on imminent moment/leave-by/birthday via the existing web-push + `PushNotifications` plugin + a scheduled scan (autopilot cron already runs per-family). | High | M | ★★ | platform | web-push, cron | Todo |
| 6 | Travel buffer (leave-by) is a per-category constant, not a real ETA — can be wrong in traffic. | Derive buffer from a routing/ETA source using the family's home + event location. | Med | M | ★ | platform | maps/ETA API, home location | Todo |
| 7 | Home is static across the day; morning vs. night should show different "what matters now". | **Time-of-day Mission Control** — reorder/condense Home sections by hour (morning: schedule/weather/school; night: tomorrow/reflection). | Med | M | ★★ | ui | home data | Todo |
| 8 | Roles (child/teen/grandparent/caregiver/babysitter/guest) largely see the same surfaces. | Role-tailored Home + nav density/language per `family_members.role`. | Med | L | ★ | ui | roles | Todo |
| 9 | ~24 internal `/admin/**` tables still clip on mobile (family-facing ones fixed). | Wrap in `overflow-x-auto` in an admin-mobile pass. | Low | S | ★★ | admin | — | Todo |
| 10 | Recurring routines (school mornings, weekly practice) aren't recognized as reusable templates. | Detect recurring event clusters → offer a saved "routine" with its prep bundle. | Med | L | ★ | engine | autopilot twin | Todo |
| 11 | Moment reminders all fired at a blanket ~20h/2h, so a packing nudge and a shopping nudge landed at the same unhelpful time. | Per-domain lead times (packing → night before, shopping → 2 days out, photo → at event). | Med | S | ★★★ | engine | — | ✅ **DONE** (5887a60+) |
| 12 | "Add N to grocery" from a moment had **no undo** — an unexpected write with no reversal (Scorecard-flagged trust gap). | Return inserted ids + `removeMomentGroceryAction`; toast offers **Undo** that deletes exactly those rows. | Med | S | ★★★ | engine | — | ✅ **DONE** (02e7c0d+) |
| 13 | Double-booking warning only showed on the Moments page, not Home — but Home is where families glance. | Surface the same `findOverlaps` "Overlaps X" amber chip on the Home "Get ready" banner. | Med | S | ★★★ | engine | `lib/moments/conflicts` | ✅ **DONE** (c4d6718+) |
| 14 | The Moments page is a flat grid; with 30-day birthdays + events it grows long and undifferentiated (scanning effort, no "what's now" hierarchy). | Group into **Today / Tomorrow / This week / Later** sections with headers + counts. | Med | S | ★★★ | engine | — | ✅ **DONE** (73d6036+) |

*(Re-rank as items ship. Add newly-found friction with a one-line "felt problem".)*

---

## Iteration log
- **2026-07-03** — Per user request: aligned the Free-tier left nav to the
  **Navigation Choices** page exactly — removed the "Parent Dashboard" +
  "Family Dashboard" (`DASHBOARD_NAV`) links from `FreeTierSidebar`, since that
  page doesn't manage them. Sidebar's editable region now == the Navigation
  Choices list; fixed chrome (AI Assistant / Settings / Help) + the All Services
  launcher stay. `/dashboard` routes remain reachable by URL.
- **2026-07-03** — Backlog created. Shipped **#1**: the Home "Get ready" banner
  now has an inline **"Remind me"** button — the body still opens Moments, but
  the leave-by (or top) reminder can be set in one tap without a screen switch.
  Expected benefit: removes 1 navigation + 2 taps from the day's most common
  action. Next up: **#3** (weather advisory on the Home banner, Impact Med / S)
  or **#4** (Autopilot self-completion, High / M).
- **2026-07-03** — Shipped **#3**: the Home "Get ready" banner now shows the real
  forecast advisory ("Rain likely 70% — pack umbrellas") on its weather chip,
  matching the Moments page. Refactored the forecast fetch into a shared
  `useDefaultForecast(familyId)` hook (`components/moments/use-default-forecast.ts`)
  used by both surfaces — removed the duplicated effect from `MomentsView`.
  Next: **#4** (Autopilot self-completion, High / M) or **#7** (time-of-day
  Mission Control, Med / M).
- **2026-07-03** — Shipped **#11** (newly surfaced): smart reminder timing.
  `lib/moments/reminders.ts` (`reminderLeadMinutes` / `reminderTimeFor`, tested,
  6 cases) picks a per-domain lead time (packing → night before, shopping →
  ~2 days out, photo → at the event, leave-by → the leave time) and clamps to
  the future. Wired into both remind paths (Moments page + Home banner),
  replacing the blanket 20h/2h. Expected benefit: reminders arrive when they're
  actually actionable. #4 and #7 remain (bigger; #4 touches the shared Autopilot
  engine + cron, #7 the contended home/page.tsx — sequence carefully vs parallel
  sessions).

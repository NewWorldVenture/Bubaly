# FamilyOS — Open TODOs

A single, current list of open work. Source-of-truth detail lives in
`docs/FRICTION_BACKLOG.md` (what to fix next) and `docs/EXPERIENCE_SCORECARD.md`
(journey health). Keep this file in sync as items ship.

_Last updated: 2026-07-03._

## 🔥 Open friction backlog (from docs/FRICTION_BACKLOG.md)
- [ ] **#2 — Global command bar** (High / L): ⌘K + "+" omni-input on every screen that routes natural language → assistant/capture/moment actions. (Capture parse already exists.)
- [ ] **#4 — Autopilot self-completes moment prep** (High / M): fold high-confidence (≥90%) moment prep steps into the Autopilot confidence engine so they auto-execute reversibly. *(engine lane — may be in progress)*
- [ ] **#6 — Real travel-buffer ETA** (Med / M): derive leave-by from a routing/ETA source (home + event location) instead of a per-category constant. *(needs a maps/ETA API key)*
- [ ] **#7 — Time-of-day Mission Control** (Med / M): reorder/condense Home sections by hour (morning: schedule/weather/school · night: tomorrow/reflection).
- [ ] **#8 — Role-tailored surfaces** (Med / L): Home + nav density/language per `family_members.role` (child/teen/grandparent/caregiver/babysitter/guest).
- [ ] **#10 — Recurring-routine templates** (Med / L): detect recurring event clusters → offer a saved "routine" with its prep bundle.

### ✅ Recently verified done (were listed open but already shipped)
- #5 Push on imminent moment/leave-by/birthday — `generateFamilyNotifications` creates them + `dispatchPendingPushes` cron delivers. (Confirmed 2026-07-03.)
- #9 Admin tables clip on mobile — every `/admin/**` table already wrapped in `.table-responsive`. (Confirmed 2026-07-03.)

## 🧭 Scorecard journey gaps (from docs/EXPERIENCE_SCORECARD.md)
- [ ] **Onboarding → first value** (biggest opportunity): ~8–12 taps, 3–5 typed fields, several switches, ~2–4 min. Target time-to-first-value < 90s — defer/infer every non-essential field. *(not yet audited)*
- [x] Add a memory — per-file upload progress (2026-07-03).
- [x] Add a memory — Undo on the success screen (2026-07-03).
- [x] Add a memory / Photos upload — 25 MB pre-check with friendly skip message (2026-07-03).

## 🧩 Dead / stubbed UI to finish or hide
- [ ] **Messages → GIF picker** (`messages-module.tsx`): currently toasts "coming soon". Needs a GIF provider (GIPHY/Tenor) API key, then insert as an attachment.
- [ ] **Messages → Voice messages** (`messages-module.tsx`): "coming soon". Needs record → upload (family-media) → playback.
- [ ] **Wallet → Spending cards / real-time balance** (`money-cards-view.tsx`, `child-detail-view.tsx`): "coming soon" (Stripe Issuing) — legitimately future; keep honest until infra lands.
- [ ] **Family page → "Wi-Fi & Passwords"** (`family-module.tsx`): links to Files with no count — no backing table yet (a secure-vault/passwords store would give it a real destination + count).

## 🧱 Polish / consistency
- [ ] Extend the upload progress + 25 MB guard pattern to the Files/documents single-upload (`documents-module.tsx`) and `trip-memories-module.tsx` for consistency.
- [ ] Instrument journeys (a `journey_started/completed` event + step counter) so the Scorecard uses real medians instead of estimates.

## 🗺️ Planned roadmap (product vision — status: Planned)
Larger, category-defining bets. All marked **Planned**.
- [ ] **Wallet** — Full family financial OS.
- [ ] **Allowance** — AI allowance coaching.
- [ ] **AI Concierge** — Become category-defining.
- [ ] **Family Memory** — Build a persistent family knowledge graph.
- [ ] **Voice Control** — Full conversational interface.
- [ ] **Phone Concierge** — AI receptionist for families.
- [ ] **Email Concierge** — AI inbox management.
- [ ] **Predictive Planning** — Recommend next best actions.
- [ ] **AI Automation** — Multi-step autonomous workflows.
- [ ] **Home Management** — Maintenance and inventory automation.
- [ ] **Vehicle Management** — AI maintenance scheduling.
- [ ] **Marketplace** — Buy, sell, rent, borrow within the platform.
- [ ] **Family Operating System** — Own this positioning (north-star framing for all of the above).

## ⛔ Standing rules (see /memory.md)
- Do **not** modify the global left navigation for all accounts without explicit instruction. Per-user Navigation Choices customization is fine.

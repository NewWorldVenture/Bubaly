# FamilyOS — Roadmap Build TODO

**Goal:** Ship every roadmap feature below at **100% fully developed** and **100% wired to
Supabase** (real family-scoped tables + RLS, no mock data). This file is the single source of
truth for the build — work top to bottom, keep it in sync, and don't mark a feature `DONE`
until every box under it is checked.

Companion docs: `docs/FRICTION_BACKLOG.md` (what to fix next) and
`docs/EXPERIENCE_SCORECARD.md` (journey health).

**Definition of "done" per feature (the checklist each one must pass):**
- [ ] **Schema** — additive, idempotent migration with family-scoped RLS via `public.is_family_member`, validated on PG16.
- [ ] **Types** — hand-maintained rows added to `lib/database.types.ts` (`T<Row,Insert,Update>`).
- [ ] **Server lib** — pure/tested logic + Supabase reads/writes (no mock data anywhere in the path).
- [ ] **UI module** — production component, optimistic where sensible, undo/confirm on destructive.
- [ ] **Route** — `app/(app)/dashboard/<feature>/page.tsx` using `requireUserContext()`.
- [ ] **Nav** — entry in `lib/constants/navigation.ts` + Navigation Choices catalog.
- [ ] **Verified** — `tsc`, `eslint`, `vitest`, `next build` all green.

Legend: ☐ open · ◐ partial (scaffolding exists) · ☑ done

---

## Roadmap features (from the product roadmap)

### 1. Marketplace — "Buy, sell, rent, borrow within the platform"  ☑ DONE
- [x] Migration `0120_marketplace.sql`: `marketplace_listings` (kind sell/rent/borrow/free/wanted, price_cents, rent_period, category, condition, status, claimed_by), `marketplace_offers` (interest/claim/offer), family-scoped RLS. Validated: all 120 migrations apply on PG16, idempotent re-run clean, RLS+trigger+FK verified.
- [x] Types for both tables in `lib/database.types.ts`.
- [x] `lib/marketplace/listings.ts` — labels, money math, filter/rank, offer/claim state machine (pure). Tests `tests/marketplace-listings.test.ts` (10 tests).
- [x] `components/modules/marketplace-module.tsx` — browse+filter, post/edit, interest/claim, owner offer review (accept→hand-off, decline), withdraw/complete. 100% Supabase via `useRealtimeQuery`.
- [x] Route `/dashboard/marketplace` + admin-only `/dashboard/marketplace/seed` (500-record test seed screen).
- [x] Nav entry (Family & Home group, `Store` icon).
- [x] Verified: tsc, eslint, vitest (1562), build.

### 2. Wallet — "Full family financial OS"  ◐ (already wired)
Has `wallet_cards/passes/rewards` (0113), `/wallet` route, `lib/wallet/*`. Audit confirmed the
surfaces read/write Supabase (10+ `.from()` calls, realtime). Remaining honest gaps:
- [ ] Spending cards / real-time balance (`money-cards-view.tsx`, `child-detail-view.tsx`) say "coming soon" — needs Stripe Issuing (legit future infra; keep honest until it lands).

### 3. Allowance — "AI allowance coaching"  ☑ DONE
Has `allowance_rules`, `lib/wallet/allowance.ts`, `lib/wallet/coach.ts`; surfaced under `/wallet`.
- [x] Confirmed: allowance schedule posts to the immutable ledger (cron `/api/cron/wallet-allowance` →
  `creditChildWallet`, split-allocated, advances `next_run_on`) and the AI coach reads real ledger balances.
- [x] **Parent control added:** `runDueAllowancesAction()` — a "Run due now" banner on `/wallet/allowance`
  (manager-only, Basic-gated, Trust-gated) pays every due rule, idempotent with the cron (no double-pay).
  Pure `dueAllowances(rules, today)` helper (+2 tests) drives the count/total. Was cron-only before.

### 4. AI Concierge — "Become category defining"  ◐ (already wired)
`/dashboard/concierge`, `lib/concierge/digest.ts`; module has 6 `.from()` + realtime. No mock data.
- [ ] Stretch: deeper write-back of accepted recommendations.

### 5. Family Memory — "Build persistent family knowledge graph"  ◐
`/dashboard/family-memory` + `/dashboard/family-knowledge-graph`, `lib/memories/*`.
- [x] Persistent store shipped — **Family Knowledge Base**: migration `0123_family_facts.sql` (family-scoped RLS; sizes/allergies/contacts/preferences/accounts, member-tagged or family-level, pinnable), pure `lib/memory/facts.ts` (8 tests: filter/search/group), `components/modules/knowledge-base-module.tsx` at `/dashboard/knowledge` (search + member/category filters, add/edit/pin/copy/delete). Nav: Family AI OS, `Brain` icon. Validated on PG16; verified tsc/eslint/1637 tests/build. *(The `/dashboard/family-knowledge-graph` visualization can now read this store.)*

### 6. Voice Control — "Full conversational interface"  ☑ DONE
- [x] `lib/voice/command-router.ts` — wake-word stripping + intent routing → capture kind, reusing `suggestKind`/`parseEvent`. Tests `tests/voice-command-router.test.ts` (12 cases).
- [x] Migration `0121_voice_commands.sql` — family-scoped RLS history log. Validated on PG16 (RLS, 4 policies, check constraint, idempotent).
- [x] `components/modules/voice-module.tsx` — Voice Command Center: `useSpeechRecognition` mic + editable transcript + live routing preview → `saveCapture` (real rows) → logs `voice_commands` → toast w/ Undo. Recent-commands history (realtime) with one-tap re-run + delete. Graceful type-only fallback when Web Speech unsupported.
- [x] Route `/dashboard/voice` + nav (Family AI OS, `Mic` icon; auto-included in NAV_CATALOG / Navigation Choices).
- [x] **Test seed** `supabase/seed_voice_one_family.sql` + `db:seed:voice` — 500 `voice_commands` for the
  target family (task/note/event/shopping + failed/dismissed, ~90 days). Deterministic-UUID idempotency
  (no tag column). Validated on PG16 (500 rows, idempotent re-run). So `/dashboard/voice` history renders full.
- [x] Verified: tsc, eslint, vitest, build.

### 7. Phone Concierge — "AI receptionist for families"  ◐ (already wired)
`/dashboard/front-desk`; module has 8 `.from()` + realtime. Wired.

### 8. Email Concierge — "AI inbox management"  ◐ (already wired)
`/dashboard/inbox` Communications Hub; module has 10 `.from()` + realtime. Wired.

### 9. Predictive Planning — "Recommend next best actions"  ◐ (wired via Moments)
`lib/opportunities/deadlines.ts` + Moments engine surface next-best-actions on Home. Wired.
- [x] Dedicated "Next Best Actions" feed page — `lib/opportunities/next-actions.ts` (pure, 7 tests: bucketing overdue→someday, priority tie-break, human reasons) + `components/modules/next-actions-module.tsx` merging real events + open tasks + open opportunities into one ranked worklist at `/dashboard/next-best-actions` (nav: Suggested, `Target` icon). Inline task-complete. No migration (reads existing tables). Verified tsc/eslint/1629 tests/build.

### 10. AI Automation — "Multi-step autonomous workflows"  ◐ (already wired)
`/dashboard/family-automation`, `/dashboard/autopilot`, `lib/autopilot/engine.ts`. Wired.
- [x] #4 Fold ≥90%-confidence moment-prep steps into the Autopilot engine (reversible auto-exec) — `momentPrepSuggestions(snapshot)` in `lib/autopilot/engine.ts` reuses the shared `buildMomentPrep` to emit, for imminent (≤2d) moments, the two SAFE reversible steps at auto-tier: a **leave-by reminder** (conf 92 → reuses the existing `create_reminder` executor) and a **snacks/supplies grocery list** (conf 91 → new reversible `add_groceries` executor in `scan.ts` that inserts grocery_items). Weather/packing/photo stay as on-screen suggestions. 5 new engine tests (36 total). Verified tsc/eslint/1649 tests/build.

### 11. Home Management — "Maintenance and inventory automation"  ◐ (already wired)
`/dashboard/home`, `lib/home/maintenance.ts`, `lib/home/devices.ts`; module has 10 `.from()`. Wired.

### 12. Vehicle Management — "AI maintenance scheduling"  ◐ (already wired)
`vehicles` + `vehicle_registrations/inspections` (0037), `/dashboard/auto/vehicles`, `lib/auto/*`. Wired.

### 13. Family Operating System — "Own this positioning"  (meta)
- [x] Cross-feature cohesion (nav/customization): audited `NAV_CATALOG` (only `minLevel 0` items are customizable in Settings → Navigation Choices). This session's Knowledge Base + Next Best Actions were already free (0); per user decision, **Marketplace + Voice Control lowered to `minLevel 0`** so all four new features are free-tier and selectable in Navigation Choices (the pages were never plan-gated anyway).

---

## Other open features (carried from the Friction Backlog / Scorecard)
- [x] #2 Universal ⌘K natural-language command bar — DONE. `lib/command-bar/route.ts` (pure, 8 tests) +
  `components/app/command-bar.tsx` (global palette in app-shell, ⌘K / "/" open, navigate/capture/assistant,
  reuses the Voice/capture parser). See the "⌘K + 💸" handoff block.
- [ ] #6 ETA-based travel buffer for leave-by (needs a maps/ETA API key).
- [x] #9 Admin-mobile table overflow — DONE. Audited every `<table>` under `app/(app)/admin` (27 total):
  14 already wrapped, **13 wrapped** in `overflow-x-auto` + `min-w-[720px]` (admins, users, audit-logs,
  audit, content, security, subscriptions, support-tickets, sync). Class-only; tsc/eslint/build green.
- [x] #7 Time-of-day Home Mission Control — DONE. `lib/home/time-of-day.ts` (pure, 6 tests: dayPhase /
  phaseGreeting / phaseBlurb / focusForPhase) + `components/home/time-of-day-focus.tsx` "Focus now" strip
  at the top of `/home` (morning: schedule/weather/school · night: tomorrow/get-ready/reflect). Additive —
  did not refactor the contended grid. Server-time based (no per-user tz yet).
- [◐] #8 Role-tailored surfaces — **slice 1 shipped**: pure `lib/ui/role-surface.ts` (10 tests) —
  `roleSurface(role)` → { density, tone, canManage, focusMax } + `roleGreeting`/`focusHeadline` — applied
  to the Home "Focus now" strip (role-tailored heading + trimmed focus set for kids/guests). Density +
  management-affordance rollout to more surfaces (nav, dashboards) = follow-up.
- [x] #10 Recurring-routine templates — **DONE**. Migration `0122_routine_templates.sql`
  (`routine_templates` + `routine_template_items`, weekday bitmask, family-scoped RLS) +
  pure `lib/routines/detect.ts` (13 tests: `detectRoutines` finds title+weekday+time repeating
  ≥3 weeks; `materializeRoutine` expands a template → concrete `calendar_events`) +
  `components/modules/routines-panel.tsx` in the calendar right rail (detect → "Save as routine",
  create/edit with weekday toggles + ordered steps, "Apply to this week" with one-tap Undo, delete).
  100% Supabase/realtime. tsc/eslint/**1612 tests**/build green.
- [x] Onboarding → first value (audited + first win): the **PIN step was mandatory** (Continue disabled until a 4-digit PIN matched), forcing every new user through 2 extra fields + validation before reaching the app — even though `completeProfileOnboardingAction` already treats an absent PIN as valid. Made it **"Skip for now"** (defers PIN to Settings → App Lock). Onboarding is now 1 required field (name) → skip → done. *(Onboarding telemetry doesn't fit `journey_events`: no family_id exists until completion — would need an anonymous/pre-family analytics path.)*

## Dead / stubbed UI to finish or hide
- [ ] Messages → GIF picker (`messages-module.tsx`): toasts "coming soon" — needs a GIF provider key.
- [x] Messages → Voice messages — DONE. `MediaRecorder` in `messages-module.tsx` records a clip → uploads through the existing `sendFile` path (kind `audio`, 25 MB cap + rollback) → renders an inline `<audio controls>` player. Live timer + cancel/discard; graceful "not supported" fallback. 100% Supabase (family-media storage + family_messages row).
- [x] Family page → "Wi-Fi & Passwords" — shipped as the Family Vault: `family_credentials` table + `/dashboard/passwords` (CRUD, mask/reveal/copy, RLS). *(parallel session)*

## Polish / consistency
- [x] Size guard consistency for `documents-module.tsx` + `trip-memories-module.tsx` — both are single-file uploads (no progress bar to add; Supabase JS `upload()` has no progress event). The 25 MB guard already existed in `lib/storage/documents.ts`; exported `DOCUMENT_MAX_BYTES`/`DOCUMENT_MAX_MB`, added **fail-fast pre-checks at file-pick time** in both, and fixed the Documents dropzone's misleading "up to 50 MB" copy → the real 25 MB.
- [x] Journey telemetry pipeline — migration `0124_journey_events.sql` (append-only, family-scoped RLS), pure `lib/analytics/journey.ts` (7 tests: median/summarize/format), client `useJourney(key)` hook (fire-and-forget started/step/completed, errors swallowed), instrumented the **Capture** journey (quick-capture: start on open, complete on save), and a super-admin `/dashboard/journeys` page showing real per-journey completion rate + median time/steps. Instrument more flows by calling `useJourney('key')`. *(Cross-family aggregate medians would need a service-role read.)*

## Standing rules (see /memory.md)
- Do **not** modify the global left navigation for all accounts without explicit instruction. Per-user Navigation Choices customization is fine. (The Marketplace nav entry above was an explicit roadmap build.)

---

## Build log (append as features land)
- **Marketplace** shipped (migration 0120, lib+tests, module, route, nav). Commit `213718d`.
- **Marketplace test seed**: `lib/marketplace/seed-sql.ts` (500 listings + ~290 offers,
  all kinds/statuses, idempotent full-reseed per family) + admin-only screen at
  `/dashboard/marketplace/seed` (Copy SQL button, iPad-friendly). Validated on PG16:
  500 rows, every pending listing has offers, re-run stays 500.
- **Voice Control** shipped (migration 0121, `lib/voice/command-router.ts`+12 tests, `voice-module.tsx`, `/dashboard/voice`, nav). Web Speech → route → real capture rows + `voice_commands` history. Verified: tsc/eslint/1578 tests/build. **+ 500-row `voice_commands` seed** (`seed_voice_one_family.sql` / `db:seed:voice`, PG16-validated).
- **Universal ⌘K command bar** (Friction #2) shipped: `lib/command-bar/route.ts` (pure, 8 tests) + `components/app/command-bar.tsx` (global palette in app-shell; ⌘K / "/" open; navigate/capture/assistant; reuses the Voice/capture parser). 1588 tests / tsc / eslint / build green.
- **Allowance** (roadmap #3) completed: parent-run `runDueAllowancesAction()` + "Run due now" banner on `/wallet/allowance` (idempotent with the cron, Trust+tier gated) + pure `dueAllowances` helper (2 tests). Wallet also gained CSV **statement export** + a 500-row child-ledger seed (`seed_wallet_ledger_one_family.sql`).
- **Time-of-day Home Mission Control** (Friction #7) shipped: `lib/home/time-of-day.ts` (pure, 6 tests) + `components/home/time-of-day-focus.tsx` "Focus now" strip at the top of `/home`, phase-adaptive (morning: schedule/weather/school · night: tomorrow/get-ready/reflect). Additive; 1599 tests / tsc / eslint / build green.
- **Recurring-routine templates** (Friction #10) shipped: migration `0122`, `lib/routines/detect.ts`
  (13 tests), `RoutinesPanel` in the calendar rail (detect → save → apply-to-week w/ Undo). Commit on
  `main` via merge of `claude/routine-templates`. 1612 tests / tsc / eslint / build green.
- **Next up:** all 12 roadmap features built + wired + seeded. Remaining agent-doable Friction Backlog:
  **#8 role-tailored surfaces** (density/language per `family_members.role`; `ui`) · **#4 Autopilot
  self-completion of ≥90%-confidence moment-prep** (`engine`, touches shared `lib/autopilot/*`) · the
  **onboarding time-to-value < 90s** audit. Blocked/human-owned: #6 ETA travel buffer (maps API key),
  Stripe Issuing cards, applying pending prod migrations (0118/0120/0121…) in the Supabase SQL editor,
  per-platform OAuth keys, CI Supabase login for authed e2e. **Recommended next:** #10 recurring-routine
  templates (high value, self-contained `engine` lane) or #8 role-tailored surfaces.

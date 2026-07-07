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

## ★ NORTH STAR — The Family Operating Layer (category-defining, 2026-07-05)

> **Thesis:** today's products (ours included, so far) are **systems of record** — they
> store calendars, lists, notes. Bubaly's category-defining move is to become a **system of
> execution**: an AI-native operating layer that actively helps families *get things done* and
> **measurably reduces time spent on family administration**. The defining metric is NOT daily
> active users — it's **hours of coordination/decision effort removed**. Don't compete
> feature-for-feature; define the category others chase.

---

## ⚑ OPEN ITEMS & DECISIONS — single source of truth (2026-07-06)

> ### ▣ EVERYTHING STILL OPEN — consolidated (as of 2026-07-06, evening)
>
> The agent-doable **code** backlog is essentially drained; what genuinely
> remains is **owner / external** action. Shipped this session on top of the
> merged reasoning + moat layer: onboarding→marketing wiring + **child logins
> without email** (#235), role-tailored **nav gating** (#236), marketing header
> text size (#237), role-based **Focus-strip density** (#238), **Kid-Logins nudge**
> on the onboarding Done screen (#239), and screen-reader **progress bars** —
> onboarding (#240) + **app-wide** (#241).
>
> **OPEN — owner / external (NOT code; the agent cannot execute these):**
> 1. **Apply pending prod migrations** — `supabase db push` (incl. `0105_child_logins`
>    + `0118`→`0135`, or paste `supabase/APPLY_PENDING_0118-0135.sql`). **THE blocker:**
>    child logins, the whole reasoning layer (FOI, playbook, agents, graph, decisions,
>    prep plans), and network consent silently no-op in prod until applied.
> 2. **Set prod env vars** — `CHILD_LOGIN_SECRET` (child username+PIN sign-in) and
>    `CRON_SECRET` (`model-refresh` + `network-aggregate` crons).
> 3. **Provider keys** — each lights up an already-built path: **VAPID/FCM** (push) ·
>    **Maps/ETA** (Friction #6 travel buffer) · **GIF provider** (Messages/photos picker) ·
>    **Stripe Issuing** (real Wallet card balances) · **CI Supabase login** (authed e2e).
> 4. **Activate the `onboarding_completed` marketing workflow** so onboarding fires it.
> 5. **Intelligence Network launch gate** — insights only surface at **≥100** consenting families.
>
> **OPEN — agent-doable follow-ups (small, no blocker; do when directed):**
> - **Role density, broader rollout** — slices 1–3 shipped (trimmed focus set → nav
>   management-gating → Focus-strip chip density). Extend density/tone to more dashboards.
> - **Instrument real journey medians** — Playwright "taps to complete" harness +
>   `journey_events` step counter, to replace the Experience Scorecard's design-time estimates.
> - **Friction #6 travel buffer** — code-ready; needs the Maps/ETA key (owner item 3 above).
> - **Twin projector** — add doctors / smart-home entities once those domains land.
> - **GIF picker** (Messages/photos) — code path exists; needs the provider key (owner item 3).
> - [x] **Social share cards (OpenGraph / Twitter)** ✅ — `app/opengraph-image.tsx` +
>   `app/twitter-image.tsx` render a brand-gradient 1200×630 card (Bubaly wordmark + tagline)
>   via `next/og`, shared from `lib/og/social-image.tsx`. Fully self-contained (wordmark
>   inlined from disk, no network fetch). Fixes the previously-blank `summary_large_image`
>   preview on iMessage/Slack/X/Facebook. Build-verified (both routes generate).

### A. Decisions only the owner can make
- [x] **Intelligence Network aggregation** ✅ — decisions signed off + pipeline **built**
  (`0135_network_aggregates.sql`, `lib/network/aggregate.ts` +9 tests, `network-aggregate` cron,
  real insights on `/dashboard/intelligence`). Approved defaults: K=20, low DP noise (Laplace 1.5),
  cohort = kids-band × household-size, **no** geography, launch gate **≥100 families**.
  Seed `seed_network_aggregates.sql`. (`docs/INTELLIGENCE_NETWORK_DESIGN.md` now marked SIGNED OFF + BUILT.)
- [x] **Global nav entries added this session** ✅ CONFIRMED (owner 2026-07-06): keep the left
  navigation as-is and keep all four — Reasoning Graph, Decision Engine, Prep Plans, Intelligence
  Network (all `minLevel: 0`). They live in **All Services + the Navigation Choices catalog** (users
  pin/add them); **deliberately NOT promoted into the default `PRIMARY_NAV` rail** — the default rail
  stays curated. No further change.

### B. Operational — prod go-live (owner action, not code)
- [ ] **Apply migrations 0125→0135 to prod** (`supabase db push`, or paste `supabase/APPLY_PENDING_0118-0135.sql`).
  THE blocker — everything reads these; silently no-ops until applied.
- [ ] **Set `CRON_SECRET` in prod** → activates the `model-refresh` + `network-aggregate` crons.
- [ ] Keys that light up already-built paths: **VAPID/FCM** (push) · **Maps/ETA** (travel buffer) ·
  **GIF provider** (Messages picker) · **Stripe Issuing** (Wallet card balances).

### C. Genuinely-open product items (agent-doable)
- [x] **FOI financial dimension** ✅ — already wired: `countOverspentBudgets` (real budgets vs
  this-period expenses) + real accounts-below-zero in `lib/operating-index/server.ts`. (Stale entry — verified done.)
- [x] **Onboarding pre-family telemetry** ✅ — `0133_onboarding_events.sql` + `lib/analytics/onboarding.ts`
  (11 tests) + `onboarding-track.ts` wired into the wizard + super-admin `/dashboard/onboarding-funnel`
  + `seed_onboarding_events.sql` (550 events). Validated on PG16.
- [x] **AI Concierge write-back** ✅ — already wired: create plans, update status
  (planning/completed/cancelled), delete, and convert a plan → real `calendar_events`. (Stale entry — verified done.)
- [x] **Twin auto-refresh trigger** ✅ — `0134_model_dirty.sql`: `family_model_dirty` flag +
  SECURITY DEFINER trigger on every cross-domain source table; `needsRefresh()` (dirty wins, else TTL,
  3 tests); the `model-refresh` cron prioritizes dirty families + clears the flag. Now event-driven.
- [ ] **Messages GIF picker** — blocked on the provider key. *(external key — not agent-doable)*
- [x] **Kid-login brute-force hardening** ✅ (2026-07-07) — the no-email child sign-in (username +
  4-digit PIN) had NO throttle, so a guessable username + 10k PINs was brute-forceable. Added a durable
  per-username lockout: pure `lib/auth/child-throttle.ts` (10 tests: window/lockout/escalation/reset)
  + `0137_child_login_throttle.sql` (service-role-only table, RLS deny-all; PG16-validated) wired into
  `childSignInAction` (locks after 5 fails/15 min, escalating; cleared on success) and cleared on a
  parent PIN reset. Degrades safely before the migration is applied (still works, just un-throttled).
  Doc: `CHILD_LOGIN_SECRET` + `0137` added to `PENDING_PROD_MIGRATIONS.md`.
  *(Phone-number deep-dive deferred: the parallel session is actively rewriting `phone-auth`/OTP on
  main — building there now would collide. Revisit once that settles.)*

> **Section C status: closed except the GIF picker (needs an external provider key).** All four
> agent-doable items are done — 2 built this session (onboarding telemetry, twin trigger), 2 were
> already wired (FOI financial, Concierge write-back).

### D. ★ Moat layer shipped this session (all validated: 1838 tests / tsc / eslint / build)
- [x] **Knowledge Graph** — `0129`, `lib/graph/reason.ts` (16 tests, impact propagation), `/dashboard/graph`, `seed_graph.sql`.
- [x] **Twin cross-domain projector** — `lib/twin/project.ts` (8 tests) + `projectTwinAction` (pillar #2's linked model).
- [x] **Decision Engine** — `0130`, `lib/decisions/engine.ts` (9 tests), `/dashboard/decisions`, `seed_decisions.sql`.
- [x] **Chief of Staff ↔ graph** — `lib/agents/graph-insight.ts` (6 tests): hubs + ripple into briefings.
- [x] **Prep Plans (autonomous planning)** — `0131`, `lib/planning/prep.ts` (10 tests), `/dashboard/prep-plans`, `seed_prep_plans.sql`.
- [x] **Life Readiness (horizon rollup)** — `lib/readiness/assess.ts` (11 tests), embedded on `/dashboard/readiness`.
- [x] **Intent-Based UX** — `lib/intent/detect.ts` + command-bar integration (18 tests).
- [x] **Auto-refresh cron** — `lib/planning/refresh.ts` (8 tests) + `app/api/cron/model-refresh` + `vercel.json`.
- [x] **Intelligence Network (full)** — `0132` consent + k-anonymity (`lib/network/insights.ts`, 9 tests)
  + informed-consent preview (`lib/network/contribution.ts`, 6 tests) + `0135` **aggregation pipeline**
  (`lib/network/aggregate.ts`, 9 tests; `network-aggregate` cron; real insights on `/dashboard/intelligence`).

### E. Full 500-record seed coverage
- [x] Every user-facing surface has a validated, idempotent 500-row seed (see the Seed-coverage tracker below).

---

**The nine pillars (build order is top-down from the reasoning core):**

1. **AI Operating Layer** — a *platform layer* (not per-feature AI) that continuously reasons
   across the whole household and answers: *What's most likely to go wrong tomorrow? What can be
   completed automatically today? Who's overloaded this week? What should the family decide next?
   What information is missing before an important event?* The AI is an **orchestrator**, not a
   collection of assistants.
2. **Household Digital Twin** ✅ SHIPPED — one continuously-updated model linking people,
   relationships, calendars, home, vehicles, pets, schools, finances, etc. **Both halves now built:**
   (a) **decision simulation** (`lib/twin/simulate.ts`, `/dashboard/family-digital-twin`) — "if we
   accept this tournament, what has to move?"; and (b) the **cross-domain linked model** — the
   Knowledge Graph (see below): a wired **twin projector** (`lib/twin/project.ts` + `projectTwinAction`)
   reads the family's real members/pets/vehicles/schools/teams/routines/places/accounts and
   materializes them as typed graph entities + edges, kept in sync on demand. Remaining scope:
   auto-refresh on data change (currently a one-tap "Rebuild from data") + doctors/smart-home once
   those domains land.

★ **Knowledge Graph — the reasoning substrate** ✅ SHIPPED (moat build) — migration `0129`
   (`graph_entities` + `graph_edges`, typed nodes + directed weighted edges, family RLS), pure
   engine `lib/graph/reason.ts` (16 tests: index/neighbours/`findPath`/`reachable`/`propagateImpact`
   impact blast-radius/`hubs`/`orphans`/`describePath`), `/dashboard/graph` ("Reasoning Graph")
   with path-finder, connection view, impact ripple bars, hubs, add-entity/link, and **Rebuild from
   data** (twin projector). 500-row `seed_graph.sql`. This is what lets the AI *reason across*
   relationships (Emma→Soccer→Field→Weather→Dinner) instead of retrieving isolated rows.
3. **Family Intelligence Layer / Playbook** — every interaction improves understanding; build a
   family playbook (favorite meals, birthday/holiday traditions, travel styles, homework habits,
   shopping patterns, communication styles). Family stays in control (visible + editable — the
   Knowledge Base `family_facts` is the seed of this).
4. **Outcomes, not features** — organize around goals (**Run Today · Feed the Family · Plan a Trip
   · Prepare for School · Manage Money · Keep Everyone Healthy · Celebrate Together · Prepare for
   the Unexpected**); the AI picks the underlying capabilities automatically.
5. **Family Command Center** — a concise morning operational briefing (today's priorities,
   conflicts, weather impacts, budget alerts, deliveries, health reminders, school updates, AI
   recs) and an evening summary of what changed + tomorrow prepped. *(Scaffolds exist:
   `/dashboard/command-center`, `/dashboard/briefing` — unify + make the briefing generative.)*
6. **Specialized AI agents behind one interface** ✅ SHIPPED — Chief of Staff · Scheduler · Meal
   Planner · Budget Coach · Household Manager · School Coordinator · Health Guide · Travel Planner ·
   Memory Keeper · Communications Assistant. User sees one assistant; agents collaborate internally.
   - Pure `lib/agents/roster.ts` (**11 tests**): 10-agent roster; `runAgent`/`chiefOfStaff`/
     `runAllAgents` turn a real `AgentContext` into per-agent briefings (status + deep-linked items);
     Chief of Staff synthesizes the top items across specialists.
   - Migration `0127_agent_activity.sql` — durable, family-scoped RLS log of what each agent
     surfaces/does (kind/severity/status, done/dismissible). PG16-validated (RLS, constraints, trigger).
   - `/dashboard/agents` (`components/modules/agents-module.tsx`): server reads a real snapshot →
     live briefings; roster grid w/ status dots; per-agent items + recent activity (Done/Dismiss
     writes back). Nav: Suggested → Family Assistant (`Bot`, free). 100% Supabase.
   - Seed `supabase/seed_pillar6_agents.sql` — 500 activity records across all 10 agents (idempotent).
   - Verified: tsc · eslint · **1723 vitest** · build.
7. **Family Operating Index (FOI)** — measure how well the household is *functioning* (not to
   judge): planning confidence, schedule stability, financial preparedness, household readiness,
   communication responsiveness, routine completion, goal progress. Surface **practical
   suggestions**, not vanity scores. **← FIRST SLICE, building now.**
8. **Design for Calm** ✅ SHIPPED — fewer notifications, ONE prioritized inbox, an AI daily digest,
   gentle escalation only when necessary. Reduces mental load; does not maximize engagement.
   - Pure `lib/calm/inbox.ts` (**7 tests**): `buildCalmInbox(items)` folds every signal source
     (agents · autopilot · Operating Index · approvals · reminders) into ONE de-duplicated, ranked
     list — `needsYou` (action only, capped), `today` (attention, capped), and a `quieted` count for
     the rest; `calmDigest` writes the gentle one-liner; `noiseReduced` = notifications spared.
   - `/dashboard/calm` (`components/modules/calm-module.tsx`): server reads the real sources → the
     calm inbox; a digest header, "Needs you" + "For today" sections, and everything else
     deliberately collapsed. **No migration** (pure aggregation of shipped tables). 100% Supabase.
   - Nav: Suggested → Calm (`Leaf`, free). Verified: tsc · eslint · **1730 vitest** · build.
9. **Family API** ✅ SHIPPED (hub) — the orchestration hub that *connects* external services
   (calendars, email, banking, grocery/delivery, smart home) rather than replacing them.
   - Pure `lib/connections/providers.ts` (**8 tests**): the provider registry (11 providers × 5
     categories) + `mergeConnections(rows)` folding the catalog with a family's saved connections
     (live-wins-over-disconnected), `groupByCategory`, `connectedCount`.
   - Migration `0128_family_connections.sql` — durable, family-scoped RLS connection records
     (provider/category/status/account_label/last_synced_at; `unique(family_id,provider,external_account_id)`).
     PG16-validated. **No tokens stored here** — those belong in a secret store.
   - `/dashboard/connections` (`components/modules/connections-module.tsx`): grouped provider hub,
     Connect (upsert a real connection) / Disconnect, live status, realtime. 100% Supabase.
   - Nav: Suggested → Connections (`Network`, free). Seed `supabase/seed_pillar9_connections.sql`
     (500 records, all providers × statuses, idempotent).
   - **Gated for later (needs provider keys):** the actual OAuth/token exchange + live two-way data
     sync per provider. The hub, model, and CRUD are production-ready now; enabling a provider = wiring
     its OAuth against these records. Verified: tsc · eslint · **1738 vitest** · build.

### ▶ Slice 1 ✅ SHIPPED: Family Operating Index — the measurable core of the Operating Layer
- [x] **Schema** `0125_family_operating_index.sql` — append-only daily snapshots (composite +
  per-dimension jsonb + suggestions), family-scoped RLS (select/insert/update), one row/family/day
  (`unique(family_id, as_of_date)`). PG16-validated: idempotent re-run, upsert-in-place, RLS + 3 policies.
- [x] **Engine** `lib/operating-index/score.ts` (pure, **12 tests**) — `computeOperatingIndex(snapshot,
  now)` → 7 dimension scores (0–100) + weighted composite + band (thriving/steady/stretched/overloaded)
  + ranked practical suggestions (each deep-linked) + `mostLoaded()` overload detection. Deterministic,
  DOM-free. Calm/empty household reads as *thriving*, never zero.
- [x] **Server** `lib/operating-index/server.ts` — builds the snapshot from real tables (calendar,
  reminders, chore_assignments, documents, maintenance, bills, approvals, votes/polls, goals + reuses
  `detectConflicts`), computes, **upserts today's snapshot idempotently**, returns current + prior
  composite for the trend arrow. **✅ FULLY WIRED (2026-07-05):** every input now reads live data —
  `overspentBudgets` (budgets vs this-period expenses, pure/tested `lib/operating-index/inputs.ts`, 7
  tests), `negativeBalances` (financial_accounts < 0, excl. credit), `lowInventory` (pantry ≤
  low_threshold), `eventsMissingInfo` (upcoming events needing a location), `unreadThreads`
  (conversations not read by all active members). No stubs remain. tsc/eslint/vitest/build green.
- [x] **Route** `/dashboard/family-operating-index` — composite ring dial + band, trend vs. yesterday,
  "Do these next" ranked suggestions (deep-linked), per-dimension bars w/ honest one-line summaries,
  "who's overloaded" line. 100% Supabase.
- [x] **Nav** entry (Operating Index, `Gauge`, minLevel 0 → free + auto in Navigation Choices catalog).
- [x] **Verified** tsc · eslint · **1661 vitest** · `next build`; migration validated on PG16.

### ▶ Slice 2 ✅ SHIPPED: "Since yesterday" evening recap (pillar #5, off the FOI snapshot)
- [x] **`lib/operating-index/summary.ts`** (pure, **8 tests**) — `summarizeChange(current, prior)`
  diffs two FOI snapshots → headline + composite delta + improved/declined dimensions (≥5-pt moves)
  + resolved/emerged suggestions (by id). Calm end-of-day tone; leads with cleared items; silent on
  a flat day. First-reading path handled.
- [x] **Server** now reads the prior **full** snapshot (dimensions + suggestions) and returns
  `change: ChangeSummary` alongside the index.
- [x] **"Since yesterday" card** on `/dashboard/family-operating-index` (headline + cleared/new/±dim
  chips). Reuses the state vector — zero contended files touched. tsc/eslint/**1669 tests**/build.

### ▶ Pillar #4 ✅ SHIPPED: Outcomes-not-features launcher
- [x] **Engine** `lib/outcomes/launcher.ts` (pure, **10 tests**) — the eight outcomes (Run Today ·
  Feed the Family · Plan a Trip · Prepare for School · Manage Money · Keep Everyone Healthy ·
  Celebrate Together · Prepare for the Unexpected); `buildOutcomePlan(id, ctx)` assembles each
  outcome's capability steps (deep-linked) and auto-badges the urgent ones from a real
  `OutcomeContext` (events today, overdue tasks, birthdays soon, open grocery items);
  `outcomeUrgencyCount` for the card badge. DOM-free.
- [x] **Route** `/dashboard/outcomes` — server reads the real family snapshot (count queries +
  birthday compute), builds badged plans, hands them to `components/modules/outcomes-launcher.tsx`
  (goal-first picker → the exact capabilities to get it done, with live badges). 100% Supabase, no
  new migration (reads existing tables).
- [x] **Nav** entry (Suggested → Outcomes, `Wand2`, minLevel 0 → free + in Navigation Choices catalog).
- [x] **Verified** tsc · eslint · **1709 vitest** · `next build`.

**Next slices (build order):** #1 wire the five orchestrator questions ("what's likely to go wrong
tomorrow / who's overloaded / what to decide next / what info is missing") off the same snapshot ·
#2 turn the snapshot into the Digital Twin's state vector for simulation · adopt `summarizeChange`
inside the existing Command Center / Daily Briefing surfaces (ui lane — coordinate vs. parallel session).

*(Why FOI first: it's the one pillar with no existing surface, it forces the reasoning core to
read across the entire household — the seed of pillar #1 — and it makes the north-star metric
[reduced admin effort] measurable from day one. Later slices reuse its snapshot as the twin's
state vector and the Command Center's evening "what changed" source.)*

---

## ☐ OPEN WORK TRACKER (single source of truth for what's left — keep in sync)

### 🌱 Test-data / seed coverage (as of 2026-07-05)
**37 seed files** exist under `supabase/` — most domains have a 500+-record `*_one_family.sql`
(scoped to The Kramer Family `92298eb2…`, idempotent): calendar · tasks · chores · meals(+extras) ·
finances · finance-hub · memories · messages · wallet(+ledger) · voice · location · family · family-safety ·
files · planning · food · home · roles(#8) · pillars 1–6 & 9. **NEW `seed_operating_index_one_family.sql`**
(≈613 records) lights up the FOI (#7) end-to-end — every wired input fires (overspent budgets, a
spendable account < 0, low pantry, expiring docs, overdue maintenance/reminders, off-track goals,
missing-location events, colliding events for conflicts). Run it, then open
`/dashboard/family-operating-index`.
- ☐ Remaining seed gaps to close for "every feature at full capacity": **pillars 7/8 detail tables**
  (FOI snapshot history over N days for real trend lines; role permission surfaces), **approval_requests /
  meal_votes / family_polls** volume (comms dimension — FK-chained, needs parent rows), **autopilot_suggestions**
  (orchestrator Q2). The FOI comms/routine dims are covered today by running `seed_messages` + `seed_chores`.

### A. Operating Layer slices still to build (agent-doable, build top-down)
- [x] **Slice 1 — Family Operating Index** (engine + page + 0125). PR #227. ✅
- [x] **Slice 2 — "Since yesterday" evening recap** (pillar #5, off the FOI snapshot). PR #228. ✅
- [x] **Slice 3 — Orchestrator questions** (pillar #1) ✅: the five daily questions —
  *what's most likely to go wrong tomorrow · what can auto-complete today · who's
  overloaded this week · what should we decide next · what info is missing before an
  important event.* Pure `lib/operating-index/orchestrator.ts` (**10 tests**) over the
  FOI snapshot + a tomorrow slice; reads open ≥90-confidence `autopilot_suggestions`
  for Q2 (read-only reuse, no engine edit); "Your family chief of staff" section on the
  FOI page. tsc/eslint/**1679 tests**/build.
- [x] **Slice 4 — Command Center adopts the recap** (pillar #5) ✅: shared server-safe
  `components/operating-index/change-recap.tsx` renders the "since yesterday" narrative from a
  `ChangeSummary`; the FOI page and `/dashboard/command-center` both reuse it (DRY), and it's also
  surfaced in the `/dashboard/briefing` **Evening** tab (via an optional `recap` prop). Seed
  `seed_operating_index_all_families.sql` writes yesterday+today snapshots across ALL families so
  the recap renders a real narrative everywhere (composite move + cleared/new + dimension shifts).
  tsc/eslint/1699 tests/build; migration 0125 + seed validated on PG16 (idempotent).
- [x] **Slice 5 — Household Digital Twin: decision simulation** (pillar #2) ✅: pure
  `lib/twin/simulate.ts` (**10 tests**) `simulateDecision(decision, ctx)` — safe "what-if" that
  runs against real data but writes nothing. Two scenarios: **add a commitment** ("if we accept this
  tournament, what has to move?" → overlaps as blockers, tight turnarounds, heavy-week load) and
  **a big spend** ("can we add two nights and stay in budget?" → real budget-vs-transactions
  headroom). Server action `simulateDecisionAction` (family-scoped reads) + client `DecisionSimulator`
  on `/dashboard/family-digital-twin`. tsc/eslint/**1679 tests**/build. *(Full linked state-vector
  reuse of the FOI snapshot = follow-up; this slice ships the category-defining simulation first.)*
- [x] **Slice 6 — Family Playbook** (pillar #3) ✅: Bubaly learns durable preferences/traditions
  from real usage and proposes them; the family confirms → real `family_facts` rows.
  Migration `0126_family_playbook.sql` (`family_playbook_suggestions`: category/label/value/
  evidence/confidence/signature/status suggested→accepted/dismissed/`fact_id`, `unique(family_id,
  signature)`, family-scoped RLS). Pure `lib/playbook/learn.ts` (**10 tests**) `learnPlaybook(signals)`
  → deduped/ranked/capped suggestions from meal/grocery/favorite/tradition signals. Server actions
  `refreshPlaybookAction` (mines meal_plans+meals, grocery_items, family_favorites, yearly
  calendar_events → upsert, `ignoreDuplicates` so dismissed/accepted never resurface) /
  `acceptSuggestionAction` (writes family_facts) / `dismissSuggestionAction`. `/dashboard/playbook`
  (`components/modules/playbook-module.tsx`: review cards w/ confidence + evidence, Save/Dismiss,
  realtime) + nav (Family AI OS, `Wand2`, free). Seed `seed_playbook_all_families.sql` across ALL
  families. tsc/eslint/**1699 tests**/build; migration+seed validated on PG16 (idempotent).
- [x] **Slice 7 — Outcomes launcher** (pillar #4) ✅: goal launcher at `/dashboard/outcomes`
  ("Run Today / Feed the Family / Plan a Trip / …") auto-selecting capabilities. Seed `seed_pillar4_outcomes.sql`.
- [x] **Slice 8 — Specialized agents behind one interface** (pillar #6) ✅: `lib/agents/roster.ts`
  (10-agent roster + Chief of Staff, 11 tests), `agent_activity` (`0127`), `/dashboard/agents`.
  **Now graph-aware** — the Chief of Staff reasons over relationships (`lib/agents/graph-insight.ts`).
  Seed `seed_pillar6_agents.sql`.
- [x] **Slice 9 — Design for Calm** (pillar #8) ✅: `lib/calm/inbox.ts` (one prioritized inbox +
  digest, 7 tests), `/dashboard/calm`. Seed `seed_pillar8_calm.sql`.
- [x] **Slice 10 — Family API** (pillar #9) ✅ (hub, functionally key-gated): `0128_family_connections.sql`,
  `lib/connections/providers.ts` (8 tests), `/dashboard/connections`, Connect/Disconnect CRUD.
  Seed `seed_pillar9_connections.sql`. **Remainder: OAuth token exchange + live sync needs provider keys.**

### B. Smaller follow-ups (agent-doable)
- [ ] FOI financial dimension: real **budget-overspend** (budgets vs expenses) + **negative
  ledger balance** detection (currently 0 — placeholders in `lib/operating-index/server.ts`).
- [ ] Onboarding: infer/defer more; anonymous **pre-family telemetry** path (`journey_events`
  is family-scoped, no family_id until completion).
- [ ] AI Concierge: deeper **write-back of accepted recommendations**.

### C. Human-owned / blocked (NOT agent-doable — surfaced, not buildable here)
- [ ] **Apply pending prod migrations 0125→0132** (`supabase db push`, or paste each in the
  Supabase SQL editor). **Highest leverage** — the whole reasoning layer (FOI, playbook, agents,
  connections, knowledge graph, decisions, prep plans, network consent) reads these; they silently
  no-op in prod until applied (this is why the seed hit the missing `habits` table).
  *Agent cannot execute — no prod DB creds/CLI in sandbox (verified).*
- [ ] **Set `CRON_SECRET` in prod** → activates the `model-refresh` cron (twin + prep-plan auto-refresh).
- [ ] **VAPID/FCM keys** → lights up the push path (already built).
- [ ] **Maps/ETA key** (Friction #6 travel buffer) · **GIF provider key** (Messages picker) ·
  **Stripe Issuing** (real-time Wallet card balances) · **CI Supabase login** (authed e2e).

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

### 5. Family Memory — "Build persistent family knowledge graph"  ☑ DONE
`/dashboard/family-memory` + `/dashboard/family-knowledge-graph`, `lib/memories/*`.
- [x] Persistent store shipped — **Family Knowledge Base**: migration `0123_family_facts.sql` (family-scoped RLS; sizes/allergies/contacts/preferences/accounts, member-tagged or family-level, pinnable), pure `lib/memory/facts.ts` (8 tests: filter/search/group), `components/modules/knowledge-base-module.tsx` at `/dashboard/knowledge` (search + member/category filters, add/edit/pin/copy/delete). Nav: Family AI OS, `Brain` icon. Validated on PG16; verified tsc/eslint/1637 tests/build. *(The `/dashboard/family-knowledge-graph` visualization can now read this store.)*
- [x] **Learning layer shipped** — the **Family Playbook** (North Star slice 6, see above) mines real household usage into suggested facts the family confirms into this same `family_facts` store. `/dashboard/playbook` + `0126_family_playbook.sql`.

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
- [◐] #8 Role-tailored surfaces — **slices 1–3 shipped**: (1) pure `lib/ui/role-surface.ts` (10 tests) —
  `roleSurface(role)` → { density, tone, canManage, focusMax } + `roleGreeting`/`focusHeadline` — applied
  to the Home "Focus now" strip (role-tailored heading + trimmed focus set for kids/guests). (2) **Nav
  management-affordance gating**: `NavItem.manage` + pure `isNavItemVisibleToRole` (4 tests) hide
  manager-only destinations (e.g. Kid Logins) from kids/teens/guests across the primary rail, All
  Services, and mobile tabs (super-admins still see them) — the page guards already redirect those roles,
  so the links were dead-ends. (3) **Density rollout**: pure `focusChipClasses(role)` (3 tests) maps
  `roleSurface().density` → chip sizing, wired into the Home "Focus now" strip — kids ('playful') get
  bigger, rounder, more-tappable chips; adults ('comfortable') keep compact ones; teens/guests ('cozy')
  sit between. Finally consumes the `density` field. Broader dashboard density = further follow-up.
- [x] #10 Recurring-routine templates — **DONE**. Migration `0122_routine_templates.sql`
  (`routine_templates` + `routine_template_items`, weekday bitmask, family-scoped RLS) +
  pure `lib/routines/detect.ts` (13 tests: `detectRoutines` finds title+weekday+time repeating
  ≥3 weeks; `materializeRoutine` expands a template → concrete `calendar_events`) +
  `components/modules/routines-panel.tsx` in the calendar right rail (detect → "Save as routine",
  create/edit with weekday toggles + ordered steps, "Apply to this week" with one-tap Undo, delete).
  100% Supabase/realtime. tsc/eslint/**1612 tests**/build green.
- [x] Onboarding → first value (audited + first win): the **PIN step was mandatory** (Continue disabled until a 4-digit PIN matched), forcing every new user through 2 extra fields + validation before reaching the app — even though `completeProfileOnboardingAction` already treats an absent PIN as valid. Made it **"Skip for now"** (defers PIN to Settings → App Lock). Onboarding is now 1 required field (name) → skip → done. *(Onboarding telemetry doesn't fit `journey_events`: no family_id exists until completion — would need an anonymous/pre-family analytics path.)*

## ★ Seed coverage — 500-record test data per feature (2026-07-05)

> **Goal:** every feature testable at volume (≥500 rows). The DB has **354 base tables**;
> most are join/config/derived tables that don't need bulk data. What matters is that every
> **user-facing surface** has a validated, idempotent, paste-ready 500-row seed. All seeds
> below resolve the family by email, are re-runnable (delete-by-sentinel / ON CONFLICT), and
> were validated on a throwaway PG16 (500 rows each, stable across re-runs).

**✅ DONE — secondary user-facing tables now seeded at 500 rows** (all validated on PG16,
idempotent, stable across re-runs):
- [x] Messages — `family_messages` (all kinds) → `seed_messages.sql`
- [x] Chores — `chores` + `chore_assignments` (full status lifecycle) → `seed_chores.sql`
- [x] Meals — `meals` + `family_recipes` + `meal_plans` → `seed_meals.sql`
- [x] Documents — `documents` (categories + expiry + secure) → `seed_documents.sql`
- [x] Location / Safety — `family_places` + `member_locations` + `location_events` → `seed_location.sql`
- [x] Finance hub — `financial_accounts` + `transactions` + `bills` → `seed_finance.sql`
- [x] Memories / trips — `family_memories` + `trip_memories` → `seed_memories.sql`
- [x] Autopilot — `autopilot_suggestions` + `approval_requests` → `seed_autopilot.sql`
- [x] Family Vault — `family_credentials` (all 9 categories, migration 0119 applied + validated) → `seed_vault.sql`

**☑ One-paste master runner:** `supabase/SEED_ALL.sql` runs all 23 seeds in dependency order
(one paste → every surface at ≥500 rows). Idempotent; validated on PG16.

**☑ Validated 500-row seeds (paste-ready in `supabase/`):**

| Feature / surface | Table(s) seeded | File |
|---|---|---|
| Messages | `family_messages` | `seed_messages.sql` |
| Chores | `chores`, `chore_assignments` | `seed_chores.sql` |
| Meals | `meals`, `family_recipes`, `meal_plans` | `seed_meals.sql` |
| Documents | `documents` | `seed_documents.sql` |
| Location / Safety | `family_places`, `member_locations`, `location_events` | `seed_location.sql` |
| Finance hub | `financial_accounts`, `transactions`, `bills` | `seed_finance.sql` |
| Memories / trips | `family_memories`, `trip_memories` | `seed_memories.sql` |
| Autopilot | `autopilot_suggestions`, `approval_requests` | `seed_autopilot.sql` |
| Family Vault | `family_credentials` | `seed_vault.sql` |
| Knowledge Graph / Twin | `graph_entities`, `graph_edges` | `seed_graph.sql` |
| Decision Engine | `family_decisions`, `decision_options` | `seed_decisions.sql` |
| Prep Plans | `prep_plans`, `prep_plan_steps` | `seed_prep_plans.sql` |
| Onboarding funnel | `onboarding_events` | `seed_onboarding_events.sql` |
| Intelligence Network aggregates | `network_aggregates` (+opts family in) | `seed_network_aggregates.sql` |
| Calendar, To-Dos, Groceries, Notes, Photos, Journal, Habits | `calendar_events`, `todo_items`, `grocery_items`, `notes`, `family_photos`, `journal_entries`, `habits` | `seed_core_content.sql` |
| #1 AI Orchestrator | `family_events`, `family_polls` | `seed_pillar1_orchestrator.sql` |
| #2 Household Twin | `budgets`, `calendar_events`, `family_routines`, `school_classes`, `teams` | `seed_pillar2_twin.sql` |
| #3 Playbook | `family_playbook_suggestions` | `seed_pillar3_playbook.sql` |
| #4 Outcomes launcher | `calendar_events`, `grocery_items`/`grocery_lists`, `todo_items`/`todo_lists` | `seed_pillar4_outcomes.sql` |
| #5/#7 Command Center + Family Operating Index | `family_operating_index` | `seed_pillar5_command_center.sql` |
| #6 Agent roster | `agent_activity` | `seed_pillar6_agents.sql` |
| #8 Design for Calm | `reminders` (due <24h) | `seed_pillar8_calm.sql` |
| #9 Connections / Family API | `family_connections` | `seed_pillar9_connections.sql` |
| Marketplace | `marketplace_listings`, `marketplace_offers` | `lib/marketplace/seed-sql.ts` → `/dashboard/marketplace/seed` |
| Voice Control | `voice_commands` | `seed_voice_one_family.sql` |
| Wallet / Allowance | child ledger | `seed_wallet_ledger_one_family.sql` |

> **Honest note:** seeding + validating *all* 354 tables in one pass isn't feasible — most are
> internal (junction, settings, audit, materialized). The list above covers every table behind a
> real screen. Each remaining item is a 15-min job using the exact pattern in `seed_core_content.sql`.

---

## Dead / stubbed UI to finish or hide
- [ ] **Messages → GIF picker** (FUTURE FOLLOW-UP — needs an external provider key). Stub:
  `components/modules/messages-module.tsx` (~line 876) — the "GIF" button toasts "coming soon".
  **Implementation plan** (code-complete + key-gated, mirror the Family-API pattern):
  1. Pick a provider — **Giphy** or **Tenor** (both have free tiers + search endpoints).
  2. Add the key to env: `GIPHY_API_KEY` (server) — proxy GIF search through a route
     (`app/api/gif/search/route.ts`) so the key never ships to the client.
  3. Build a `GifPicker` popover (query input → grid of results → pick → send as a `family_messages`
     row with `kind: 'image'` + the GIF url, reusing the existing image-message render path).
  4. Graceful fallback: if the key is absent, keep the button disabled with a "not configured" tooltip
     (don't toast "coming soon"). Same honest gating as Connections/OAuth.
  *Blocked only on the key; everything else is agent-buildable when you're ready to green-light a provider.*
- [x] Messages → Voice messages — DONE. `MediaRecorder` in `messages-module.tsx` records a clip → uploads through the existing `sendFile` path (kind `audio`, 25 MB cap + rollback) → renders an inline `<audio controls>` player. Live timer + cancel/discard; graceful "not supported" fallback. 100% Supabase (family-media storage + family_messages row).
- [x] Family page → "Wi-Fi & Passwords" — shipped as the Family Vault: `family_credentials` table + `/dashboard/passwords` (CRUD, mask/reveal/copy, RLS). *(parallel session)*

## Polish / consistency
- [x] Size guard consistency for `documents-module.tsx` + `trip-memories-module.tsx` — both are single-file uploads (no progress bar to add; Supabase JS `upload()` has no progress event). The 25 MB guard already existed in `lib/storage/documents.ts`; exported `DOCUMENT_MAX_BYTES`/`DOCUMENT_MAX_MB`, added **fail-fast pre-checks at file-pick time** in both, and fixed the Documents dropzone's misleading "up to 50 MB" copy → the real 25 MB.
- [x] Journey telemetry pipeline — migration `0124_journey_events.sql` (append-only, family-scoped RLS), pure `lib/analytics/journey.ts` (7 tests: median/summarize/format), client `useJourney(key)` hook (fire-and-forget started/step/completed, errors swallowed), instrumented the **Capture** journey (quick-capture: start on open, complete on save), and a super-admin `/dashboard/journeys` page showing real per-journey completion rate + median time/steps. Instrument more flows by calling `useJourney('key')`. *(Cross-family aggregate medians would need a service-role read.)*

## Standing rules (see /memory.md)
- Do **not** modify the global left navigation for all accounts without explicit instruction. Per-user Navigation Choices customization is fine. (The Marketplace nav entry above was an explicit roadmap build.)

---

## Build log (append as features land)
- **2026-07-06 (eve) — onboarding + role-tailoring + a11y run (7 PRs).** #235 onboarding→marketing
  wiring (`crm_contacts` upsert + `onboarding_completed`) & **child logins without email**
  (`0105_child_logins`, synthetic auth user, username+PIN, `/kid-login` + `/dashboard/family-access`).
  #236 role **nav gating** (`NavItem.manage` + `isNavItemVisibleToRole`). #237 marketing header text size.
  #238 role **Focus-strip density** (`focusChipClasses`). #239 **Kid-Logins nudge** on onboarding Done
  (`kidsNeedingLogin`). #240 onboarding progress-bar a11y. #241 **app-wide progress-bar a11y**
  (`lib/ui/a11y.ts::progressBarA11y`, 10 bars). All: tsc/eslint/**1905 tests**/build green.
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

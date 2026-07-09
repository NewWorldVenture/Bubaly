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

## ★★ STRATEGIC ALIGNMENT — MOATS OVER FEATURES (owner directive, 2026-07-07) — READ FIRST

> **Owner directive (verbatim intent):** *"I would not pursue more features next. I would pursue
> platform moats. Anyone can copy features in 6–18 months; it's much harder to copy the underlying
> intelligence and infrastructure that makes those features work."*
>
> **This section now governs the roadmap.** The competitive review confirms it: Bubaly's public
> feature matrix already **out-covers Cozi / FamilyWall / OurHome** on nearly every row — more
> features is NOT the gap. The gap is the **moat underneath** and making the highest-value surfaces
> *findable and coordinated*. **Freeze net-new feature modules.** New work must deepen one of the five
> ownable layers below or it doesn't ship.

**The five layers to OWN (this is the scoring rubric for any proposed work):**
1. **Own the data model** — the Family Knowledge Graph (the brain).
2. **Own the intelligence layer** — the Family Reasoning Engine.
3. **Own the experience** — intent-based, AI-first journeys ("one assistant coordinates the rest").
4. **Own the ecosystem** — orchestrate the services families already use (don't duplicate them).
5. **Own the category** — measure success in **reduced mental load / time saved**, not app time.

### ▣ Honest audit — what's BUILT vs. the real GAP (as of 2026-07-07)

| Strategy layer | Built (this is real) | The moat gap that must close |
|---|---|---|
| **1. Knowledge Graph** | `0129` `graph_entities`/`graph_edges`, `lib/graph/reason.ts` (16 tests), twin projector, `/dashboard/graph`. | **The graph is a standalone page, not the brain.** Only **4 files** touch `lib/graph` (the graph page/module, the projector, one agent helper). FOI, Concierge, Briefing, Playbook, Calm, Decisions, Prep-Plans, Outcomes, Moments all still read **isolated tables**. The graph must become the substrate every capability reasons over. |
| **2. Reasoning Engine** | FOI + orchestrator questions, agents roster, decisions, prep-plans, autopilot — good *engines*, individually tested. | **No single reasoning engine.** ~8 engines each answer part of "what matters / what's likely forgotten / highest-impact / auto-completable / who needs help / what next" from their own inputs. Consolidate into ONE `lib/reasoning/*` core that reads the graph + snapshot and every surface consumes. |
| **3. Experience (one assistant)** | 26 AI/reasoning routes: assistant, agents, concierge, command-center, calm, graph, decisions, prep-plans, intelligence, outcomes, operating-index, moments, briefing, autopilot, front-desk, inbox, readiness, next-best-actions, weekly-briefing, family-ai-assistant, family-digital-twin, family-memory, knowledge, family-knowledge-graph, playbook… | **This is the biggest misalignment.** The strategy is *"users interact with ONE assistant; it coordinates the rest."* We shipped 26 separate destinations — with **duplicates** (two knowledge-graphs, two assistants, two memory pages). Consolidate into **one Chief-of-Staff front door**; demote the rest to internal capabilities it calls. |
| **4. Ecosystem** | `0128` connections hub, 11-provider registry, Connect/Disconnect CRUD, `/dashboard/connections`. | Hub + model are ready but **no live OAuth/token exchange or two-way sync** — it's a directory, not an orchestrator. Needs provider keys (owner) + per-provider sync adapters (agent). |
| **5. Category metric** | FOI measures household *functioning*; journey/onboarding telemetry exists. | **The North-Star metric isn't in the product.** No surfaced "time saved / decisions handled for you / mental load reduced." Only marketing copy says it. Instrument + surface it. |
| **Family Intelligence** | Playbook learns favorite meals/grocery staples/favorites/traditions/travel. | Strategy wants the *harder* signals: **which reminders get ignored, when the family is most stressed, which chores create conflict, which routines actually work, communication style.** Expand the learning surface (transparent + editable). |
| **Moments** | `lib/moments/*` engines + `/dashboard/moments`. | Moments is **one page among 70 modules**, not the organizing principle. Strategy: *"organize by moments, not modules"* (Morning · School · Dinner · Vacation · Birthday · Moving · Holiday · New Baby · Graduation · Emergency · Weekend). Elevate to a first-class organizing layer. |
| **Chief of Staff** | Autopilot (≥90%-conf auto-exec), Calm digest, agents. | Not yet the *"Good morning — I already did X, Y, Z; pending your approval: A, B"* front door. Assemble the pieces into that single proactive home experience. |

### ▶ THE REALIGNMENT BACKLOG (do these INSTEAD of new features — priority order)

**P1 — Make the Knowledge Graph the brain (Phase 1; 6–12mo moat).**
- [x] **R1. `lib/reasoning/context.ts`** — one graph-backed context loader every AI surface calls
  (`loadFamilyContext(familyId)` → entities + edges + live snapshot). Pure, tested. ✅ DONE 2026-07-07:
  `lib/reasoning/context.ts` (pure `FamilyContext`: entity/byKind/byRef/members/related/relatedByRelation/
  neighbourhood/ripple/connection/keyHubs, wraps `lib/graph/reason.ts`), `lib/reasoning/server.ts`
  (`loadFamilyGraph` + `loadFamilyContext`, degrades to empty on read error), `tests/reasoning-context.test.ts`
  (10 tests, green). First consumer wired: agents page now loads the graph via `loadFamilyGraph` (DRY'd off
  its inline mapping) — R1 is used, not dormant.
- [~] **R2. Re-point existing engines at the graph** — FOI, Concierge, Briefing, Playbook, Calm,
  Decisions, Prep-Plans, Outcomes read graph relationships (Emma→Soccer→Field→Weather→Dinner) instead
  of isolated `.from()` calls. No new tables; rewire reads. Ship one engine at a time behind tests.
  - [x] Shared reasoning core `lib/reasoning/insights.ts` — `familyInsights(ctx)` (coordination hubs +
    blast radius + unlinked coverage gaps) over a `FamilyContext`; `insightsToPromptLines` for LLM
    grounding. Pure, 5 tests. `lib/agents/graph-insight.ts` now DELEGATES to it (one engine, not two).
  - [x] **Briefing** (flagship "what does my family need today"): `app/api/ai/briefing/route.ts` +
    `app/api/ai/weekly-briefing/route.ts` now load `loadFamilyContext`, add a FAMILY CONNECTIONS section
    to the LLM grounding + a system-prompt rule to reason about knock-on effects, and the daily route
    folds hub insights into the deterministic (AI-off) fallback. Daily + weekly Briefing engine done.
  - Note: Concierge page reuses the (now graph-aware) briefing API; Calm's ethos is *fewer* signals so
    informational graph insights are intentionally NOT folded there (would be noise).
  - [ ] Next engines: Decisions, Playbook, Prep-Plans, Outcomes, FOI.
- [ ] **R3. Auto-maintain the graph** — the `family_model_dirty` trigger (`0134`) already flags
  changes; make the projector run on-dirty so the graph is always current (not a manual "Rebuild").

**P2 — One assistant / AI Operating Layer (Phase 2; 6–12mo, category-defining).**
- [ ] **R4. Consolidate the 26 surfaces into ONE Chief-of-Staff home** — a single assistant that
  *coordinates* the specialist engines (agents/FOI/concierge/prep-plans/calm) behind one interface.
  The others become tabs/capabilities it routes to, not top-level nav. **De-duplicate first**
  (merge graph+family-knowledge-graph, assistant+family-ai-assistant, knowledge+family-memory).
- [ ] **R5. The proactive front door** — "I already did A, B, C · pending approval: X, Y" (wire
  Autopilot's completed actions + pending approvals + Calm digest into the Home hero). Reversible +
  transparent.
- [ ] **R6. Intent-based entry** — the ⌘K/command bar + Voice already parse intent; make them the
  primary way in ("plan Emma's party", "who's free Saturday") routing to the reasoning engine.

**P3 — Digital Twin / Reasoning Engine depth (Phase 3; 12–18mo differentiation).**
- [ ] **R7. Unify the reasoning engine** — fold FOI-orchestrator + agents + decisions into
  `lib/reasoning/*` answering the six questions (what matters most · what's likely forgotten ·
  highest-impact decision · what's auto-completable · who needs help · what next) over the graph.
- [ ] **R8. Deepen twin simulation** — extend `lib/twin/simulate.ts` beyond add-commitment/big-spend
  to the full "if Emma joins travel soccer" projection (schedule · travel · cost · family time ·
  homework · meals · vacation conflicts) reading the linked graph model.

**P4 — Ecosystem orchestration (Phase 4; 18–24mo network effects).**
- [ ] **R9. Per-provider sync adapters** behind the Connections hub (calendar/email first) — real
  two-way sync, not a directory. *(OAuth keys are owner-gated; build the adapter contract now.)*

**Cross-cutting moat work (start now, threads through all phases):**
- [ ] **R10. Family Intelligence — the hard signals.** Extend Playbook/learning to: ignored-reminder
  detection (reminders dismissed/overdue repeatedly), stress windows (density × conflicts × overdue by
  time-of-day/day-of-week), chore-conflict detection (reassignments/disputes), routine-adherence
  (which `routine_templates` actually get completed). Transparent + editable. New pure engines + tests.
- [ ] **R11. The category metric — surface "time saved / mental load."** Instrument admin actions the
  system handles (autopilot executions, auto-built lists, resolved conflicts, reminders that landed)
  → a real "hours saved this week / decisions handled for you" number on Home and in the Scorecard.
  This is the metric the whole thesis rests on; today it's only marketing copy.
- [ ] **R12. Moments as an organizing layer** — promote `lib/moments/*` from one page to a home
  organizing principle (Morning/School/Dinner/Vacation/Birthday/Emergency/Weekend as orchestrated
  experiences that pull the right capabilities), reducing reliance on the 70-module list.

### ⛔ What to STOP
- **No net-new feature modules.** The matrix is saturated; more rows don't move the moat and add
  surface area to maintain. Every new PR should cite which of R1–R12 (or a moat layer) it advances.
- **Stop adding standalone AI pages** — new AI capability goes *through* the one assistant, not as a
  27th destination.
- Marketing/nav polish (findability of Shopping, AI Inbox, Smart Imports, Kitchen Mode, etc.) is fine
  and cheap, but it is **positioning, not moat** — don't confuse it with the work above.

### ○ Non-strategic verification follow-ups (tactical debt — do when convenient; NOT moat work)
- [ ] **Child-login flow — verify end-to-end (never tested).** `/kid-login` + `/dashboard/family-access`
  + `0105_child_logins.sql` (synthetic auth user, username+PIN, no email) + `CHILD_LOGIN_SECRET` env.
  A feasibility check was started this session but not completed. Drive it in the browser harness
  (`scratchpad/sbstack`): parent creates a child login on `/dashboard/family-access` → child signs in
  at `/kid-login` with username+PIN → lands scoped to their role. Requires `CHILD_LOGIN_SECRET` set
  locally + `0105` applied. Watch for: PIN hashing parity, role scoping/RLS, wrong-PIN handling.
- [ ] **Phone auth — real-SMS + edge cases.** Phone signup/login was verified against a local OTP
  **shim** (send→store→verify) and the auto-submit stale-closure bug was fixed (commit `f669776`).
  Still open: a real-provider (Twilio) smoke once keys exist; and phone-number edge cases —
  international formatting/validation (`lib/auth/otp.ts` `isLikelyE164`), resend cooldown, code
  expiry, and "use a different number" reset. Not a blocker; the graceful-degradation path is honest.

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
> - [x] **Backend production hardening (2026-07-07, reasoning/network lane)** ✅ — Intelligence
>   Network aggregation hardened (write-side granular-consent `filterMetricsByScopes`, atomic
>   upsert-then-prune republish, **per-family try/catch isolation** in the nightly cron); prod audits
>   all clean (11/11 crons `CRON_SECRET`-guarded; `vercel.json` ↔ cron routes match 1:1); Knowledge
>   Graph path-finder `<Select>` a11y labels. **Cron N+1 scalability fixes:** `model-refresh`
>   skip-decision batched to **1 query** (was 2/family) via the dirty table's `refreshed_at`;
>   `network-aggregate` contribute phase batched to **4 queries** (was 4/family) via `.in(family_ids)`
>   — both now scale past thousands of families without hitting the 60s cron limit. Privacy-invariant
>   regression test added (noised count never leaks true cohort size). tsc/eslint/**1916 tests**/build green.
> - [x] **Social share cards (OpenGraph / Twitter)** ✅ (#245) — `app/opengraph-image.tsx` +
>   `app/twitter-image.tsx` render a brand-gradient 1200×630 card (Bubaly wordmark + tagline)
>   via `next/og`, shared from `lib/og/social-image.tsx`. Fully self-contained (wordmark
>   inlined from disk, no network fetch). Fixes the previously-blank `summary_large_image`
>   preview on iMessage/Slack/X/Facebook. Build-verified (both routes generate).
> - [x] **JSON-LD + canonical SEO (2026-07-07)** ✅ (#246) — (a) JSON-LD structured data
>   (`components/marketing/structured-data.tsx`: Organization + WebSite + SoftwareApplication on
>   the homepage, FAQPage on `/faq`) for Google/Bing rich results — honest data only; (b)
>   self-referential canonical URLs (`alternates.canonical: './'` in the root layout resolves
>   per-route — verified home→`/`, `/pricing`→`/pricing`, `/faq`→`/faq`), preventing duplicate
>   indexing of www/non-www/trailing-slash/preview-domain variants. Build- and server-verified.
> - [x] **HSTS security header (2026-07-07)** ✅ (#247) — `Strict-Transport-Security:
>   max-age=63072000; includeSubDomains` added to the global header block in `next.config.mjs`
>   (no `preload` — avoids the irreversible preload-list commitment). Rounds out the existing
>   X-Frame-Options / nosniff / Referrer-Policy / Permissions-Policy set.
> - [x] **Skip-to-content link, WCAG 2.4.1 (2026-07-07)** ✅ (#248) — `components/a11y/skip-link.tsx`
>   (sr-only until focused) rendered first in the marketing layout AND app shell; each `<main>` given
>   `id="main-content"`. Keyboard/SR users can bypass the nav on every page. Build-verified.

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

#### 1a. ★ STRIPE COMMERCE PLATFORM — primary payment engine (owner spec, 2026-07-08)  ☐ NOT STARTED
> Expand the marketplace into a fully integrated, **Stripe-first** commerce platform. Every financial
> transaction flows securely through Stripe where supported. Target an experience that rivals or exceeds
> Airbnb, Etsy, Turo, Shopify Marketplace, and eBay in simplicity while staying fully inside Bubaly.
> Everything must be secure, PCI-compliant, auditable, and production-ready. **Never store raw card data.**
> This is the marketplace's payment section — it supersedes any prior payment notes.

**Primary objective — complete Stripe Connect marketplace architecture.** Support: buyer payments, seller
payouts, creator storefront payments, rental payments, borrow security deposits, refunds, partial refunds,
marketplace commissions, platform service fees, taxes where applicable, promotional discounts, coupons,
gift cards (future-ready), escrow-style flow where appropriate, split payments, automatic seller payouts,
manual payout review (if enabled), and subscription billing for premium storefronts (future-ready).

- [ ] **Stripe Connect (marketplace model)** — every seller/creator can become a connected account.
  Support Express accounts (Standard where appropriate), onboarding, identity verification, tax-info
  collection, bank linking, payout preferences, dashboard access where supported, re-onboarding,
  account status, restricted-account handling. Track: pending verification · active · restricted ·
  disabled · requires information.
- [ ] **Buyer checkout (world-class, < 1 minute)** — cards, Apple Pay, Google Pay, Link by Stripe, saved
  payment methods, one-click for returning users, promo codes, gift certificates (future-ready), tax
  calculation hooks, shipping/pickup selection, rental duration selection, deposit summary, marketplace
  fee transparency.
- [ ] **Rental payments** — buyer pays rental fee + security deposit + platform fee + taxes. System holds
  deposit per configured policy, releases/refunds after a successful return workflow, and handles partial
  deductions only when damage is confirmed via the dispute process. **Never release deposits without the
  configured workflow.**
- [ ] **Borrowing deposits** — optional: none · flat · percentage · admin-defined · seller-defined. AI
  recommends whether a deposit is appropriate from item value, borrow duration, trust score, verification
  level, and prior transaction history.
- [~] **Marketplace commissions (configurable)** — flat · percentage · tiered · category-specific ·
  creator-specific · promotional overrides. Display complete fee transparency (marketplace fee, seller
  receives, platform receives, Stripe processing fee) **before** checkout.
  - [x] Pure fee engine `lib/marketplace/fees.ts` — `computeFees()` resolves the commission (flat/
    percentage/tiered, with promo→creator→category→default override precedence), applies coupon/promo
    discounts, reuses the flat Bubaly service fee, computes the Stripe processing fee (2.9%+30¢,
    configurable payer), and returns a reconciled buyer-total / seller-net / platform-take breakdown with
    labeled line items + `explainFees()` for AI/seller-dashboard use. Tests `tests/marketplace-fees.test.ts`
    (10). Verified tsc/eslint/vitest(1941)/build. Consumed next by checkout + seller dashboard + AI assistant.
- [ ] **Creator storefronts** — sell physical products, digital downloads, handmade goods, print-on-demand,
  rental inventory, services, event tickets, courses (future-ready). Payouts via Stripe Connect. Provide
  revenue dashboard, sales analytics, refund management, payout history, tax reporting, order management.
- [ ] **Subscriptions (future-ready, architect only)** — recurring billing via Stripe Billing for monthly
  rental memberships, creator premium memberships, VIP storefront subscriptions, Marketplace Pro. Do NOT
  fully enable unless configured.
- [ ] **Refunds** — full · partial · seller-approved · admin override · automatic cancellation ·
  rental-deposit · failed-delivery. Track reason, initiator, timestamp, Stripe refund id, status.
- [~] **Disputes** — item not received · damaged · not as described · rental damage · late return · fraud.
  Store evidence, images, videos, messages, timeline, admin decisions. **Never fabricate dispute outcomes.**
  - [x] State machine + remedy rules `lib/marketplace/disputes.ts` — `DISPUTE_TRANSITIONS`/
    `canDisputeTransition`/`isDisputeTerminal` (open→under_review→resolved/rejected/escalated),
    `applicableRemedies(kind)`/`isValidRemedy`, and `resolveDispute(from, kind, remedy)` which requires an
    explicit human remedy, validates it's legal + applicable, and never auto-decides (no_action→rejected).
    Backs `marketplace_disputes`. Tests `tests/marketplace-disputes.test.ts` (8). Verified tsc/eslint/vitest.
    Next: evidence storage + admin resolution UI in `/admin/marketplace`.
- [ ] **Stripe webhooks (production-ready)** — handle `checkout.session.completed`, `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `payout.created`,
  `payout.failed`, `payout.paid`, `account.updated`, `account.application.authorized`,
  `account.application.deauthorized`, `customer.subscription.created/updated/deleted`, `invoice.paid`,
  `invoice.payment_failed`. Every webhook must verify signatures, be idempotent, retry safely, persist to
  Supabase, and generate audit logs.
- [ ] **Supabase tables** (create/update, each with `id, user_id, seller_id, buyer_id, marketplace_listing_id,
  stripe_object_id, status, created_at, updated_at, metadata jsonb`, plus FKs, indexes, RLS, audit +
  updated_at triggers): `stripe_customers`, `stripe_connected_accounts`, `stripe_checkout_sessions`,
  `stripe_payment_intents`, `stripe_payment_methods`, `stripe_orders`, `stripe_refunds`, `stripe_disputes`,
  `stripe_payouts`, `stripe_balance_transactions`, `stripe_platform_fees`, `stripe_rental_deposits`,
  `stripe_transfer_records`, `stripe_webhook_events`, `stripe_tax_records`, `stripe_coupon_usage`,
  `stripe_promotion_codes`, `stripe_audit_logs`.
- [ ] **AI payment assistant** — recommend pricing / rental pricing / deposits, detect pricing anomalies,
  explain marketplace fees, predict demand, suggest promos, identify high-converting price points,
  recommend bundles and cross-sells.
- [ ] **Seller dashboard** — gross & net revenue, marketplace fees, Stripe processing fees, pending &
  available payouts, deposit holds, refunds, disputes, conversion rates, top-performing listings, AI recos.
- [ ] **Buyer experience** — secure checkout badges, Stripe-powered checkout, payment confirmations, order
  history, rental history, deposit status, refund history, receipts, invoices, purchase-protection status.
- [ ] **Security** — server-side payment creation, webhook signature validation, idempotency keys, fraud
  hooks, rate limiting, secure key handling (no secret keys in client code), PCI-compliant architecture,
  audit logs for every financial event.
- [ ] **Testing** — Stripe Connect onboarding, checkout, Apple Pay, Google Pay, Link, commission math,
  rental deposits, refunds, partial refunds, connected-account payouts, webhook processing, failed
  payments, failed payouts, RLS enforcement, mobile checkout, accessibility. Gates: typecheck, lint, build,
  unit, integration, E2E, Stripe test-mode validation. **Fix every failure.**
- **Final status target:** marketplace payments powered by Stripe via Stripe Connect — buyers, sellers,
  creators, rentals, borrowing deposits, platform commissions, automatic payouts, secure checkout,
  complete audit logging, production-ready and scalable to millions of users.

#### 1b. ★ WORLD-CLASS AI-FIRST MARKETPLACE — full product spec (owner spec, 2026-07-08)  ☐ NOT STARTED
> Build a world-class **AI-first marketplace** inside Bubaly that beats eBay, Craigslist, Facebook
> Marketplace, OfferUp, Poshmark, Etsy, Pinterest, Airbnb rentals, and local borrow/lend platforms
> combined. Feel = Pinterest discovery + eBay commerce + Craigslist simplicity + Airbnb trust + Uber
> ratings + AI concierge. No MVP, no placeholders, no faked listings/payments/verification/rentals/
> reviews/AI results. Payments run through the Stripe engine in §1a. Ship in verified slices behind tests.
> **Entry:** `/dashboard/marketplace` (primary) **and** a direct logged-in `/marketplace`.

**◆ STATUS (updated 2026-07-09) — foundations + all AI assistants shipped; deployed to www.bubaly.com.**
Progress across 10 verified, pushed slices on PR #251:
- **Data model** ✅ — `0138_marketplace_platform.sql`: 43 tables (extends 0120 + 41 new), FKs/indexes/RLS/
  triggers. Three-layer RLS **proven on PG16** (non-member sees only public listings+media, zero private
  orders; member sees own). Clean apply + idempotent across the full 150-migration chain.
- **Pure engines (all tested)** ✅ — `fees.ts` (commission + fee transparency), `matching.ts` (request→listing
  ranking w/ haversine + hard filters), `listing-draft.ts` (AI seller drafting + publish gate),
  `buyer-search.ts` (NL query → ranked results), `seller-assistant.ts` (quality tips + fair-price verdict).
- **Live in the UI** ✅ — post modal: "Describe it → AI drafts the listing" + live quality tips & fair-price
  stance; browse: "✨ Smart" NL search with per-card reasons. All in `marketplace-module.tsx`.
- **Routing** ✅ — dual entry `/marketplace` + `/dashboard/marketplace`.
- **Gates every slice**: tsc 0 · eslint 0 · vitest 1980 · next build 0.
- **Server integration (started 2026-07-09)** ▶ — TS types added for `marketplace_verifications`/`_reviews`/
  `_trust_scores` (0138) in `database.types.ts`; first typed loader `lib/marketplace/server.ts`
  `loadMemberTrust()` reads real reviews + verified badges and runs them through the reviews+trust engines →
  a `{ reviews, trust }` profile (degrades to safe empties on error). Tests `tests/marketplace-server.test.ts`
  (3, fake-DB). Verified tsc/eslint/vitest/next build.
  - [x] Checkout quote loader `loadCheckoutQuote()` (+ `marketplace_settings` type) — reads the listing +
    family commission setting and runs `computeFees` → the full transparent breakdown; falls back to the
    10% platform default when unconfigured; null if the listing is gone. 3 more fake-DB tests.
  - [x] Checkout server ACTION `createMarketplaceOrder()` (`lib/marketplace/checkout-actions.ts`, `'use
    server'`) + `marketplace_orders`/`marketplace_payments` types + pure `orderInsertFromQuote()` mapper.
    Recomputes the quote server-side (never trusts client amounts), resolves the seller from the listing,
    inserts a **pending** order + a **pending** payment — no faked charge; a later Stripe/webhook step
    confirms (honors "never mark paid unless the provider confirms"). Pure mapper tested; action build-verified.
  - [x] Payment webhook handler `lib/marketplace/payment-webhook.ts` — `handleMarketplacePayment()` applies
    a confirmed Stripe `payment_intent.*` outcome to the pending payment + order: succeeded→payment
    succeeded + order→sold (guarded by the order state machine), failed/canceled→canceled. Idempotent
    (no-ops if already applied / unknown payment / non-payment event). Pure mappers `paymentStatusFromEvent`
    + `orderTargetForPayment`. Tests `tests/marketplace-payment-webhook.test.ts` (6, incl. a state-machine
    block). Verified tsc/eslint/vitest.
  - [x] Wired into the Stripe webhook route `app/api/webhooks/money/route.ts` — `payment_intent.succeeded/
    payment_failed/canceled` now dispatch to `handleMarketplacePayment` (after signature verification +
    `recordEvent` dedup). Verified next build.
  - [x] Persist request matches `lib/marketplace/matching-server.ts` — `saveRequestMatches()` loads the
    wanted request + the public browsable listings (cross-family), runs `matchRequest`, and idempotently
    rewrites `marketplace_request_matches` (clear-then-insert). Pure mappers `requestToMatchRequest`/
    `listingRowToMatchListing`/`matchToInsert`. Extended the `marketplace_listings` type with the 0138
    columns + added `marketplace_requests`/`_request_matches` types. Tests
    `tests/marketplace-matching-server.test.ts` (5). Verified tsc/eslint/vitest/next build.
  - [x] Fee transparency in the post modal — for a sale, the seller assistant panel now shows a live
    "Buyer pays $X · you net $Y after $Z fees" line via `computeFees` (10% default). Verified tsc/eslint/build.
  - [x] PaymentIntent creation `createPaymentIntentForOrder()` (`checkout-actions.ts`) — creates a Stripe
    PaymentIntent for a pending order (amount from the payment row), stamps `stripe_payment_intent_id`, and
    sets the payment to `processing`; the already-wired webhook flips it to `succeeded`/order→`sold` on
    confirmation. When `STRIPE_SECRET_KEY` is absent it returns `{ setupRequired: true }` — a setup state,
    never a faked charge. Build-verified. **Checkout money loop is now complete in code end-to-end.**
  - [x] Connect payout split — when the seller's `stripe_connected_accounts` row is `enabled`, the
    PaymentIntent now sets `application_fee_amount` (platform commission) + `transfer_data.destination`
    (seller's account), so the seller is paid automatically and the platform keeps its fee; otherwise the
    platform collects and payout is handled separately. Build-verified. (v1 resolves the account by the
    order's family; cross-family seller payout is a follow-up.)
  - Next (needs live Stripe/Connect or browser E2E): a per-owner trust chip on cards; `/marketplace/requests`
    surface driving saveRequestMatches; media upload; creator stores + collections.
- **Still queued** — `/marketplace/requests` wanted-post surface; media upload; creator stores + collections;
  messaging; admin/moderation. See items below.

- [x] **Seed data (graphics-rich, 500+)** ✅ `supabase/seed_marketplace_platform.sql` — for the 5 demo
  families: 500 listings (every one with a picsum photo) + 1500 gallery images + 500 pricing rows, 25
  profiles (avatars/banners), 50 verifications, 25 trust scores (+badges), 5 creator storefronts, 25
  Pinterest collections (covers) + 125 pinned items, 119 offers, 50 wanted requests + 150 AI matches, 100
  orders + 100 payments (mixed states), 60 reviews + 240 dimension ratings. Idempotent + pooler-safe.
  Verified on PG16 across the full migration chain: clean apply, idempotent re-run, 0 FK mismatches, and an
  RLS check proving a non-member sees all 500 public listings + 1500 images (cross-family discovery).

**Product vision — the easiest marketplace for families & communities to:** buy · sell · borrow · lend ·
rent · request-to-borrow · request-to-rent · swap · donate · discover local creators · build
Pinterest-style product pages · build personal storefronts · verify both sides · rate both sides
(Uber-style) · message safely · and use AI to create listings, find items, match requests, and price.

**Core flow (< 60s to publish):** open Marketplace → tap `+` → choose (sell / rent out / lend / give away /
request-to-borrow / request-to-rent / create creator storefront / create collection) → upload unlimited
photos+videos → AI drafts title/description/category/pricing/rental terms/availability/tags/condition/SEO →
user confirms → publish → receive offers/requests → message securely → complete → two-sided rating.
**Never publish without user confirmation.**

- [~] **Routes** — public logged-in: `/marketplace`, `/browse`, `/search`, `/item/[id]`, `/post` (+ `/sell`
  - [x] Direct `/marketplace` entry added (`app/(app)/marketplace/page.tsx`), mirroring
    `/dashboard/marketplace` — both render `MarketplaceModule`. Dual-entry requirement met. Verified next build
    (route registered). Remaining sub-routes (`/browse` `/search` `/item/[id]` `/post/*` `/requests`
    `/collections` `/creators` `/my-*`) are later slices.
  - [ ] (original) public logged-in: `/marketplace`, `/browse`, `/search`, `/item/[id]`, `/post` (+ `/sell`
  `/rent` `/lend` `/request` `/donate`), `/requests`, `/collections` (+ `/[id]`), `/creators` (+ `/[id]`),
  `/my-store`, `/my-listings`, `/my-rentals`, `/my-borrowing`, `/my-requests`, `/messages`, `/offers`,
  `/orders`, `/verification`, `/reviews`, `/saved`, `/settings`. Mirror inside `/dashboard/marketplace/*`
  (`my-store`, `my-listings`, `messages`, `orders`, `verification`). Admin: `/admin/marketplace`.
- [x] **Supabase data model** — ✅ DONE 2026-07-08 via `0138_marketplace_platform.sql`. Extends the
  shipped `marketplace_listings`/`marketplace_offers` (0120) with commerce columns (owner/visibility/modes/
  deposit/currency/geo/tags/metadata/deleted_at) and adds 41 new tables covering identity+verification,
  taxonomy, creator stores + Pinterest collections, listing children (media/videos/attributes/availability/
  pricing/locations), wanted requests + matching, orders/rentals/borrow+lend agreements/returns/deposits,
  payments/refunds/disputes, messaging, reviews/ratings/trust, saved items+searches, AI generations/matches,
  reports/moderation, and activity/audit/usage logs + settings. FKs, indexes, unique constraints, updated_at
  triggers, `metadata jsonb` throughout. **Three-layer RLS**: reference taxonomy public-read; listings
  public-when-`visibility='public'`-or-family with children following the parent's visibility; all private
  transaction data family-scoped. Verified on PG16 in the full 150-migration chain: clean apply, idempotent
  re-run, and an RLS isolation test proving a non-member sees only public listings+media and zero private
  orders while a member sees their own. Follow-ups: (1) TS types in `lib/database.types.ts`; (2) a
  participant model so cross-family order/message threads are visible to both sides.
  <details><summary>original spec (tables)</summary>
  FKs, indexes, unique constraints, RLS with user/family isolation + public-listing visibility +
  private-message security, audit + updated_at triggers; common cols where apt: `id, user_id, family_id,
  seller_id, buyer_id, owner_id, renter_id, borrower_id, listing_id, request_id, status, created_at,
  updated_at, created_by, updated_by, deleted_at, metadata`:
  `marketplace_profiles`, `_verifications`, `_categories`, `_subcategories`, `_listings`, `_listing_media`,
  `_listing_videos`, `_listing_attributes`, `_listing_availability`, `_listing_pricing`,
  `_listing_locations`, `_requests`, `_request_matches`, `_offers`, `_orders`, `_rentals`,
  `_borrowing_agreements`, `_lending_agreements`, `_returns`, `_deposits`, `_payments`, `_refunds`,
  `_disputes`, `_messages`, `_conversations`, `_reviews`, `_ratings`, `_trust_scores`, `_collections`,
  `_collection_items`, `_creator_stores`, `_creator_products`, `_saved_items`, `_saved_searches`,
  `_search_events`, `_ai_generations`, `_ai_matches`, `_reports`, `_moderation_queue`, `_activity_logs`,
  `_audit_logs`, `_notifications`, `_usage_events`, `_settings`. (NOTE: reconcile with the SHIPPED
  `marketplace_listings` + `marketplace_offers` from 0120 — extend, don't duplicate.)
  </details>
- [ ] **Listing modes** — every listing supports one+ of: buy now · make offer · optional auction · rent ·
  borrow · lend · donate · swap · request-wanted. Auto-match wanted↔available (e.g. "borrow red dress
  size 8 Saturday" → nearby rentals/lends/sellers).
- [~] **AI listing assistant** — from photos/videos or one sentence, draft title, description, category,
  subcategory, condition, size, color, brand, price, rental price, deposit, borrow/lend terms, tags,
  availability, safety notes, SEO, and a Pinterest-style card preview. Editable; confirm before publish.
  - [x] Deterministic core `lib/marketplace/listing-draft.ts` — `parseListingHints()` extracts
    category/condition/mode/color/size/brand from a sentence; `suggestPricing()` gives buy/rent/deposit
    baselines by category×condition; `buildDraft()` assembles a full editable draft (title, description,
    tags, SEO, safety notes) that grounds the LLM and stands alone when AI is off; `draftReadiness()` is
    the publish gate (never auto-publishes — surfaces `missing`). Tests
    `tests/marketplace-listing-draft.test.ts` (13). Verified tsc/eslint/vitest(1965). Next: thin LLM
    wrapper to refine prose + the media→draft path; server action to persist as a `marketplace_listings`
    row on confirm.
  - [x] **Wired into the live post flow**: `components/modules/marketplace-module.tsx` create modal now has
    a "Describe it — AI drafts the listing" step (Sparkles) that runs `buildDraft` and prefills
    title/description/type/category/condition/price; the user still reviews + posts (no auto-publish).
    `legacyKindFromModes()` (pure, tested) bridges the rich `modes[]` to the board's single `kind`.
    Verified tsc/eslint/vitest(1966)/next build.
- [ ] **Unlimited media** — drag/drop + mobile camera, reorder, cover selection, video previews,
  compression, alt text, AI captions, gallery + Pinterest masonry. Supabase Storage; metadata persisted;
  no broken uploads.
- [ ] **Creator storefronts** (`/marketplace/creators/[id]`) — banner, avatar, bio, verification badge,
  store categories, product collections, featured items, videos, story sections, follow, reviews, ratings,
  policies, shipping/pickup/rental terms, message button.
- [ ] **Pinterest-style collections** — mood/product/closet/event/rental boards, gift guides, seasonal,
  family favorites (e.g. "Wedding Guest Dresses", "Baby Gear to Borrow"). Beautiful, shareable,
  searchable, shoppable.
- [~] **Request-to-borrow / request-to-rent** — item type, size, color, brand pref, condition pref, needed
  date, return date, location radius, budget, borrow/rent/buy pref, notes, example photos. AI matches
  requests → listings (rentals, lends, sellers, similar, nearby).
  - [x] Matching engine `lib/marketplace/matching.ts` — pure `matchRequest()` scores each listing 0–100
    with reasons: hard filters (eligibility/visibility, supported mode, budget, radius via haversine) +
    soft weighted dimensions (keywords, category, brand, size, color, condition, price fit) counted only
    when both sides specify. Backs `marketplace_request_matches` + `marketplace_ai_matches`. Tests
    `tests/marketplace-matching.test.ts` (11). Verified tsc/eslint/vitest(1952). Next: server loader +
    persist top matches; date-availability scoring once availability rows are wired.
- [~] **Local borrow/rent engine** — availability calendar, rental/borrow duration, pickup/return times,
  deposit, late-fee rules, condition checklist, handoff + return confirmation, damage reporting, dispute
  flow. Statuses: requested · approved · declined · active · picked_up · returned · late · damaged ·
  completed · disputed.
  - [x] Lifecycle + deposit engine `lib/marketplace/rental-lifecycle.ts` — the full status state machine
    (`RENTAL_TRANSITIONS`/`canTransition`/`nextStatuses`/`isTerminal`), deposit settlement that ENFORCES
    "never release without the return workflow" (`canSettleDeposit` guard + `settleDeposit` throwing before
    return; damage forfeits up to assessed damage capped at the deposit; lost forfeits all), and late-fee
    math (`daysLate`/`lateFeeCents`). Backs `marketplace_rentals`/`_borrowing_agreements`/`_deposits`.
    Tests `tests/marketplace-rental-lifecycle.test.ts` (9). Verified tsc/eslint/vitest. Next: availability
    calendar checks + wiring to orders/deposits server-side.
- [~] **Buy/sell engine** — buy now, make/counter/accept/decline offer, checkout, pickup/shipping, order
  status, buyer-protection workflow, seller dashboard. Statuses: available · pending · sold · canceled ·
  refunded · disputed.
  - [x] Offer + order state machine `lib/marketplace/order-lifecycle.ts` — `OFFER_TRANSITIONS`/
    `ORDER_TRANSITIONS` with `canOfferTransition`/`canOrderTransition`/`nextOrderStatuses`/`isOrderTerminal`/
    `isOrderPaid`, plus `resolveOfferAcceptance()` (accept one → auto-decline the other OPEN offers, throws
    if target isn't open). Statuses match the DB check constraints exactly (offers 0120, orders 0138). Tests
    `tests/marketplace-order-lifecycle.test.ts` (7). Verified tsc/eslint/vitest(2010). Next: checkout wiring
    (`computeFees` → order + payment via §1a Stripe) + a seller dashboard reading these states.
- [~] **Trust, verification & safety** — levels: email · phone · payment-method · identity (where provider
  exists) · address/location · trusted-family/community · repeat-seller · top-renter · fast-responder.
  Trust score from completed txns, reviews, ratings, response time, disputes, cancellations, verification.
  Show trust indicators before transacting.
  - [x] Engine `lib/marketplace/trust.ts` — `computeTrustScore(signals)` → 0–100 from four capped
    components (verification 0–30, ratings 0–30 confidence-weighted by review count, experience 0–20 with
    diminishing returns, reliability 0–20 penalized by dispute/cancellation rate) + earned badges
    (id_verified/verified/repeat_seller/fast_responder/top_rated/trusted); `verificationScore()`,
    `trustTier()`, `badgeLabel()`. Backs `marketplace_trust_scores`. Tests `tests/marketplace-trust.test.ts`
    (8). Verified tsc/eslint/vitest(1988). Next: server aggregation of the signals + trust chip on
    profiles/listings/checkout.
- [~] **Uber-style two-sided ratings** — buyer↔seller, renter↔owner, borrower↔lender across
  communication, reliability, item accuracy, timeliness, condition-returned, overall. Show average, count,
  badge summary, recent reviews.
  - [x] Aggregation engine `lib/marketplace/reviews.ts` — `aggregateReviews()` rolls received reviews into
    an overall average (1-decimal), a 1–5 star histogram, per-dimension means, and the most-recent few;
    `toTrustRatingSignals()` bridges into the trust engine; `ratingLabel()` for display. Ignores
    out-of-range stars. Backs `marketplace_reviews` + `marketplace_ratings`. Tests
    `tests/marketplace-reviews.test.ts` (6, incl. the trust bridge earning `top_rated`). Verified
    tsc/eslint/vitest. Next: server aggregation per member + a post-transaction rate-both-sides UI.
- [~] **AI buyer assistant** — natural-language search ("blue dress size 6 to rent near me", "safest
  seller for camping gear", "is this a fair price?") → ranked results with reasoning.
  - [x] Deterministic core `lib/marketplace/buyer-search.ts` — `parseBuyerQuery()` turns a NL query into
    a `MatchRequest` (reuses the listing hint extractor; adds `parseBudgetCents` "under $50" + `parseBuyerMode`
    rent/borrow/buy/any), and `searchListings()` runs it through the shared matching engine → ranked results
    with reasons. Tests `tests/marketplace-buyer-search.test.ts` (6). Verified tsc/eslint/vitest(1972). Next:
    a search box UI + thin LLM paraphrase of reasons; "is this a fair price?" via `computeFees`/comparables.
  - [x] **Live in browse UI**: `marketplace-module.tsx` search bar has a "✨ Smart" toggle — when on, the
    query runs `searchListings` and the board is ranked with a per-card "why" reason line; a dedicated
    no-matches empty state. Verified tsc/eslint/next build.
- [~] **AI seller assistant** — improve listing quality, suggest price/photos, detect missing details,
  rent-vs-sale, demand-based pricing, best category, promo copy.
  - [x] Engine `lib/marketplace/seller-assistant.ts` — `listingQualityTips()` (ranked missing-detail
    suggestions: photo/title/price/description/category/condition/location + rent-vs-sale nudge),
    `qualityScore()` (0–100 completeness), and `priceVerdict()` (comparable-median fair-price stance —
    great_deal/fair/above_market/overpriced + suggested price) which ALSO powers the buyer's "is this a
    fair price?". Tests `tests/marketplace-seller-assistant.test.ts` (8). Verified tsc/eslint/vitest(1980).
    Next: surface tips + quality score in the post modal; a price chip on cards.
  - [x] **Live in the post modal**: `marketplace-module.tsx` shows ranked quality tips (photo tip omitted —
    modal has no photo field) and a fair-price stance (`priceVerdict` vs the board's comparables) that update
    live as the seller fills the form. Verified tsc/eslint/next build.
- [ ] **Discovery** — personalized/nearby/trending-local/new-today/under-$25/free/borrow-nearby/
  rent-nearby feeds, creator spotlight, saved searches, smart alerts, map view, Pinterest masonry. Search:
  keyword · natural language · category · size · color · brand · distance · price · availability · mode ·
  verified-only.
- [ ] **Messaging** — listing-scoped conversations, offer/rental/borrow request cards, pickup scheduling,
  media sharing, safety reminders, report/block, AI suggested replies. Private + Supabase-backed.
- [ ] **Payments** — via the §1a Stripe engine: purchases, rental payments, deposits, refunds, platform
  fees, disputes, payouts. Never mark paid unless the provider confirms; if unconfigured, show setup states
  and support non-payment inquiry flows (do NOT fake payments).
- [ ] **Admin & moderation** (`/admin/marketplace`) — listing moderation, verification review, reported
  listings/users, disputes, payment issues, trust-score review, category management, featured listings,
  creator review, audit logs.
- [ ] **Bubaly integrations** — vacation planner suggests renting beach gear; sports hub suggests borrowing
  equipment; chores/rewards let kids earn toward items; calendar holds pickup/return dates; shopping lists
  include marketplace items; the family AI can search the marketplace; notifications remind on returns.
- [ ] **Mobile-first UX** — photo-first listing, voice search, one-tap post, swipeable media, large tap
  targets, simple checkout, safe messaging, fast browse, location-aware. No desktop-only flows.
- [ ] **Theme** — full dark/light/system; no unreadable cards, no broken buttons.
- [ ] **Testing** — listing creation, AI generation, unlimited media upload, creator store, collections,
  request-to-borrow/rent, matching engine, buy/rent/borrow/offer flows, messaging, verification gates,
  two-sided reviews, search/filtering, saved searches, admin moderation, RLS security, mobile viewports,
  themes. Gates: typecheck · lint · build · unit · integration · E2E · a11y · mobile viewport. Fix every
  failure.
- **Final status target (owner):** PASS — a production-ready, AI-first, verified, two-sided marketplace for
  buying, selling, renting, borrowing, lending, donating, swapping, creator storefronts, Pinterest-style
  product pages, unlimited media, trusted ratings, and frictionless local commerce. If not PASS, keep
  building until PASS.
- **Sequencing note:** this is a multi-slice epic. Build order: data model (extend 0120) → listing modes +
  AI listing assistant → media → discovery/search → requests + matching → borrow/rent + buy/sell engines →
  trust/verification + two-sided ratings → messaging → payments (§1a) → creator stores + collections →
  admin/moderation → Bubaly integrations. One verified, tested, pushed slice at a time.

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

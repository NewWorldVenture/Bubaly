# Pending production migrations — apply checklist

**Why this exists:** a lot of recently-shipped work (Marketplace, Voice Control,
the Family Knowledge Base, recurring-routine templates, the wallet child-ledger,
journey telemetry, the consolidated RLS-drift repair) lives in **additive
migrations that are on `main` but may not yet be applied to the production
Supabase database**. Until they're applied, those features render empty / 404 /
"coming soon" in prod even though the code is deployed. The `AGENT_HANDOFF.md`
scatters these as `⚠️ apply to prod` notes; this file is the single, ordered,
authoritative list.

> **Agents cannot apply migrations to prod** (no prod DB credentials in the
> sandbox). This is a **human-owned** task. This doc exists so it's one paste,
> not a scavenger hunt.

## How to apply (pick one)

- **Supabase CLI (recommended):** `supabase db push` — applies every pending
  migration in order. Safe: every migration below is **additive + idempotent**
  (guarded with `IF NOT EXISTS` / `EXCEPTION WHEN duplicate_object` / drift-safe
  policy re-creates), so re-running an already-applied one is a no-op.
- **Supabase SQL editor — ONE paste (easiest):** open
  **`supabase/APPLY_PENDING_0118-0135.sql`**, copy the whole file, paste into the
  SQL editor, and Run. It's all 18 migrations concatenated in order inside a single
  `BEGIN/COMMIT` (verified free of transaction-hostile statements), so it either
  fully applies or rolls back cleanly with nothing half-done. Re-running is a no-op.
- **Supabase SQL editor (per file):** paste each file below **in numeric order**
  and Run. Order matters only in that later migrations may reference earlier
  tables; applying 0118 → 0135 in sequence is always safe.

> **Agents cannot execute this** — there are no prod DB credentials or Supabase
> CLI in the build sandbox (verified). Applying to prod is human-owned; the
> consolidated bundle exists so it's one paste, not a scavenger hunt.

After applying, hard-refresh the app: Marketplace, `/dashboard/voice`,
`/dashboard/knowledge`, the calendar Routines panel, `/wallet/activity`, and
`/dashboard/journeys` should all populate.

## The list (apply in this order)

| # | File | Adds | Feature it unblocks |
|---|------|------|---------------------|
| 0118 | `0118_rls_drift_repair.sql` | Re-enables RLS + heals missing family-scoped SELECT/INSERT/UPDATE/DELETE policies on every drifted table (never weakens custom/stricter policies) | Fixes silently-empty pages caused by prod RLS drift — **apply this first** |
| 0119 | `0119_family_credentials.sql` | `family_credentials` (Wi-Fi & passwords vault) | Family Vault `/dashboard/passwords` |
| 0120 | `0120_marketplace.sql` | `marketplace_listings`, `marketplace_offers` | Marketplace `/dashboard/marketplace` |
| 0121 | `0121_voice_commands.sql` | `voice_commands` history log | Voice Control `/dashboard/voice` recent-commands |
| 0122 | `0122_routine_templates.sql` | `routine_templates`, `routine_template_items` | Recurring-routine templates (calendar right rail) |
| 0123 | `0123_family_facts.sql` | `family_facts` durable-knowledge store | Family Knowledge Base `/dashboard/knowledge` (+ knowledge-graph fact nodes) |
| 0124 | `0124_journey_events.sql` | `journey_events` append-only telemetry | Experience Scorecard `/dashboard/journeys` |
| 0125 | `0125_family_operating_index.sql` | `family_operating_index` daily snapshots (composite + dimensions + suggestions) | Family Operating Index `/dashboard/family-operating-index` (the page renders live even before apply; the table only backs the day-over-day **trend**) |
| 0126 | `0126_family_playbook.sql` | `family_playbook_suggestions` | Family Playbook `/dashboard/playbook` |
| 0127 | `0127_agent_activity.sql` | `agent_activity` | Family Assistant / agents `/dashboard/agents` + Calm inbox |
| 0128 | `0128_family_connections.sql` | `family_connections` | Connections hub `/dashboard/connections` |
| 0129 | `0129_family_graph.sql` | `graph_entities`, `graph_edges` | Knowledge/Reasoning Graph `/dashboard/graph` + twin projector + graph-aware Chief of Staff |
| 0130 | `0130_family_decisions.sql` | `family_decisions`, `decision_options` | Decision Engine `/dashboard/decisions` |
| 0131 | `0131_prep_plans.sql` | `prep_plans`, `prep_plan_steps` | Prep Plans `/dashboard/prep-plans` + Life Readiness horizon rollup |
| 0132 | `0132_network_consent.sql` | `network_consent` | Intelligence Network consent `/dashboard/intelligence` |
| 0133 | `0133_onboarding_events.sql` | `onboarding_events` | Onboarding funnel `/dashboard/onboarding-funnel` (super-admin) |
| 0134 | `0134_model_dirty.sql` | `family_model_dirty` + `mark_model_dirty()` triggers | Event-driven twin/prep refresh (the `model-refresh` cron; also needs `CRON_SECRET`) |
| 0135 | `0135_network_aggregates.sql` | `network_contributions`, `network_aggregates` | Intelligence Network insights `/dashboard/intelligence` (the `network-aggregate` cron; also needs `CRON_SECRET`) |
| 0137 | `0137_child_login_throttle.sql` | `child_login_throttle` (per-username brute-force lockout) | Hardens **Kid Logins** (`/kid-login`) — child PIN sign-in is rate-limited/locked after repeated failures. Safe before apply: sign-in still works, just un-throttled until the table exists. |
| 0138 | `0138_onboarding_imports.sql` | `onboarding_imports` | Records the **value-first onboarding** first-brief moment (T1): the imported calendar's event/conflict/action/time-saved counts + brief summary. Seeds the TTFV metric (T10). Safe before apply: onboarding still works and imported events still land in `calendar_events`; only the durable import record is skipped (best-effort insert) until the table exists. |
| 0139 | `0139_meal_ideas.sql` | `meal_ideas` (curated dinner catalog, reference data) | Powers the **3 dinner ideas** in the first-run briefing (T2). Reference data, readable by any signed-in user; populated by `seed_meal_ideas.sql` (500 rows). Safe before apply: the briefing simply shows no dinner ideas until the table exists + is seeded (best-effort read). |
| 0140 | `0140_home_briefs.sql` | `home_briefs` (daily home outcome snapshot) | Powers the **outcome-first home** (T3): when the home would otherwise be empty, it shows readiness + next-best steps + dinner ideas, and persists a daily snapshot (home-side TTFV signal). Family-scoped; seeded by `seed_home_briefs.sql` (500 days). Safe before apply: the outcome still renders live; only the durable snapshot upsert is skipped (best-effort) until the table exists. |
| 0141 | `0141_daily_insights.sql` | `daily_insights` (the one insight of the day) | Powers the **insight of the day** (T4): the home surfaces one ranked proactive insight above the fold; dismissing sticks and the next-best surfaces. Family-scoped; seeded by `seed_daily_insights.sql` (500 rows). Safe before apply: the home simply shows no insight hero (wrapped in try/catch) until the table exists. |
| 0142 | `0142_family_signals.sql` | `family_signals` (hard-signal family intelligence) | Powers **Family Intelligence / R10** (`/dashboard/family-signals`): the harder-to-copy behavioral signals (ignored reminders, stress windows, chore friction, routines that don't stick), transparent + editable (acknowledge/dismiss). Recomputed on demand + by the `model-refresh` cron. Family-scoped; seeded by `seed_family_signals.sql` (500 rows). Safe before apply: detection no-ops until the table exists (Refresh returns an error only inside the page). |
| 0147 | `0147_twin_simulations.sql` | `twin_simulations` (saved Digital Twin projections) | Powers **R8** — the full activity projection on `/dashboard/family-digital-twin` ("if Emma joins travel soccer…" across schedule/travel/cost/family-time/homework/meals/vacation). Projection is a pure no-write what-if; this stores SAVED scenarios. Family-scoped; seeded by `seed_twin_simulations.sql` (500 rows). Safe before apply: projecting still works; only Save/list is disabled until the table exists. |
| 0148 | `0148_moment_activations.sql` | `moment_activations` (Moments organizing-layer log) | Powers **R12** — the "Right now" life-moment band atop `/dashboard/moments` (Morning/School/Dinner/Weekend/Vacation/Birthday…), logging which moments surfaced + engage/dismiss. Family-scoped; seeded by `seed_moment_activations.sql` (500 rows). Safe before apply: the band is best-effort (wrapped in try/catch), so it just doesn't render until the table exists. |
| 0149 | `0149_reasoning_snapshots.sql` | `reasoning_snapshots` (unified Family Reasoning Engine log) | Powers **R7** — the one reasoning engine on `/dashboard/reasoning` (Family Reasoning) that answers the six questions every surface consumes (what matters most · forgotten · decide next · auto-complete · who needs help · what next) by composing the FOI orchestrator, graph insights (R2) and hard signals (R10). Stores one snapshot per day so the answers trend. Family-scoped; seeded by `seed_reasoning_snapshots.sql` (500 rows). Safe before apply: the page reasons live; only the daily snapshot upsert is skipped (best-effort try/catch) until the table exists. |
| 0150 | `0150_marketplace_matches.sql` | `marketplace_matches` (marketplace supply↔demand matches) | Powers the **Marketplace match intelligence** strip on `/dashboard/marketplace/browse`: connects open `wanted` requests to the supply already on the board (`sell`/`free`/`rent`/`borrow`), scored + reasoned, with Got-it / Dismiss (dismissals preserved). Family-scoped; seeded by `seed_marketplace_matches.sql` (500 rows, needs the marketplace itself seeded first). Safe before apply: the strip is best-effort (try/catch), so it just doesn't render until the table exists. |
| 0151 | `0151_marketplace_v2.sql` | `marketplace_stores`, `marketplace_follows`, `marketplace_saves`, `marketplace_collections`(+`_items`), `marketplace_orders`, `marketplace_reviews`; widens listing kinds with `swap`/`donate` | Powers **Marketplace V2** — the AI-first marketplace home at `/dashboard/marketplace` (hero, action grid, AI Picks, activity feed, Top Creators, Trust Score, Popular Collections, Safety) plus the Saved / Orders / Reviews / Collections / Creators / My Store pages. Family-scoped; seeded by `seed_marketplace_v2.sql` (~1,200 rows; needs `seed_marketplace.sql` first). Safe before apply: every V2 read is best-effort, so the home renders with empty rails and the module still works on the 0120 tables. |
| 0154 | `0154_marketplace_ownership.sql` | `marketplace_member_id()`; **per-member** RLS on listings/stores/saves/follows/offers/reviews/orders; `marketplace_accept_offer` / `marketplace_decline_offer` / `marketplace_set_listing_status` RPCs; offer→pending trigger; partial unique index `uq_marketplace_offers_open` |
| 0155 | `0155_wallet_auth_holds.sql` | `wallet_reserve_card_auth()` — atomic per-child sufficient-funds check + `processing` hold keyed by the Stripe authorization id | **Security (audit PAY-1).** Stops concurrent card authorizations from each approving against the same SPEND balance (overspend). **⚠️ Coupled with app code** — `lib/stripe/webhook.ts` calls this RPC on `issuing_authorization.request` and releases the hold on capture/reversal; apply with the deploy that ships it, else authorizations won't reserve. Idempotent; service-role only. PG16-verified: all 172 migrations apply, 2nd concurrent auth declined, capture reconciles the hold with no double-count. | **Security hardening (audit SEC-1/SEC-2/REL-1/RACE-1).** Ties marketplace writes to the acting member (was family-scoped only), moves the offer hand-off + listing status changes into ownership-checked, atomic `SECURITY DEFINER` RPCs, and makes "I'm interested" idempotent. **⚠️ Coupled with app code** — the marketplace module now calls these RPCs and relies on the tightened policies; apply this together with the deploy that ships it, else owner accept/withdraw/complete will error. Idempotent; dedupes any pre-existing duplicate open offers before creating the unique index. PG16-verified: all 152 migrations apply, RLS/RPC/trigger/index behaviors confirmed, `seed_marketplace.sql` still seeds 500 with no dup open offers. |

| 0156 | `0156_rate_limits.sql` | `rate_limits` table + `rate_limit_hit()` / `rate_limit_prune()` RPCs | **Security (audit AI-2).** Durable, cross-instance fixed-window rate limiting for public model-backed endpoints (`/api/ai/gift`), replacing the per-instance in-memory limiter that a serverless fleet could multiply. Safe before apply: `rateLimitDb` **fails open** (allows) until the RPC exists, and the in-memory limiter still caps each instance. Service-role only; idempotent. PG16-verified (4th hit in a 3/window bucket declined with retry_after). |

If prod is further behind than 0118, `supabase db push` will also pick up any
earlier un-applied migrations (0104, 0111, 0113, 0117, …) — all additive, all
safe to re-run. When in doubt, **run the full push**: idempotent migrations make
a superset apply harmless.

## ⚠️ Note for whoever maintains the migration folder

Several version prefixes are **duplicated** by parallel work streams:
`0108` (`album_highlight_kind`, `messages_enhance`), `0109`
(`documents_favorite`, `finance_rls_repair`, `user_preferences_rls_repair`), and
`0110` (`family_profile`, `transactions_member`). Supabase orders by full
filename so this still applies deterministically, but a future migration should
**not** reuse a taken prefix. Next free number: **0138**.

## Environment variables (set alongside the migrations)

- **`CRON_SECRET`** — required to activate the Vercel crons, including
  `model-refresh` (event-driven twin + prep-plan refresh) and `network-aggregate`
  (daily Intelligence Network aggregation — nothing publishes until ≥100 families
  opt in). Without it those endpoints return 401.
- **`CHILD_LOGIN_SECRET`** — required for **Kid Logins** (username + PIN, no email).
  It's mixed into the child's derived auth password so a 4-digit PIN can't be
  brute-forced offline. Without it, `/kid-login` and "create child login" report
  "not configured yet" and no child accounts can be created or signed in. Use a
  long random value; changing it later invalidates existing child passwords (a
  parent PIN reset re-derives them).
- Optional keys that light up already-built, key-gated paths: **VAPID/FCM** (push),
  **Maps/ETA** (leave-by travel buffer), **Giphy/Tenor** (Messages GIF picker),
  **Stripe Issuing** (real-time Wallet card balances).
- **`MICROSOFT_SYNC_CLIENT_ID` / `MICROSOFT_SYNC_CLIENT_SECRET`** (+ optional
  `MICROSOFT_SYNC_TENANT`, `MICROSOFT_SYNC_REDIRECT_URI`, `MICROSOFT_SYNC_SCOPES`) — flip on **live
  Microsoft / Outlook two-way sync** (R9). The whole adapter + generic engine is built and tested
  offline; without these keys `isConfigured()` is false and `/api/sync/run` returns 503 for Microsoft
  (Google sync is unaffected). Same pattern as the existing `GOOGLE_SYNC_*` pair.

## Test data (optional, after migrations)

**One-paste option:** `supabase/SEED_ALL.sql` runs all 42 paste-ready seeds in
dependency order — one paste fills every user-facing surface with ≥500 rows for
the resolved family. Idempotent (re-run safe); validated on PG16. Requires the
migrations above to be applied first.

Per-feature **500-row seeds** live in `supabase/seed_*.sql` — paste-ready,
idempotent, resolve the family by email. Coverage now spans every user-facing
surface (see the Seed-coverage tracker in `todo.md`): core content, all 9 North
Star pillars, Messages/Chores/Meals/Documents/Location/Finance/Memories/Autopilot/
Vault, the Knowledge Graph, Decisions, Prep Plans, and the Onboarding funnel
(`seed_onboarding_events.sql`). Older paths also expose `db:seed:wallet-ledger`,
`db:seed:voice`, and the in-app **Copy SQL** screens (Marketplace, Knowledge Base).

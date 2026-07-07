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

## Test data (optional, after migrations)

**One-paste option:** `supabase/SEED_ALL.sql` runs all 23 paste-ready seeds in
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

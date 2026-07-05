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
- **Supabase SQL editor (manual):** paste each file below **in numeric order**
  and Run. Order matters only in that later migrations may reference earlier
  tables; applying 0118 → 0124 in sequence is always safe.

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
**not** reuse a taken prefix. Next free number: **0125**.

## Test data (optional, after migrations)

Per-feature 500-row seeds target the demo family
`92298eb2-1a9e-4bdc-9361-677b6c01b499` (newworldventurellc@gmail.com):
`db:seed:wallet-ledger`, `db:seed:voice`, plus the in-app **Copy SQL** seed
screens (Marketplace, Knowledge Base). All are idempotent.

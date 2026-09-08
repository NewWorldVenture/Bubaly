-- Bubaly :: 0276 Let the app read its own feature-tier config
-- ----------------------------------------------------------------------------
-- `app_settings` has had RLS ENABLED since 0023 and has never carried a single
-- policy. RLS with no policy is a deny-all: only the service role (which
-- bypasses RLS) can see the table, and every read made with the user-scoped
-- client silently returns zero rows.
--
-- That is not theoretical. The admin console's Tier & Features screen stores its
-- overrides in this table under the key `feature_tiers`, and the readers that
-- consume them run on the USER client:
--
--   lib/server/feature-tiers.ts        → AppFrame (every signed-in page) and
--                                        `requireFeature` (per-route gating)
--   app/api/subscriptions/candidates   → feature gate
--   app/api/subscriptions/price-history→ feature gate
--   app/api/moving/recalculate         → feature gate
--   lib/services/trips/confirmation-import.ts
--
-- A deny-all read is indistinguishable from "the admin has configured nothing"
-- (`maybeSingle()` returns data: null, error: null), so those callers quietly
-- fall back to the catalog defaults. The net effect in production: an admin can
-- change a feature's tier, see it save, and have it apply to nobody, with no
-- error logged anywhere.
--
-- The fix is a read policy scoped to that ONE key. It is deliberately NOT a
-- blanket `for select using (true)`: this table is a general key/value store and
-- one of its other keys, `ai_provider`, holds live provider API secrets
-- (`anthropicKey` / `openaiKey` — see lib/ai/settings.ts). A table-wide read
-- policy would hand those to every signed-in user.
--
-- Writes are intentionally left with NO policy. Every writer (the admin console
-- actions, `setFeatureTier`, `resetFeatureTiers`) already goes through the
-- service-role client, so the deny-all remains exactly right for INSERT/UPDATE/
-- DELETE and this migration must not loosen it.
--
-- Idempotent; no data change.

alter table public.app_settings enable row level security;

drop policy if exists app_settings_read_feature_tiers on public.app_settings;
create policy app_settings_read_feature_tiers on public.app_settings
  for select
  to authenticated
  using (key = 'feature_tiers');

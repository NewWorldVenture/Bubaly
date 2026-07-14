-- ============================================================================
-- 0195 · Fix dashboard_layouts upsert (ON CONFLICT) for pin/customize writes.
--
-- The unique indexes from 0089 are PARTIAL (`WHERE scope=… AND deleted_at IS
-- NULL`). PostgREST/supabase-js `.upsert(..., { onConflict: 'family_id,user_id,
-- device_context' })` emits a bare `ON CONFLICT (cols)` with no predicate, which
-- Postgres cannot match to a partial unique index — so every pin/customize save
-- failed with: "there is no unique or exclusion constraint matching the ON
-- CONFLICT specification".
--
-- Fix: add a NON-partial unique index on (family_id, user_id, device_context)
-- with NULLS NOT DISTINCT. This is targetable by the bare column-list onConflict
-- AND serves both write paths:
--   • user layout   → user_id is set, one row per (family, user, device);
--   • family default → user_id IS NULL, NULLS NOT DISTINCT dedupes it to one
--     row per (family, device). A user row (user_id set) and a family row
--     (user_id null) never collide, so both coexist as before.
--
-- Deletes in the app are hard (no soft-delete writer), so a non-partial index is
-- safe. Additive + idempotent. Requires 0089.
-- ============================================================================

-- Defensive dedupe (keep the newest row per key) so the unique index can build
-- even if any legacy duplicate slipped in. No-op on a clean database.
delete from public.dashboard_layouts a
using public.dashboard_layouts b
where a.family_id = b.family_id
  and a.device_context = b.device_context
  and a.user_id is not distinct from b.user_id
  and a.created_at < b.created_at;

create unique index if not exists uq_dashboard_layout_upsert
  on public.dashboard_layouts (family_id, user_id, device_context) nulls not distinct;

-- ============================================================================
-- 0200 · Kitchen Display settings — per-family display preferences.
--
-- The customizable display grid (0026 `display_layouts.tiles`) becomes a
-- world-class always-on kitchen screen. This adds a `settings` JSON blob on the
-- same one-row-per-family table so preferences persist alongside the layout:
--   { clock24, seconds, tempUnit ('F'|'C'), theme ('auto'|…), ambient, screensaver }
-- Rendered/validated by `lib/display/ambient.ts` (pure + tested); written by the
-- existing family-scoped upsert (onConflict family_id — the UNIQUE from 0026).
--
-- Additive + idempotent. Requires 0026.
-- ============================================================================

alter table public.display_layouts
  add column if not exists settings jsonb not null default '{}'::jsonb;

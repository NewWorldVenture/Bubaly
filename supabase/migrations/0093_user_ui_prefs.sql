-- 0093_user_ui_prefs.sql
-- A generic per-user UI-preferences bag on user_preferences. First use:
-- the Capture screen's customizable quick-jump buttons
-- (ui_prefs->'captureQuickRoutes' = ordered array of route keys). Future UI
-- customizations can reuse this column instead of adding more columns.

alter table user_preferences
  add column if not exists ui_prefs jsonb not null default '{}'::jsonb;

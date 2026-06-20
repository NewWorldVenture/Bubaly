-- Per-user default dashboard preference.
-- 'personal' = the member's role-specific dashboard (the default).
-- 'family'   = the shared Family Dashboard / Command Center overview.

alter table public.user_preferences
  add column if not exists default_dashboard text not null default 'personal'
    check (default_dashboard in ('personal', 'family'));

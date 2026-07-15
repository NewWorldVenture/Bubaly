-- ============================================================================
-- 0209 · admin_notifications: add growth kinds (family_signup, subscription)
--
-- The Super Admin Notification Center now also surfaces the two alerts a founder
-- most wants: a NEW FAMILY completing onboarding, and a NEW PAID CONVERSION
-- (trial/free → paid+active). Widens the CHECK to admit those kinds. Additive +
-- idempotent (drop + re-add the named constraint with the fuller allowlist).
-- Requires 0206/0207.
-- ============================================================================

alter table public.admin_notifications drop constraint if exists admin_notifications_kind_check;
alter table public.admin_notifications
  add constraint admin_notifications_kind_check
  check (kind in (
    'feedback_new','github_sync','github_error','support_ticket','marketplace_report',
    'family_signup','subscription','info'
  ));

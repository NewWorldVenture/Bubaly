-- ============================================================================
-- 0207 · Widen admin_notifications.kind for the Super Admin Notification Center
--
-- 0206 introduced admin_notifications for the feedback flow. The admin bell now
-- surfaces the WHOLE super-admin front door, so more event sources write to it:
-- new support tickets (contact form) and marketplace Trust & Safety reports.
-- This widens the CHECK to admit those kinds. Additive + idempotent (drop +
-- re-add the named constraint with the fuller allowlist).
-- ============================================================================

alter table public.admin_notifications drop constraint if exists admin_notifications_kind_check;
alter table public.admin_notifications
  add constraint admin_notifications_kind_check
  check (kind in ('feedback_new','github_sync','github_error','support_ticket','marketplace_report','info'));

-- ============================================================================
-- 0213 · admin_notifications: add churn kind (subscription_churn)
--
-- Founder growth alerts already fire on new signups and new paid conversions;
-- this adds the other half of the ledger — CHURN. When a paying family cancels
-- or downgrades to free (was paid+active → now canceled/unpaid/expired or on the
-- free plan), the Stripe webhook records a `subscription_churn` alert so the
-- founder sees losses as clearly as wins. Detected by the pure `isChurn`
-- (fires once on the loss transition, never on tier changes that stay paid, and
-- never on transient past_due dunning). Widens the CHECK to admit the new kind.
-- Additive + idempotent (drop + re-add the named constraint with the fuller
-- allowlist). Requires 0206/0207/0209.
-- ============================================================================

alter table public.admin_notifications drop constraint if exists admin_notifications_kind_check;
alter table public.admin_notifications
  add constraint admin_notifications_kind_check
  check (kind in (
    'feedback_new','github_sync','github_error','support_ticket','marketplace_report',
    'family_signup','subscription','subscription_churn','info'
  ));

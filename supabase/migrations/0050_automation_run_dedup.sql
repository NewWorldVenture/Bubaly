-- ============================================================
-- Migration 0050: idempotent automation runs (event-driven triggers)
-- Event-driven workflows (form_submitted, email_opened/clicked, payment_completed)
-- now fire in real time from app events. To guarantee a workflow fires at most
-- once per logical event — even when a webhook is redelivered or a form is
-- double-submitted — we dedup on (workflow_id, subject_key). The event
-- dispatcher reserves the run row with ON CONFLICT DO NOTHING before doing any
-- work, so a duplicate event can never send a second email.
--
-- This also hardens the existing scheduled runner, which already dedups manually
-- by subject_key (= familyId); the index makes that race-proof too.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uniq_mkt_runs_workflow_subject
  ON public.marketing_automation_runs (workflow_id, subject_key)
  WHERE subject_key IS NOT NULL;

-- Bubaly :: 0103 — backfill enum values that drifted on long-lived databases.
--
-- Root cause: 0001 defines each enum with `create type … exception when
-- duplicate_object then null`. On a database that already had an OLDER version
-- of an enum, the CREATE is skipped entirely, so values added to the canonical
-- definition later were NEVER applied. The app and seeds then fail with, e.g.:
--   ERROR 22P02: invalid input value for enum event_category: "appointment"
--
-- This migration reconciles every drift-prone enum to its canonical value set.
-- `ALTER TYPE … ADD VALUE IF NOT EXISTS` is idempotent and safe to re-run; it
-- only appends values that are missing and never removes or reorders anything.
-- (ADD VALUE is transaction-safe on PG 12+; we only add values here, we don't
-- use them, so running inside the migration transaction is fine.)

-- ── event_category (the reported failure) ──
alter type public.event_category add value if not exists 'general';
alter type public.event_category add value if not exists 'school';
alter type public.event_category add value if not exists 'sports';
alter type public.event_category add value if not exists 'appointment';
alter type public.event_category add value if not exists 'medication';
alter type public.event_category add value if not exists 'maintenance';
alter type public.event_category add value if not exists 'birthday';
alter type public.event_category add value if not exists 'holiday';
alter type public.event_category add value if not exists 'other';

-- ── task_status (gained 'done' after 0001) ──
alter type public.task_status add value if not exists 'todo';
alter type public.task_status add value if not exists 'in_progress';
alter type public.task_status add value if not exists 'submitted';
alter type public.task_status add value if not exists 'done';
alter type public.task_status add value if not exists 'approved';
alter type public.task_status add value if not exists 'rejected';

-- ── meal_type ──
alter type public.meal_type add value if not exists 'breakfast';
alter type public.meal_type add value if not exists 'lunch';
alter type public.meal_type add value if not exists 'dinner';
alter type public.meal_type add value if not exists 'snack';

-- ── recurrence_freq ──
alter type public.recurrence_freq add value if not exists 'none';
alter type public.recurrence_freq add value if not exists 'daily';
alter type public.recurrence_freq add value if not exists 'weekly';
alter type public.recurrence_freq add value if not exists 'monthly';
alter type public.recurrence_freq add value if not exists 'yearly';

-- ── priority ──
alter type public.priority add value if not exists 'low';
alter type public.priority add value if not exists 'medium';
alter type public.priority add value if not exists 'high';

-- ── member_role ──
alter type public.member_role add value if not exists 'parent';
alter type public.member_role add value if not exists 'adult';
alter type public.member_role add value if not exists 'teen';
alter type public.member_role add value if not exists 'child';
alter type public.member_role add value if not exists 'caregiver';
alter type public.member_role add value if not exists 'guest';

-- ── transaction_type ──
alter type public.transaction_type add value if not exists 'income';
alter type public.transaction_type add value if not exists 'expense';
alter type public.transaction_type add value if not exists 'transfer';

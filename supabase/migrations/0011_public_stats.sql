-- ============================================================
-- Migration 0011: public_stats() — safe aggregate counts for the
-- public marketing site. Returns ONLY non-identifying totals so the
-- landing/pricing pages can show real numbers instead of a hardcoded
-- "10,000+ families". SECURITY DEFINER so anon can read aggregates
-- without any row-level access to the underlying tables.
-- ============================================================

-- Transaction-safety: the ADD VALUE above and this function land in the SAME
-- statement batch when the Supabase CLI applies the file (supabase start /
-- db push), and Postgres refuses to use a freshly added enum value inside that
-- transaction ("unsafe use of new value", SQLSTATE 55P04). Comparing the
-- status as text sidesteps the enum cast, so the file applies in one batch
-- and is semantically identical on databases where 'done' already existed.
-- Replay-safety: this function references task_status 'done', which historic
-- databases gained out-of-band (formally backfilled in 0103). Adding it here
-- idempotently keeps a fresh `db reset` replayable; it is a no-op on prod.
ALTER TYPE public.task_status ADD VALUE IF NOT EXISTS 'done';

CREATE OR REPLACE FUNCTION public.public_stats()
RETURNS TABLE (families bigint, members bigint, tasks_completed bigint)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    (SELECT count(*) FROM public.families),
    (SELECT count(*) FROM public.family_members WHERE is_active = true),
    (SELECT count(*) FROM public.chore_assignments WHERE status::text IN ('approved','done'));
$$;

REVOKE ALL ON FUNCTION public.public_stats() FROM public;
GRANT EXECUTE ON FUNCTION public.public_stats() TO anon, authenticated;

-- ============================================================
-- Done! Marketing pages call supabase.rpc('public_stats') to render
-- real family/member counts.
-- ============================================================

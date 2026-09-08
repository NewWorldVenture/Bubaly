-- Bubaly :: 0278 public_handled_stats() — the missing half of the public counters
-- ----------------------------------------------------------------------------
-- `lib/marketing/stats.ts` has been calling `rpc('public_handled_stats')` for
-- the "handled by Bubaly" figures on the marketing site, but no migration ever
-- defined it. The caller catches the failure and renders zeros, and the
-- formatters hide zeros — so the numbers were simply absent, with the cause
-- visible only as a logged error nobody was reading.
--
-- Same shape and same guarantees as `public_stats()` (0011): non-identifying
-- totals only, SECURITY DEFINER so anon can read aggregates without any
-- row-level access to the underlying table, and EXECUTE revoked from public
-- before being granted to the two roles that need it.
--
-- Column names match what the reader destructures: runs_completed,
-- runs_completed_30d, families_with_runs.

CREATE OR REPLACE FUNCTION public.public_handled_stats()
RETURNS TABLE (
  runs_completed bigint,
  runs_completed_30d bigint,
  families_with_runs bigint
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    (SELECT count(*) FROM public.family_automation_runs
       WHERE state::text IN ('completed', 'partially_completed')),
    (SELECT count(*) FROM public.family_automation_runs
       WHERE state::text IN ('completed', 'partially_completed')
         AND completed_at >= now() - interval '30 days'),
    (SELECT count(DISTINCT family_id) FROM public.family_automation_runs
       WHERE state::text IN ('completed', 'partially_completed'));
$$;

REVOKE ALL ON FUNCTION public.public_handled_stats() FROM public;
GRANT EXECUTE ON FUNCTION public.public_handled_stats() TO anon, authenticated;

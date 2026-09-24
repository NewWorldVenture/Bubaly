-- Decided concierge runs leave "Needs your decision". (DATA-018)
--
-- A concierge run queued for approval is written with
-- `status = 'pending', state = 'awaiting_approval'`. Approving it and
-- dismissing it wrote `status` only — to 'executed' and 'dismissed' — so
-- `state` stayed 'awaiting_approval'. The Needs-you page lists runs by `state`,
-- and `displayRunState` (lib/ai/runs/states.ts) prefers `state` whenever it is
-- not the default, so every run a parent ever decided this way is still listed
-- as waiting on them. Measured on the local database, as a parent, after one
-- dismissal and one approval:
--
--   Waiting for approval: Dinner [status=dismissed, state=awaiting_approval]
--   Dinner planned              [status=executed,  state=awaiting_approval]
--
-- The concierge actions now write both columns. This moves the rows decided
-- before that, using the mapping the code already defines for these legacy
-- values (LEGACY_RUN_STATUS_TO_STATE: executed -> completed, dismissed ->
-- cancelled). Only the contradictory pair is touched: a run whose status says
-- it was decided while its state says it is still awaiting approval. No writer
-- produces that pair on purpose — the run executor writes both columns through
-- `legacyStatusFor`, which never pairs 'executed' or 'dismissed' with
-- 'awaiting_approval'.
--
-- Data only; no schema change and no coupling to a deploy. Runs decided by the
-- old code after this is applied and before the fixed code ships would still be
-- stuck, so apply it with or after the deploy that carries the fix — re-running
-- the UPDATE below by hand is safe and idempotent if it was applied earlier.

update public.family_automation_runs
   set state = case status when 'executed' then 'completed' else 'cancelled' end
 where state = 'awaiting_approval'
   and status in ('executed', 'dismissed');

do $check$
declare
  stuck int;
begin
  select count(*) into stuck
    from public.family_automation_runs
   where state = 'awaiting_approval' and status in ('executed', 'dismissed');
  if stuck > 0 then
    raise exception '0332: % decided run(s) still read as awaiting approval', stuck;
  end if;
end
$check$;

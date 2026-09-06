-- ============================================================================
-- 0263_dead_letter_reconcile.sql — when a run is abandoned, everything that
-- described it says so.
-- ----------------------------------------------------------------------------
-- `claim_ai_runs` recovers runs whose lease expired: back to `ready`, or to
-- `failed` once `attempt >= max_attempts` — the dead-letter case. It flips the
-- run row and nothing else, so an abandoned run left behind:
--
--   * `family_automation_runs.status` (0022's legacy column, which the
--     concierge panel and the automation page render) still saying 'approved',
--     i.e. a failed run displayed as in-progress forever;
--   * its steps still `executing` or `verifying`, so the run detail page shows
--     work in flight under a failed run;
--   * `ai_requests.status` still 'executing', so §10's request ledger — the
--     thing that answers "what happened to what I asked for?" — never resolves;
--   * no `ai_run_events` row, so the timeline simply stops mid-run with no
--     explanation.
--
-- A family whose worker died deserves to be told, not left with a page that
-- claims Bubaly is still working. This rewrites the recovery half of
-- `claim_ai_runs` to reconcile all four; the claiming half is unchanged.
--
-- IDEMPOTENT: `create or replace function`, and every write is bounded to rows
-- the same statement just dead-lettered. Safe to re-run.
-- ============================================================================

create or replace function public.claim_ai_runs(p_limit integer default 10, p_lease_seconds integer default 120)
returns setof uuid
language plpgsql security definer set search_path = public as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 120), 900));
  v_dead uuid[];
begin
  -- Recover runs whose lease expired. Unchanged in effect, except that the
  -- dead-lettered ids are captured so the rest of the record can follow.
  with recovered as (
    update public.family_automation_runs
    set state = case when attempt >= max_attempts then 'failed' else 'ready' end,
        status = case when attempt >= max_attempts then 'failed' else status end,
        error = case when attempt >= max_attempts
                     then coalesce(error, 'Run abandoned after the maximum number of attempts.')
                     else error end,
        completed_at = case when attempt >= max_attempts then now() else completed_at end,
        lease_owner = null,
        lease_expires_at = null,
        run_after = now(),
        updated_at = now()
    where state = 'executing'
      and lease_expires_at is not null
      and lease_expires_at < now()
    returning id, state, plan_id, request_id, family_id
  )
  select coalesce(array_agg(id) filter (where state = 'failed'), '{}') into v_dead from recovered;

  if array_length(v_dead, 1) is not null then
    -- Steps left mid-flight by the worker that died. A step in any other state
    -- reached its own end and keeps it.
    update public.ai_plan_steps s
    set status = 'failed',
        error = coalesce(s.error, 'Bubaly stopped part-way through and could not pick this up again.'),
        completed_at = now(),
        updated_at = now()
    from public.family_automation_runs r
    where r.id = any(v_dead)
      and s.plan_id = r.plan_id
      and s.status in ('executing', 'verifying', 'queued', 'ready');

    -- The request ledger: what the person asked for is resolved, not pending.
    update public.ai_requests q
    set status = 'failed',
        error = coalesce(q.error, 'Bubaly stopped working on this and could not pick it up again.'),
        updated_at = now()
    from public.family_automation_runs r
    where r.id = any(v_dead)
      and q.id = r.request_id
      and q.status not in ('completed', 'partially_completed', 'failed', 'cancelled');

    -- And the timeline says why it stops here.
    insert into public.ai_run_events (family_id, run_id, request_id, event_type, message, actor_kind)
    select r.family_id, r.id, r.request_id, 'run_failed',
           'Bubaly stopped working on this and could not pick it up again.', 'system'
    from public.family_automation_runs r
    where r.id = any(v_dead);
  end if;

  return query
  with candidates as (
    select id
    from public.family_automation_runs
    where state in ('ready','scheduled_followup')
      and run_after <= now()
      and (lease_expires_at is null or lease_expires_at < now())
      and cancel_requested_at is null
    order by run_after, created_at
    for update skip locked
    limit v_limit
  )
  update public.family_automation_runs r
  set state = 'executing',
      attempt = r.attempt + 1,
      lease_owner = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => v_lease),
      started_at = coalesce(r.started_at, now()),
      updated_at = now()
  from candidates c
  where r.id = c.id
  returning r.id;
end;
$$;

-- `create or replace` keeps the existing grants; restated so a fresh database
-- built from these files alone lands in the same place as 0253 left it.
revoke all on function public.claim_ai_runs(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_runs(integer, integer) to service_role;

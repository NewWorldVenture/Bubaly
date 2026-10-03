-- ============================================================================
-- 0479_a_run_with_no_attempts_left_is_abandoned_not_reclaimed.sql — the claiming
-- half of `claim_ai_runs` honours the attempt ceiling, as `claimRun` always has.
-- ----------------------------------------------------------------------------
-- `family_automation_runs.attempt` is the run's abandonment budget, and three
-- readers agree about what it means. The recovery half of `claim_ai_runs`
-- (0250, rewritten by 0263) dead-letters an `executing` run whose lease ran out
-- once `attempt >= max_attempts` — "Run abandoned after the maximum number of
-- attempts." `claimRun` (lib/ai/runs/store.ts), which every human-initiated
-- continuation goes through, refuses to lease a run at that ceiling. And the
-- executor hands the budget back only when a slice made progress, so the
-- counter is the number of slices IN A ROW that completed nothing.
--
-- The CLAIMING half never read it. Its candidates were every due `ready` /
-- `scheduled_followup` run, and each claim added one. So a run parked back in
-- the queue with no attempts left was claimed by every tick for ever — attempt
-- 6, 7, 8 … — while the resume button, the kick after an approval answer and a
-- step re-run all refused it, silently. The dead-letter arm never reached it,
-- because that arm only ran for an expired lease on an `executing` row, and a
-- parked run holds no lease. Unreachable by people, unkillable by the worker
-- (finalaudit Q40: "the two claim paths disagree").
--
-- This rewrites `claim_ai_runs` once more, in the spirit of 0263:
--
--   1. The recovery statement also ABANDONS a run sitting in the queue with no
--      attempts left: `ready` or `scheduled_followup`, no live lease, no cancel
--      in flight, `attempt >= max_attempts`. It takes the dead-letter arm —
--      `failed`, 0022's legacy status, the error, `completed_at` — and the same
--      reconcile 0263 added (steps, request ledger, `run_failed` event), so the
--      family is told, not shown "Scheduled" for ever. A run whose cancel is in
--      flight is left for the cancel to finish: it must end `cancelled`, not
--      `failed`. A follow-up that is not yet due is abandoned now, not on the
--      day: it would never have run.
--   2. The candidates query gains `attempt < max_attempts`, which makes the
--      ceiling the same predicate in both claim paths. After (1) it is also
--      belt-and-braces: a run at the ceiling is `failed` by the time the
--      candidates are read.
--   3. The reconcile gains a fourth bounded write, for BOTH dead-letter arms:
--      the run's approvals still `pending` are `cancelled`. 0263 left them
--      open, so a run that died with an approval in flight kept a card in
--      "Needs your decision" until `expires_at`, and a parent who decided it
--      approved work that would never start.
--
-- Nothing else changes: the arm for an expired lease, the lease token's type,
-- the increment, the ordering, `for update skip locked`, the grants.
--
-- Proof: docs/audit/a-run-with-no-attempts-left-is-abandoned-check.sql runs the
-- real function against five rows, with a control one attempt below the
-- ceiling that must be claimed and otherwise untouched.
--
-- DEPENDS ON: 0250 (creates `claim_ai_runs` and the queue columns it reads —
-- state, attempt, max_attempts, lease_owner, lease_expires_at, run_after,
-- cancel_requested_at), 0263 (the body this extends), 0253 and 0292 (the grants
-- restated below). Number reserved on #699 (comment 5970781386); nothing in
-- 0475–0478 is referenced.
--
-- IDEMPOTENT: `create or replace function`; every write is bounded to the rows
-- the same statement just dead-lettered (0093 for `approval_requests`, 0251 for
-- its `run_id`). Safe to re-run.
-- ============================================================================

create or replace function public.claim_ai_runs(p_limit integer default 10, p_lease_seconds integer default 120)
returns setof uuid
language plpgsql security definer set search_path = public as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 120), 900));
  v_dead uuid[];
begin
  -- Two arms, one statement, so the ids either arm dead-letters are captured
  -- for the reconcile below.
  --
  --   * A run whose lease expired (0263, unchanged): back to `ready`, or to
  --     `failed` once `attempt >= max_attempts`.
  --   * A run parked in the queue with no attempts left (new): `ready` or
  --     `scheduled_followup`, no live lease, no cancel in flight, and
  --     `attempt >= max_attempts`. Every such row takes the `failed` arm —
  --     the ceiling test is true by construction — instead of being claimed
  --     once more. A cancel in flight is left to finish as `cancelled`.
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
    where (state = 'executing'
           and lease_expires_at is not null
           and lease_expires_at < now())
       or (state in ('ready','scheduled_followup')
           and attempt >= max_attempts
           and (lease_expires_at is null or lease_expires_at < now())
           and cancel_requested_at is null)
    returning id, state, plan_id, request_id, family_id
  )
  select coalesce(array_agg(id) filter (where state = 'failed'), '{}') into v_dead from recovered;

  if array_length(v_dead, 1) is not null then
    -- Steps that had not reached their own end. A step in any other state
    -- keeps it.
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

    -- Approvals still waiting on a run that is over. Left `pending`, each one
    -- sits in "Needs your decision" for a run that has already died, and a
    -- decision on it marks the row approved while the work it gated never
    -- starts (lib/services/approvals: a terminal run is never re-opened by a
    -- late decision). Closed the way `cancelRun` closes them — `cancelled`,
    -- never `expired`: time did not run out, the run did — found by the run
    -- and by the step that carries the approval (0251 lets `run_id` be null),
    -- with no decider, because nobody decided.
    update public.approval_requests a
    set status = 'cancelled',
        decided_at = now(),
        updated_at = now()
    where a.status = 'pending'
      and (a.run_id = any(v_dead)
           or a.id in (select s.approval_id
                       from public.ai_plan_steps s
                       join public.family_automation_runs r on r.plan_id = s.plan_id
                       where r.id = any(v_dead)
                         and s.approval_id is not null));
  end if;

  -- The claiming half. `attempt < max_attempts` is the same ceiling `claimRun`
  -- applies to one row, so the two claim paths now agree; after the arm above
  -- it is also a belt-and-braces test, since a run at the ceiling is already
  -- `failed` by the time the candidates are read.
  return query
  with candidates as (
    select id
    from public.family_automation_runs
    where state in ('ready','scheduled_followup')
      and run_after <= now()
      and (lease_expires_at is null or lease_expires_at < now())
      and cancel_requested_at is null
      and attempt < max_attempts
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

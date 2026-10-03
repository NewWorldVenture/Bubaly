-- Behavioural proof that `claim_ai_runs` honours the attempt ceiling in its
-- CLAIMING half, not only when a lease expires (finalaudit Q40, second half).
--
-- `attempt` is the run's abandonment budget: the recovery arm dead-letters an
-- `executing` run whose lease ran out once `attempt >= max_attempts`, and
-- `claimRun` (lib/ai/runs/store.ts) refuses to lease a run at that ceiling.
-- Until the migration this probe accompanies, the candidates query had no such
-- test: a run parked back in the queue with no attempts left was claimed by
-- every tick for ever — attempt 6, 7, 8 … — while every human-initiated path
-- refused it. The dead-letter arm never reached it, because it only ran for an
-- expired lease on an `executing` row, and a parked run holds no lease.
--
-- Five runs and three pending approvals, one call, one family. Wrapped in a
-- transaction that is rolled back, so the claim it performs leaves nothing
-- behind.
--
-- THE CONTROL is a run one attempt below the ceiling, under the same predicate
-- otherwise: it MUST be claimed, and its step, request and timeline MUST be
-- untouched. Without it a `claim_ai_runs` that abandons every parked run, or
-- that writes the reconcile for every run it touches, would pass the first
-- block of assertions and be credited with honouring a ceiling it never read.
begin;
do $$
declare
  fam        uuid;
  -- Abandoned: parked `ready`, no attempts left, with its own request, plan and step.
  spent      uuid; spent_req uuid; spent_pl uuid; spent_step uuid;
  -- CONTROL: the same, one attempt below the ceiling.
  below      uuid; below_req uuid; below_pl uuid; below_step uuid;
  -- Also abandoned: `scheduled_followup` at the ceiling, not yet due. It will
  -- never run, so the family is told now rather than on the day.
  later      uuid;
  -- Left alone: at the ceiling, but a cancel is in flight (must end `cancelled`,
  -- not `failed`) …
  halting    uuid;
  -- … or a live lease is still held (not the queue's to touch).
  held       uuid;
  -- Approvals in flight: two on the abandoned run (one found by run_id, one
  -- only through the step that carries it), one on the CONTROL.
  spent_appr uuid; spent_step_appr uuid; below_appr uuid;
  claimed    uuid[];
  r          public.family_automation_runs%rowtype;
  st         text;
  n          int;
  setup      text[] := '{}';
begin
  delete from public.families where name = 'Attempt-ceiling probe';
  insert into public.families (name) values ('Attempt-ceiling probe') returning id into fam;

  insert into public.ai_requests (family_id, kind, request_text, status)
    values (fam, 'concierge', 'Sort out the week', 'executing') returning id into spent_req;
  insert into public.ai_plans (family_id, request_id, objective)
    values (fam, spent_req, 'Week plan') returning id into spent_pl;
  insert into public.family_automation_runs
      (family_id, plan_id, request_id, state, status, run_type, attempt, max_attempts, run_after, lease_owner, lease_expires_at)
    values (fam, spent_pl, spent_req, 'ready', 'approved', 'concierge', 5, 5, now() - interval '1 minute', null, null)
    returning id into spent;
  insert into public.ai_plan_steps (family_id, plan_id, sequence, step_type, tool_name, description, status)
    values (fam, spent_pl, 1, 'act', 'calendar.createEvent', 'Add the dentist', 'ready') returning id into spent_step;

  insert into public.ai_requests (family_id, kind, request_text, status)
    values (fam, 'concierge', 'Plan dinner', 'executing') returning id into below_req;
  insert into public.ai_plans (family_id, request_id, objective)
    values (fam, below_req, 'Dinner plan') returning id into below_pl;
  insert into public.family_automation_runs
      (family_id, plan_id, request_id, state, status, run_type, attempt, max_attempts, run_after, lease_owner, lease_expires_at)
    values (fam, below_pl, below_req, 'ready', 'approved', 'concierge', 4, 5, now() - interval '1 minute', null, null)
    returning id into below;
  insert into public.ai_plan_steps (family_id, plan_id, sequence, step_type, tool_name, description, status)
    values (fam, below_pl, 1, 'act', 'meals.plan', 'Pick a recipe', 'ready') returning id into below_step;

  insert into public.family_automation_runs
      (family_id, state, status, run_type, attempt, max_attempts, run_after, lease_owner, lease_expires_at)
    values (fam, 'scheduled_followup', 'approved', 'concierge', 5, 5, now() + interval '3 days', null, null)
    returning id into later;
  insert into public.family_automation_runs
      (family_id, state, status, run_type, attempt, max_attempts, run_after, lease_owner, lease_expires_at, cancel_requested_at)
    values (fam, 'ready', 'approved', 'concierge', 5, 5, now() - interval '1 minute', null, null, now() - interval '1 second')
    returning id into halting;
  insert into public.family_automation_runs
      (family_id, state, status, run_type, attempt, max_attempts, run_after, lease_owner, lease_expires_at)
    values (fam, 'ready', 'approved', 'concierge', 5, 5, now() - interval '1 minute', gen_random_uuid(), now() + interval '2 minutes')
    returning id into held;

  -- Approvals the runs opened and nobody has decided. The abandoned run has
  -- two: one that names the run (0251's run_id), one that only the step knows
  -- about (run_id null, the step's approval_id points at it). The CONTROL has
  -- one, and it must survive the call untouched.
  insert into public.approval_requests (family_id, domain, capability, title, status, run_id, plan_step_id)
    values (fam, 'calendar', 'automate', 'Add the dentist?', 'pending', spent, spent_step) returning id into spent_appr;
  insert into public.approval_requests (family_id, domain, capability, title, status, run_id, plan_step_id)
    values (fam, 'calendar', 'automate', 'Move the follow-up?', 'pending', null, spent_step) returning id into spent_step_appr;
  update public.ai_plan_steps set approval_id = spent_step_appr where id = spent_step;
  insert into public.approval_requests (family_id, domain, capability, title, status, run_id, plan_step_id)
    values (fam, 'meals', 'automate', 'Order the groceries?', 'pending', below, below_step) returning id into below_appr;

  -- ── The setup really is the setup ────────────────────────────────────────
  -- A fixture that arrived already failed, or a control that was never due,
  -- makes the assertions below vacuous; report that as the probe's own fault.
  select * into r from public.family_automation_runs where id = spent;
  if r.state is distinct from 'ready' or r.attempt < r.max_attempts or r.lease_expires_at is not null or r.cancel_requested_at is not null or r.run_after > now() then
    setup := array_append(setup, format('the abandoned fixture was not a due, unleased, uncancelled ready run at the ceiling (state=%s attempt=%s/%s)', r.state, r.attempt, r.max_attempts));
  end if;
  select * into r from public.family_automation_runs where id = below;
  if r.state is distinct from 'ready' or r.attempt >= r.max_attempts or r.lease_expires_at is not null or r.run_after > now() then
    setup := array_append(setup, format('the CONTROL was not a due, unleased ready run below the ceiling (state=%s attempt=%s/%s)', r.state, r.attempt, r.max_attempts));
  end if;
  select status into st from public.ai_plan_steps where id = spent_step;
  if st is distinct from 'ready' then setup := array_append(setup, format('the abandoned run''s step was %s, not ''ready'', before the call', st)); end if;
  select status into st from public.ai_requests where id = spent_req;
  if st is distinct from 'executing' then setup := array_append(setup, format('the abandoned run''s request was already %s before the call', st)); end if;
  select count(*) into n from public.ai_run_events where run_id in (spent, below, later, halting, held);
  if n <> 0 then setup := array_append(setup, format('%s timeline event(s) existed before the call', n)); end if;
  select count(*) into n from public.approval_requests where id in (spent_appr, spent_step_appr, below_appr) and status = 'pending';
  if n <> 3 then setup := array_append(setup, format('only %s of the three approvals were pending before the call', n)); end if;
  if array_length(setup, 1) is not null then
    raise exception E'CONTROL FAILED: the attempt-ceiling probe proved nothing, because its own fixture was wrong:\n  - %', array_to_string(setup, E'\n  - ');
  end if;

  select coalesce(array_agg(c.id), '{}') into claimed from public.claim_ai_runs(50, 120) as c(id);

  -- ── 1. The run with no attempts left is abandoned, not claimed ───────────
  if spent = any(claimed) then
    raise exception 'a ready run with no attempts left was claimed again — the claiming half of claim_ai_runs has no attempt ceiling';
  end if;
  select * into r from public.family_automation_runs where id = spent;
  if r.state is distinct from 'failed' then raise exception 'abandoned run left in state %', r.state; end if;
  if r.status is distinct from 'failed' then raise exception 'legacy status left as %', r.status; end if;
  if r.error is distinct from 'Run abandoned after the maximum number of attempts.' then raise exception 'abandoned run''s error is %', r.error; end if;
  if r.completed_at is null then raise exception 'abandoned run has no completed_at'; end if;
  if r.lease_owner is not null or r.lease_expires_at is not null then raise exception 'abandoned run still carries a lease'; end if;
  if r.attempt <> 5 then raise exception 'abandoning a run spent an attempt (attempt=%)', r.attempt; end if;

  -- And the rest of the record follows, as 0263 made it follow a dead worker.
  select status into st from public.ai_plan_steps where id = spent_step;
  if st is distinct from 'failed' then raise exception 'in-flight step left as %', st; end if;
  select status into st from public.ai_requests where id = spent_req;
  if st is distinct from 'failed' then raise exception 'request ledger left as %', st; end if;
  select count(*) into n from public.ai_run_events where run_id = spent and event_type = 'run_failed';
  if n <> 1 then raise exception 'expected one run_failed event, found %', n; end if;

  -- Its approvals are closed, by the run and by the step, with no decider.
  select status into st from public.approval_requests where id = spent_appr;
  if st is distinct from 'cancelled' then raise exception 'the abandoned run''s approval (by run_id) was left %: it stays in "Needs your decision" for a run that is over', st; end if;
  select status into st from public.approval_requests where id = spent_step_appr;
  if st is distinct from 'cancelled' then raise exception 'the abandoned run''s approval (reachable only through the step) was left %', st; end if;
  select count(*) into n from public.approval_requests where id in (spent_appr, spent_step_appr) and decided_at is not null and decided_by is null;
  if n <> 2 then raise exception 'a closed approval is missing decided_at, or names a decider when nobody decided (%/2)', n; end if;

  -- ── 2. The scheduled follow-up at the ceiling is abandoned too, not on the day
  select * into r from public.family_automation_runs where id = later;
  if later = any(claimed) then raise exception 'a scheduled follow-up that is not due was claimed'; end if;
  if r.state is distinct from 'failed' or r.status is distinct from 'failed' or r.completed_at is null then
    raise exception 'a scheduled follow-up with no attempts left was left as % — it would have said "Scheduled" until the day, then been abandoned', r.state;
  end if;
  select count(*) into n from public.ai_run_events where run_id = later and event_type = 'run_failed';
  if n <> 1 then raise exception 'the abandoned follow-up has % run_failed events, not one', n; end if;

  -- ── CONTROL: one attempt below the ceiling, the same call ────────────────
  if not (below = any(claimed)) then
    raise exception 'CONTROL FAILED: a due ready run on attempt 4 of 5 was not claimed — the pass is refusing more than the ceiling, so nothing above is attributable to it';
  end if;
  select * into r from public.family_automation_runs where id = below;
  if r.state <> 'executing' or r.attempt <> 5 or r.lease_owner is null or r.lease_expires_at is null or r.lease_expires_at <= now() then
    raise exception 'CONTROL FAILED: the claimed run is not held by a worker (state %, attempt %, lease until %)', r.state, r.attempt, r.lease_expires_at;
  end if;
  if r.error is not null or r.completed_at is not null or r.status is distinct from 'approved' then
    raise exception 'CONTROL FAILED: the claimed run was also dead-lettered (status %, error %, completed_at %) — the reconcile is not bounded to runs at the ceiling', r.status, r.error, r.completed_at;
  end if;
  select status into st from public.ai_plan_steps where id = below_step;
  if st is distinct from 'ready' then raise exception 'CONTROL FAILED: the claimed run''s step was marked % — the step write is a blanket rule, not the ceiling''s', st; end if;
  select status into st from public.ai_requests where id = below_req;
  if st is distinct from 'executing' then raise exception 'CONTROL FAILED: the claimed run''s request was resolved to %', st; end if;
  select count(*) into n from public.ai_run_events where run_id = below;
  if n <> 0 then raise exception 'CONTROL FAILED: the claimed run got % timeline event(s) telling the family Bubaly gave up', n; end if;
  select status into st from public.approval_requests where id = below_appr;
  if st is distinct from 'pending' then raise exception 'CONTROL FAILED: the claimed run''s approval was %: the approval write is a blanket rule, not bounded to the dead runs', st; end if;

  -- ── 3. A cancel in flight, or a live lease, is not the queue's to touch ──
  select * into r from public.family_automation_runs where id = halting;
  if halting = any(claimed) or r.state is distinct from 'ready' or r.error is not null or r.completed_at is not null then
    raise exception 'a run at the ceiling with a cancel in flight was % (error %) — it must end cancelled, not failed', r.state, r.error;
  end if;
  select * into r from public.family_automation_runs where id = held;
  if held = any(claimed) or r.state is distinct from 'ready' or r.attempt <> 5 or r.lease_owner is null or r.error is not null then
    raise exception 'a run at the ceiling whose lease is still live was touched (state %, attempt %, error %)', r.state, r.attempt, r.error;
  end if;

  raise notice 'OK  a run parked with no attempts left is abandoned, its record says so and its approvals are closed; one attempt below, it is claimed and nothing else is touched';
end $$;
rollback;

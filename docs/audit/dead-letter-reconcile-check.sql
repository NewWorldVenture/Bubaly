-- Behavioural proof for 0263: a dead-lettered run leaves nothing claiming to
-- be in progress.
--
-- WHICH MIGRATION OWNS THIS RULE. `claim_ai_runs` was created by
-- `0250_ai_runtime_core.sql`, revoked from the client roles by `0253`, REWRITTEN
-- by `0263_dead_letter_reconcile.sql`, and only re-GRANTED — not redefined — by
-- `0292_privileged_rpc_grant_reassert.sql`. So 0263's body is what a replayed
-- database runs, and its recovery half has two arms:
--
--     state = case when attempt >= max_attempts then 'failed' else 'ready' end
--
-- Everything this probe asserts — 0022's legacy `status` column, the in-flight
-- steps, the request ledger, the single `run_failed` event — is written only for
-- the ids the 'failed' arm produced (`where r.id = any(v_dead)`).
--
-- WHY IT NEEDED A CONTROL. Every assertion below is equally satisfied by a
-- `claim_ai_runs` that dead-letters EVERYTHING whose lease expired. Delete the
-- `attempt >= max_attempts` test, or drop the `any(v_dead)` bound from the step,
-- request and event writes, and this probe stays green — while every retryable
-- run in production is killed permanently on its first lease expiry, its steps
-- marked failed and its family told Bubaly gave up. The probe proved that a
-- reconcile happened. It did not prove that the DEAD-LETTER ARM is what caused
-- it, which is the only thing 0263 added.
--
-- THE NEGATIVE CONTROL (below, marked CONTROL) is a second run in the SAME
-- `claim_ai_runs(10, 120)` call, in the same family, matched by the SAME
-- recovery predicate — `state = 'executing'` with an expired lease — and
-- differing ONLY in `attempt < max_attempts`. That run MUST be recovered, and
-- MUST NOT be dead-lettered: it goes back to 'ready' with its lease cleared (or
-- straight on to 'executing' with `attempt` incremented and a live lease, if the
-- claiming half of the same call picks it up again — either outcome is reachable
-- only through the recovery arm, since the claiming half never looks at an
-- 'executing' row). Its own step, its own request and its own timeline must be
-- untouched, which is what proves the three `any(v_dead)` bounds are real.
--
-- If the control run is NOT recovered, the probe says CONTROL FAILED and says
-- so about ITSELF: a scan that never reached a run whose lease had expired may
-- not have reached the fixture run either, so 'failed' on the fixture would
-- prove nothing.
--
-- AND THE SETUP IS CHECKED BEFORE THE CALL, because three of the assertions
-- below are satisfied by a row that was never in the state the probe assumes —
-- `s2` is asserted still 'completed' and `s1` asserted no longer 'executing',
-- so a fixture that arrived already-failed, or a run that was never eligible for
-- recovery, would read as a pass without `claim_ai_runs` doing anything at all.
do $$
declare
  fam uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  req uuid; pl uuid; rid uuid; s1 uuid; s2 uuid;
  -- CONTROL: a run under the same predicate that still has attempts left.
  creq uuid; cpl uuid; crid uuid; cs1 uuid;
  st text; legacy text; qst text; n int;
  c_state text; c_legacy text; c_err text; c_attempt int; c_lease timestamptz;
  c_owner uuid; c_done timestamptz;
  setup text[] := '{}';
begin
  insert into public.families (id, name) values (fam, 'Dead Letter') on conflict do nothing;

  insert into public.ai_requests (family_id, kind, request_text, status)
  values (fam, 'concierge', 'Plan the weekend', 'executing') returning id into req;
  insert into public.ai_plans (family_id, request_id, objective)
  values (fam, req, 'Weekend plan') returning id into pl;
  insert into public.family_automation_runs
    (family_id, plan_id, request_id, state, status, run_type, attempt, max_attempts, lease_owner, lease_expires_at, run_after)
  values (fam, pl, req, 'executing', 'approved', 'concierge', 5, 5, gen_random_uuid(), now() - interval '1 minute', now())
  returning id into rid;

  insert into public.ai_plan_steps (family_id, plan_id, sequence, step_type, tool_name, description, status)
  values (fam, pl, 1, 'act', 'calendar.createEvent', 'Add soccer', 'executing') returning id into s1;
  insert into public.ai_plan_steps (family_id, plan_id, sequence, step_type, tool_name, description, status)
  values (fam, pl, 2, 'act', 'reminders.create', 'Remind everyone', 'completed') returning id into s2;

  -- ── CONTROL fixture: same family, same shape, same expired lease, but this
  --    one still has attempts left, so the 'ready' arm owns it. Its own plan,
  --    request and step, so that nothing it does can disturb the counts below:
  --    the step write is bounded by `s.plan_id = r.plan_id` and the ledger write
  --    by `q.id = r.request_id`, and sharing either would make a blanket rule
  --    indistinguishable from a bounded one.
  insert into public.ai_requests (family_id, kind, request_text, status)
  values (fam, 'concierge', 'Retry me', 'executing') returning id into creq;
  insert into public.ai_plans (family_id, request_id, objective)
  values (fam, creq, 'Retry plan') returning id into cpl;
  insert into public.family_automation_runs
    (family_id, plan_id, request_id, state, status, run_type, attempt, max_attempts, lease_owner, lease_expires_at, run_after)
  values (fam, cpl, creq, 'executing', 'approved', 'concierge', 2, 5, gen_random_uuid(), now() - interval '1 minute', now())
  returning id into crid;
  insert into public.ai_plan_steps (family_id, plan_id, sequence, step_type, tool_name, description, status)
  values (fam, cpl, 1, 'act', 'calendar.createEvent', 'Add swimming', 'executing') returning id into cs1;

  -- ── The setup really is the setup ───────────────────────────────────────
  -- A row that arrived in the state the assertion expects makes that assertion
  -- vacuous, and a run that was never eligible for recovery makes all of them
  -- vacuous. Both are reported as the probe's own failure, not the boundary's.
  select state, status, attempt, lease_expires_at into c_state, c_legacy, c_attempt, c_lease
    from public.family_automation_runs where id = rid;
  if c_state is distinct from 'executing' or c_legacy is distinct from 'approved'
     or c_attempt < 5 or c_lease is null or c_lease >= now() then
    setup := array_append(setup, format('the dead-letter fixture was not eligible for recovery before the call (state=%s status=%s attempt=%s lease_expires_at=%s)',
      c_state, c_legacy, c_attempt, c_lease));
  end if;

  select state, status, attempt, lease_expires_at into c_state, c_legacy, c_attempt, c_lease
    from public.family_automation_runs where id = crid;
  if c_state is distinct from 'executing' or c_attempt is distinct from 2
     or c_lease is null or c_lease >= now() then
    setup := array_append(setup, format('the CONTROL run was not eligible for recovery before the call (state=%s attempt=%s lease_expires_at=%s)',
      c_state, c_attempt, c_lease));
  end if;

  select status into st from public.ai_plan_steps where id = s1;
  if st is distinct from 'executing' then
    setup := array_append(setup, format('the in-flight step was %s, not ''executing'', before the call — check 3 would have passed without claim_ai_runs touching it', st));
  end if;
  select status into st from public.ai_plan_steps where id = s2;
  if st is distinct from 'completed' then
    setup := array_append(setup, format('the finished step was %s, not ''completed'', before the call — check 4 would have passed without claim_ai_runs touching it', st));
  end if;
  select status into qst from public.ai_requests where id = req;
  if qst is distinct from 'executing' then
    setup := array_append(setup, format('the request ledger was already %s before the call', qst));
  end if;
  select count(*) into n from public.ai_run_events where run_id = rid and event_type = 'run_failed';
  if n <> 0 then
    setup := array_append(setup, format('the fixture run already carried %s run_failed event(s) before the call', n));
  end if;

  if array_length(setup, 1) is not null then
    raise exception E'CONTROL FAILED: 0263 dead-letter reconcile proved nothing, because its own fixture was wrong:\n  - %',
      array_to_string(setup, E'\n  - ');
  end if;

  perform public.claim_ai_runs(10, 120);

  select state, status into st, legacy from public.family_automation_runs where id = rid;
  if st is distinct from 'failed' then raise exception 'dead-lettered run left in state %', st; end if;
  -- 0022's legacy column is what the concierge panel and the automation page
  -- render; leaving it at 'approved' showed a failed run as still in progress.
  if legacy is distinct from 'failed' then raise exception 'legacy status left as %', legacy; end if;

  select status into st from public.ai_plan_steps where id = s1;
  if st is distinct from 'failed' then raise exception 'in-flight step left as %', st; end if;
  select status into st from public.ai_plan_steps where id = s2;
  if st is distinct from 'completed' then raise exception 'a finished step was rewritten to %', st; end if;

  select status into qst from public.ai_requests where id = req;
  if qst is distinct from 'failed' then raise exception 'request ledger left as %', qst; end if;

  select count(*) into n from public.ai_run_events where run_id = rid and event_type = 'run_failed';
  if n <> 1 then raise exception 'expected one run_failed event, found %', n; end if;

  -- ── CONTROL: the same scan, the same call, a run with attempts left ──────
  select state, status, error, attempt, lease_expires_at, lease_owner, completed_at
    into c_state, c_legacy, c_err, c_attempt, c_lease, c_owner, c_done
    from public.family_automation_runs where id = crid;

  -- `if NULL then` is false in plpgsql. If the control row were gone, BOTH
  -- assertions below would read NULL and stay silent — assertion 1's `=` tests
  -- are false against NULL, and `not (NULL or NULL)` is NULL, not true — so the
  -- probe would print OK having measured nothing. That is the same hole the six
  -- checks above close with `is distinct from`; close it here too.
  if not found then
    raise exception 'CONTROL FAILED: the control run (attempt 2 of 5) was gone from family_automation_runs after the call — the two assertions below would have read NULL and stayed silent, so nothing above is attributable to 0263';
  end if;

  -- Dead-lettered instead of retried: the 'failed' arm is not an arm at all, it
  -- is the whole recovery. Every assertion above was measuring that, not 0263.
  if c_state = 'failed' or c_legacy = 'failed' or c_err is not null or c_done is not null then
    raise exception 'CONTROL FAILED: claim_ai_runs dead-lettered a run on attempt 2 of 5 (state=%, status=%, error=%, completed_at=%) — it fails every expired lease, so ''failed'' on the fixture proves nothing about the attempt >= max_attempts arm, and every retryable run in production dies on its first lease expiry',
      c_state, c_legacy, c_err, c_done;
  end if;

  -- Recovered to 'ready' with the lease cleared, or recovered and then re-claimed
  -- by the same call (attempt incremented, live lease). The claiming half only
  -- selects state in ('ready','scheduled_followup'), so neither outcome is
  -- reachable from 'executing' except through the recovery arm this probe tests.
  if not (
       (c_state = 'ready'     and c_attempt = 2 and c_lease is null and c_owner is null)
    or (c_state = 'executing' and c_attempt = 3 and c_lease is not null and c_lease > now())
  ) then
    raise exception 'CONTROL FAILED: the recovery scan did not reach a run whose lease had expired (state=%, attempt=%, lease_expires_at=%, lease_owner=%) — it may not have reached the fixture run either, so nothing above is attributable to 0263',
      c_state, c_attempt, c_lease, c_owner;
  end if;

  -- The three `any(v_dead)` bounds: a blanket step/ledger/event write would have
  -- caught this run too, and would have been credited to the dead-letter arm.
  select status into st from public.ai_plan_steps where id = cs1;
  if st is distinct from 'executing' then
    raise exception 'CONTROL FAILED: a retried run''s in-flight step was marked % — the step write is not bounded to dead-lettered runs, so check 3 above is a blanket rule, not 0263''s', st;
  end if;
  select status into qst from public.ai_requests where id = creq;
  if qst is distinct from 'executing' then
    raise exception 'CONTROL FAILED: a retried run''s request ledger was resolved to % — the ledger write is not bounded to dead-lettered runs, so check 5 above is a blanket rule, not 0263''s', qst;
  end if;
  select count(*) into n from public.ai_run_events where run_id = crid;
  if n <> 0 then
    raise exception 'CONTROL FAILED: a retried run got % timeline event(s) telling the family Bubaly gave up — the event insert is not bounded to dead-lettered runs', n;
  end if;

  -- The control files four rows this probe does not roll back, and it leaves the
  -- run holding a live 120s lease. Take them back out, so a later probe counting
  -- in-flight runs is not made to fail by this one's scaffolding.
  delete from public.ai_run_events where run_id = crid;
  delete from public.ai_plan_steps where plan_id = cpl;
  delete from public.family_automation_runs where id = crid;
  delete from public.ai_plans where id = cpl;
  delete from public.ai_requests where id = creq;

  raise notice '0263 dead-letter reconcile: OK (and the control run on attempt 2 of 5 went back to the queue with its step, ledger and timeline untouched)';
end $$;

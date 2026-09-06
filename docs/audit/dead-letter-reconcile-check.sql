-- Behavioural proof for 0261: a dead-lettered run leaves nothing claiming to
-- be in progress.
do $$
declare
  fam uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  req uuid; pl uuid; rid uuid; s1 uuid; s2 uuid;
  st text; legacy text; qst text; n int;
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

  perform public.claim_ai_runs(10, 120);

  select state, status into st, legacy from public.family_automation_runs where id = rid;
  if st <> 'failed' then raise exception 'dead-lettered run left in state %', st; end if;
  -- 0022's legacy column is what the concierge panel and the automation page
  -- render; leaving it at 'approved' showed a failed run as still in progress.
  if legacy <> 'failed' then raise exception 'legacy status left as %', legacy; end if;

  select status into st from public.ai_plan_steps where id = s1;
  if st <> 'failed' then raise exception 'in-flight step left as %', st; end if;
  select status into st from public.ai_plan_steps where id = s2;
  if st <> 'completed' then raise exception 'a finished step was rewritten to %', st; end if;

  select status into qst from public.ai_requests where id = req;
  if qst <> 'failed' then raise exception 'request ledger left as %', qst; end if;

  select count(*) into n from public.ai_run_events where run_id = rid and event_type = 'run_failed';
  if n <> 1 then raise exception 'expected one run_failed event, found %', n; end if;

  raise notice '0261 dead-letter reconcile: OK';
end $$;

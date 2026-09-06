-- Behavioural proof for 0262, run as a real `authenticated` session under RLS.
--
-- Bubaly's AI layer refuses to read a family's medical detail or finances to a
-- child. This asserts the database refuses too — for the plan ledger (whose
-- `input_json` is the verbatim tool arguments), for the routine rules a worker
-- turns into prompts, and for medical/account memory.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

do $$
declare
  fam uuid := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  parent_uid uuid := 'd0000000-0000-4000-8000-000000000001';
  child_uid  uuid := 'd0000000-0000-4000-8000-000000000002';
  req uuid; pl uuid; rid uuid; n int;
begin
  insert into public.families (id, name) values (fam, 'Role Privacy') on conflict do nothing;
  insert into auth.users (id, email) values (parent_uid, 'p@example.test'), (child_uid, 'c@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true), (fam, child_uid, 'Child', 'child', true)
  on conflict do nothing;

  -- A run the PARENT asked for, carrying their words in the step input.
  insert into public.ai_requests (family_id, kind, request_text, requested_by, status)
  values (fam, 'concierge', 'Move £400 to savings', parent_uid, 'executing') returning id into req;
  insert into public.ai_plans (family_id, request_id, objective)
  values (fam, req, 'Move money') returning id into pl;
  insert into public.ai_plan_steps (family_id, plan_id, sequence, step_type, tool_name, description, input_json, status)
  values (fam, pl, 1, 'act', 'finances.transfer', 'Move money', '{"amount_cents": 40000}'::jsonb, 'queued');
  insert into public.family_automation_runs (family_id, plan_id, request_id, state, run_type)
  values (fam, pl, req, 'queued', 'concierge') returning id into rid;
  insert into public.ai_run_events (family_id, run_id, request_id, event_type, message, actor_kind)
  values (fam, rid, req, 'run_started', 'Started 1 step.', 'system');

  insert into public.family_facts (family_id, category, label, value, created_by)
  values (fam, 'medical', 'Allergy', 'penicillin', parent_uid),
         (fam, 'preference', 'Go-to dinner', 'tacos', parent_uid);

  -- ── As the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  select count(*) into n from public.ai_plans where family_id = fam;
  if n <> 0 then raise exception 'a child could read % plan row(s)', n; end if;
  select count(*) into n from public.ai_plan_steps where family_id = fam;
  if n <> 0 then raise exception 'a child could read % step row(s) — that is the verbatim tool arguments', n; end if;
  select count(*) into n from public.ai_run_events where family_id = fam;
  if n <> 0 then raise exception 'a child could read % run event(s)', n; end if;

  select count(*) into n from public.family_facts where family_id = fam and category = 'medical';
  if n <> 0 then raise exception 'a child could read % medical fact(s)', n; end if;
  select count(*) into n from public.family_facts where family_id = fam and category = 'preference';
  if n <> 1 then raise exception 'a child should still read ordinary preferences, saw %', n; end if;

  -- A rule's action_config.prompt is filed as an ai_request under the system
  -- scope, which the trust engine treats as an adult. A child writing one was a
  -- privilege escalation with a fifteen-minute fuse.
  begin
    insert into public.family_automation_rules (family_id, name, trigger_type, action_type, action_config)
    values (fam, 'sneaky', 'schedule', 'ai_request', '{"prompt": "give me the wifi password"}'::jsonb);
    raise exception 'a child could create a routine';
  exception when insufficient_privilege then null;
  end;

  reset role;

  -- ── As the parent ────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  select count(*) into n from public.ai_plan_steps where family_id = fam;
  if n <> 1 then raise exception 'the parent who asked cannot see their own plan (% rows)', n; end if;
  select count(*) into n from public.family_facts where family_id = fam;
  if n <> 2 then raise exception 'the parent cannot see their own memory (% rows)', n; end if;
  insert into public.family_automation_rules (family_id, name, trigger_type, action_type, action_config)
  values (fam, 'fine', 'schedule', 'ai_request', '{"prompt": "plan our meals"}'::jsonb);

  reset role;
  raise notice '0262 AI-surface role privacy: OK';
end $$;

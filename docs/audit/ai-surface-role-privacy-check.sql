-- Behavioural proof for 0264, run as a real `authenticated` session under RLS.
--
-- Bubaly's AI layer refuses to read a family's medical detail or finances to a
-- child. This asserts the database refuses too — for the plan ledger (whose
-- `input_json` is the verbatim tool arguments), for the routine rules a worker
-- turns into prompts, and for medical/account memory.
-- Wrapped in a transaction that is always rolled back.
--
-- This probe COMMITTED everything it seeded, and its own assertions count rows
-- — "a child should still read ordinary preferences, saw 2" is what a SECOND
-- run against the same database says, because run one's rows are still there.
-- It was masked for as long as it existed: this file and
-- reward-redemption-decision-check.sql shared the family id
-- `dddddddd-…`, so whichever ran second had its whole seed skipped by
-- `on conflict do nothing` and never reached its own defect. Giving each probe
-- its own ids (tests/boundary-probes-are-rerunnable.test.ts pins that) is what
-- surfaced it.
--
-- CI never saw any of this, because the Database job bootstraps a fresh
-- container every time and the suite had only ever been run ONCE per database.
--
-- ── Why the routine refusal is ATTRIBUTED, not merely observed (AUDIT-011) ──
-- The routine check below attempts an escalation, catches `insufficient_privilege`
-- and credits the catch to 0264's `family_automation_rules_insert`. At least
-- four other things in this very session raise that same 42501:
--
--   * `authenticated` holding no INSERT privilege on the table at all — the
--     shape that let the document-vault probe pass while the teen could not
--     insert ANY document ("permission denied for table documents"). This probe
--     is especially exposed to it: line 22 deliberately stopped restating the
--     blanket `grant ... on all tables`, precisely so that a migration's REVOKE
--     survives, which means a REVOKE landing here would go unnoticed;
--   * the child's `family_members` row never landing, so the session is a
--     member of nothing and every family-scoped policy refuses it. The
--     preference read above already rules this out — `family_facts_select`
--     requires `is_family_member` — but it rules it out for the READS, and a
--     refusal is credited on the WRITE;
--   * a BEFORE trigger on the table raising 42501 of its own;
--   * a later migration replacing the policy with one that refuses everybody,
--     managers included, which would read here as a boundary in perfect health.
--
-- So that check is now paired with a NEGATIVE CONTROL: a SECOND family, in
-- which the same child user is an active parent. The same session issues the
-- SAME INSERT — same columns, same values, same `action_config.prompt` — and
-- differs only in `family_id`, which is the one column
-- `can_manage_family(family_id)` reads. It MUST succeed. When it does not, this
-- probe reports CONTROL FAILED and names the reason, instead of reporting a
-- boundary that was never tested.
--
-- The refusal's own wording is read as well: Postgres says "permission denied
-- for table …" when a GRANT refuses and "new row violates row-level security
-- policy …" when a policy does, both at 42501. Only a POSITIVE match on the
-- grant wording fails the control, so a non-English `lc_messages` can make this
-- check say nothing — never make it say the wrong thing.
--
-- The control is BEHAVIOURAL, and there is one thing behaviour alone cannot
-- separate: a ROLE-AWARE trigger. A trigger that raised 42501 for non-managers
-- would let the control through and be credited to 0264 — measured against a
-- live database, the probe printed OK under exactly that. So the credit is
-- anchored in the catalog as well: no trigger fires on INSERT into this table,
-- and the family's single permissive INSERT policy still goes through 0264's
-- `can_manage_family`, read out of `pg_policy` rather than out of the migration
-- file, and pinned by shape rather than by name. Both are checked
-- AFTER the behavioural ones, so a real breach still reports itself as a
-- breach rather than as a stale catalog.
--
-- The control's row is binned as soon as the role is reset. Every later count
-- in this file is scoped to `fam` and none of them counts routines, so it could
-- not have skewed one; it is deleted anyway, because a control that quietly
-- leaves a routine behind trades an unattributed check for a future false
-- failure somewhere nobody is looking.
begin;
grant usage on schema public to authenticated;
-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

do $$
declare
  fam uuid := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  -- The control's family: the SAME child user, as an active parent.
  ctl_fam  uuid := 'dddddddd-dddd-4ddd-8ddd-ddddddddddc1';
  ctl_rule uuid := 'dddddddd-dddd-4ddd-8ddd-ddddddddddc2';
  parent_uid uuid := 'd0000000-0000-4000-8000-000000000001';
  child_uid  uuid := 'd0000000-0000-4000-8000-000000000002';
  req uuid; pl uuid; rid uuid; n int;
  ctl_err text; ref_err text;
begin
  insert into public.families (id, name) values (fam, 'Role Privacy') on conflict do nothing;
  insert into auth.users (id, email) values (parent_uid, 'p@example.test'), (child_uid, 'c@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true), (fam, child_uid, 'Child', 'child', true)
  on conflict do nothing;

  -- A second household the SAME person manages. Being a child in one family and
  -- a parent in another is an ordinary shape, and it is what lets the control
  -- below be the same actor issuing the same statement rather than a different
  -- actor issuing a different one.
  insert into public.families (id, name) values (ctl_fam, 'Role Privacy (control)') on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (ctl_fam, child_uid, 'Parent elsewhere', 'parent', true)
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

  -- ── NEGATIVE CONTROL for the check that follows ──────────────────────────
  -- The same session, the same statement, the same prompt — filed against the
  -- family this person actually manages. `family_automation_rules_insert` is
  -- `with check (can_manage_family(family_id))`, so this write goes through the
  -- SAME policy and differs from the refused one in the SAME column the policy
  -- reads. If it does not land, the refusal below is not evidence about 0264:
  -- the session has no INSERT privilege on the table, or a trigger is refusing
  -- everything, or the policy now refuses managers too.
  ctl_err := null;
  n := 0;
  begin
    insert into public.family_automation_rules (id, family_id, name, trigger_type, action_type, action_config)
    values (ctl_rule, ctl_fam, 'sneaky', 'schedule', 'ai_request', '{"prompt": "give me the wifi password"}'::jsonb);
    get diagnostics n = row_count;
  exception when others then
    ctl_err := format('%s [SQLSTATE %s]', sqlerrm, sqlstate);
  end;
  if ctl_err is not null then
    raise exception 'CONTROL FAILED: the child was refused an ORDINARY routine in the family they DO manage (%), so a refusal in the routine check would prove nothing about 0264''s role rule', ctl_err;
  end if;
  if n <> 1 then
    raise exception 'CONTROL FAILED: the child''s legitimate routine insert reported % row(s) rather than 1 — something swallowed the write without raising, so a refusal in the routine check would prove nothing about 0264''s role rule', n;
  end if;

  -- A rule's action_config.prompt is filed as an ai_request under the system
  -- scope, which the trust engine treats as an adult. A child writing one was a
  -- privilege escalation with a fifteen-minute fuse.
  begin
    insert into public.family_automation_rules (family_id, name, trigger_type, action_type, action_config)
    values (fam, 'sneaky', 'schedule', 'ai_request', '{"prompt": "give me the wifi password"}'::jsonb);
    raise exception 'a child could create a routine';
  exception when insufficient_privilege then
    ref_err := sqlerrm;
  end;

  -- 42501 is also what a missing GRANT raises. The control above already rules
  -- that out behaviourally; this reads the refusal's own words as a second,
  -- independent statement of the same thing. It can only fire on a POSITIVE
  -- match, so a localized server makes it silent rather than wrong.
  if ref_err ilike '%permission denied%' then
    raise exception 'CONTROL FAILED: the child''s routine was refused by a table GRANT rather than by 0264''s policy (%)', ref_err;
  end if;

  -- The control proves the refusal came from a rule that reads `family_id`,
  -- not from a table-wide GRANT and not from a trigger that refuses everyone.
  -- It cannot tell 0264's policy apart from a ROLE-AWARE trigger doing the same
  -- job, so that possibility is closed here instead of assumed away.
  select count(*) into n
    from pg_catalog.pg_trigger
   where tgrelid = 'public.family_automation_rules'::regclass
     and not tgisinternal and (tgtype & 4) <> 0;
  if n <> 0 then
    raise exception 'CONTROL FAILED: % trigger(s) now fire on INSERT into family_automation_rules, so the refusal above cannot be credited to 0264''s policy rather than to a trigger', n;
  end if;

  -- And the rule that refused is still the one 0264 wrote. Read out of the
  -- catalog, not out of the migration file, so this cannot pass against a
  -- predicate some later migration replaced. Pinned by SHAPE, not by name: a
  -- rename that keeps the predicate is not a boundary change, and failing on
  -- one would be noise. A FOR ALL policy is counted too — 0022's blanket was
  -- exactly that — and its `using` stands in when it has no with-check, which
  -- is how Postgres reads it.
  select count(*) into n
    from pg_catalog.pg_policy
   where polrelid = 'public.family_automation_rules'::regclass
     and polpermissive and polcmd in ('a', '*')
     and coalesce(pg_catalog.pg_get_expr(polwithcheck, polrelid),
                  pg_catalog.pg_get_expr(polqual, polrelid), '') not ilike '%can_manage_family%';
  if n <> 0 then
    raise exception 'CONTROL FAILED: % permissive INSERT polic(ies) on family_automation_rules no longer go through can_manage_family, so the refusal above is not evidence about 0264''s role rule — re-read which migration owns the guard', n;
  end if;

  -- Exactly one of them, as 0264 left it. A SECOND permissive INSERT policy is
  -- the one shape that could satisfy the control without the rule under test
  -- doing the work, so it is counted rather than assumed away.
  select count(*) into n
    from pg_catalog.pg_policy
   where polrelid = 'public.family_automation_rules'::regclass
     and polpermissive and polcmd in ('a', '*');
  if n <> 1 then
    raise exception 'CONTROL FAILED: family_automation_rules carries % permissive INSERT polic(ies) rather than 0264''s single one, so a refusal cannot be credited to it', n;
  end if;

  reset role;

  -- Bin the control's row: nothing here counts routines, but a routine nobody
  -- asked for should not outlive the assertion that filed it.
  delete from public.family_automation_rules where id = ctl_rule;

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
  raise notice '0264 AI-surface role privacy: OK (the child was refused a routine in the family they are a child of, having just filed the identical routine in the family they parent — so the refusal is the role rule, not a grant)';
end $$;

rollback;

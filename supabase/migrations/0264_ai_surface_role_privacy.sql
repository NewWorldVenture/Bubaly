-- ============================================================================
-- 0264_ai_surface_role_privacy.sql — the role boundary the AI layer enforces
-- now exists in the database too.
-- ----------------------------------------------------------------------------
-- Bubaly is careful: `riskToDecision`'s view rule refuses to read a family's
-- finances or medical detail to a child, the memory slice filters sensitive
-- categories by role, and `ai_tool_calls` was deliberately narrowed at 0250
-- because "inputs/outputs can hold finance rows, document text or another
-- member's medical detail". Four tables around it were not, and an ordinary
-- session can read them directly:
--
--   1. ai_plans / ai_plan_steps / ai_run_events are `is_family_member`, and
--      `ai_plan_steps.input_json` is the VERBATIM tool arguments — message
--      bodies, announcement text, budget figures, document titles. So the plan
--      ledger reads back what 0255 locked down on ai_messages.
--
--   2. family_automation_rules is still on 0022's blanket `FOR ALL` — and 0259
--      turned `action_config.prompt` into something the routine worker files as
--      an ai_request under the SYSTEM scope, which `trustRoleFor` maps to an
--      adult. A child inserting a rule was a privilege escalation with a
--      fifteen-minute fuse.
--
--   3. family_facts holds medical and account facts. The role filter exists
--      only in TypeScript (`isSensitiveMemory`, applied by the context slice
--      and the memory panel); the table itself is family-wide, and a browser
--      client can read it directly.
--
-- home_briefs had the same shape of problem and is NOT handled here: main's own
-- 0262 quarantines that table outright (a restrictive deny-all, because a saved
-- snapshot mixes sources whose access cannot be revalidated later). That is
-- strictly stronger than the narrowing this file would have applied, so this
-- migration leaves it alone.
--
-- What this does NOT touch: the finance and document tables themselves. Their
-- 0006/0109 policies are also role-blind — `financial_accounts`, `transactions`,
-- `budgets`, `bills`, `savings_goals` and `documents` are `FOR ALL ...
-- is_family_member`, so a teen can PATCH a budget directly. That is real, and
-- it is deliberately NOT fixed here: those tables are read and written by dozens
-- of non-AI surfaces, and narrowing them needs its own blast-radius analysis and
-- its own proof rather than riding along with the AI runtime's. It is named
-- here, and in the pull request that carries this file, so it cannot be
-- mistaken for something nobody noticed.
--
-- ADDITIVE + IDEMPOTENT: policies are dropped and recreated by name. Safe to
-- re-run.
-- ============================================================================

-- ─── 1. The plan ledger: the requester, or a manager ────────────────────────
-- Same rule and same reason as `ai_tool_calls` (0250:406-413).
drop policy if exists ai_plans_select on public.ai_plans;
create policy ai_plans_select on public.ai_plans
  for select to authenticated using (
    public.can_manage_family(family_id)
    or exists (
      select 1 from public.ai_requests r
      where r.id = ai_plans.request_id and r.requested_by = auth.uid()
    )
  );

drop policy if exists ai_plan_steps_select on public.ai_plan_steps;
create policy ai_plan_steps_select on public.ai_plan_steps
  for select to authenticated using (
    public.can_manage_family(family_id)
    or exists (
      select 1 from public.ai_plans p
      join public.ai_requests r on r.id = p.request_id
      where p.id = ai_plan_steps.plan_id and r.requested_by = auth.uid()
    )
  );

drop policy if exists ai_run_events_select on public.ai_run_events;
create policy ai_run_events_select on public.ai_run_events
  for select to authenticated using (
    public.can_manage_family(family_id)
    or exists (
      select 1 from public.ai_requests r
      where r.id = ai_run_events.request_id and r.requested_by = auth.uid()
    )
  );

-- ─── 2. Routines: a rule is a prompt, so writing one is a manager's act ─────
drop policy if exists "Members can manage family_automation_rules" on public.family_automation_rules;
drop policy if exists family_automation_rules_select on public.family_automation_rules;
drop policy if exists family_automation_rules_write on public.family_automation_rules;

create policy family_automation_rules_select on public.family_automation_rules
  for select to authenticated using (public.is_family_member(family_id));

-- One policy per command, because `for all` cannot express "everyone reads,
-- managers write".
create policy family_automation_rules_insert on public.family_automation_rules
  for insert to authenticated with check (public.can_manage_family(family_id));
create policy family_automation_rules_update on public.family_automation_rules
  for update to authenticated
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));
create policy family_automation_rules_delete on public.family_automation_rules
  for delete to authenticated using (public.can_manage_family(family_id));

-- ─── 3. family_facts: medical and account facts are the adults' ─────────────
-- The categories match `isSensitiveMemory` in lib/memory/facts.ts, which is
-- what the context slice and the memory panel already apply in TypeScript.
drop policy if exists family_facts_select on public.family_facts;
create policy family_facts_select on public.family_facts
  for select to authenticated using (
    public.is_family_member(family_id)
    and (category not in ('medical', 'account') or public.can_manage_family(family_id))
  );

drop policy if exists family_facts_insert on public.family_facts;
create policy family_facts_insert on public.family_facts
  for insert to authenticated with check (
    public.is_family_member(family_id)
    and (category not in ('medical', 'account') or public.can_manage_family(family_id))
  );

drop policy if exists family_facts_update on public.family_facts;
create policy family_facts_update on public.family_facts
  for update to authenticated
  using (
    public.is_family_member(family_id)
    and (category not in ('medical', 'account') or public.can_manage_family(family_id))
  )
  with check (
    public.is_family_member(family_id)
    and (category not in ('medical', 'account') or public.can_manage_family(family_id))
  );

drop policy if exists family_facts_delete on public.family_facts;
create policy family_facts_delete on public.family_facts
  for delete to authenticated using (
    public.is_family_member(family_id)
    and (category not in ('medical', 'account') or public.can_manage_family(family_id))
  );


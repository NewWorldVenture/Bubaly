-- Bubaly :: 0390 - a queued run keeps the gate it was born with
--
-- When an accepted concierge plan lands on the family's "ask first" dial,
-- app/(app)/dashboard/concierge/actions.ts planAcceptedAction files an
-- approval through the trust engine and, beside it, a `family_automation_runs`
-- row for the Autopilot panel:
--
--   status = 'pending', state = 'awaiting_approval',
--   metadata = {plan_id, kinds, approval_id, basis, reason}
--
-- `metadata.approval_id` is the panel's record that a vote stands between this
-- line and the family's calendar. Until this tranche the "Do it" button read
-- that key and branched on it: present -> `decide()` (the threshold, the
-- duplicate-vote check, the audit row); absent -> materialise the plan
-- directly, because a run with no approval is one the engine never gated.
--
-- The column is writable by the people the vote is meant to bind.
-- `family_automation_runs_update` (0251:178-181) is
--
--   for update to authenticated
--   using      (public.can_manage_family(family_id))
--   with check (public.can_manage_family(family_id))
--
-- — every later migration on this table (0252, 0255, 0329) touched INSERT only,
-- and the table's one trigger is `set_updated_at` (0022). So an adult, with the
-- browser session:
--
--   PATCH /rest/v1/family_automation_runs?id=eq.<run>
--     {"metadata": {"plan_id": "<plan>", "kinds": ["calendar","reminder","task"]}}
--
-- and then one tap on "Do it". The direct branch materialised the plan with no
-- vote, and the two-parent approval stayed pending — the other parent's card
-- still open, describing work already done.
--
-- ── two halves, and which one is the boundary ───────────────────────────────
--
-- The load-bearing fix is in the ACTION, not here: executeQueuedRunAction and
-- dismissQueuedRunAction now resolve the governing approval from
-- `approval_requests` by the plan it names (`payload->>'plan_id'`, which 0389
-- pins for the life of the row) and never from the run's metadata. That is
-- necessary because a pin on UPDATE cannot close the other door: 0255/0329 let
-- a MANAGER insert a fresh run row (state 'queued', `status` defaulting to
-- 'pending', metadata free) naming a plan and no approval at all. A row that
-- was born without a gate has nothing for this trigger to keep.
--
-- What this migration does is keep the cache honest for the rows the SERVER
-- wrote, so that the panel's line, the "Needs you" list and the dismiss path
-- describe the gate that actually exists:
--
--   F. For callers subject to row-level security, once `metadata->>'approval_id'`
--      or `metadata->>'plan_id'` is non-null it cannot be removed or changed.
--      Every other key stays writable (nothing in the app writes any of them
--      from a user session, but this file pins only what it can defend).
--
-- Nothing on a user session updates `metadata` at all: the concierge actions
-- write status/state/summary/result/approved_by/approved_at/completed_at,
-- lib/family/actions.ts resolveAutomationRun writes status/approved_by/
-- approved_at, and the run store (`updateRun`) writes with the service client.
-- So the legitimate set of RLS-subject metadata writes is empty, and this
-- refuses no live path.
--
-- Not attempted here, on purpose: refusing `status = 'executed'` while a
-- pending approval names the run's plan. The approve path closes the run on
-- the deciding parent's own session AFTER the approval flips, and a second
-- pending approval for the same plan (a different `kinds` set has a different
-- dedupe key) would make that legitimate close fail. A guard that stops the
-- honest path is the wrong guard.
--
-- errcode 42501, so PostgREST answers 403 and the probe can attribute it.
--
-- The live proof is docs/audit/automation-runs-pin-what-a-member-may-queue-check.sql:
-- a manager dropping `approval_id` or pointing it elsewhere is refused by this
-- trigger by name; the same manager adding an unrelated key LANDS; and a
-- negative control drops ONLY this trigger and requires the scrub to succeed.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent and additive: create or replace, drop trigger if exists before
-- create trigger; no column, table or policy is removed or restated.

create or replace function public.automation_run_gate_is_pinned()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_bypass boolean;
begin
  select r.rolsuper or r.rolbypassrls into v_bypass
  from pg_catalog.pg_roles r
  where r.rolname = current_user;
  if coalesce(v_bypass, false) then
    return new;
  end if;

  if (old.metadata ->> 'approval_id') is not null
     and (new.metadata ->> 'approval_id') is distinct from (old.metadata ->> 'approval_id') then
    raise exception 'a queued run keeps the approval it was born with (0390): approval_id % -> %',
      old.metadata ->> 'approval_id', coalesce(new.metadata ->> 'approval_id', '<removed>')
      using errcode = '42501';
  end if;

  if (old.metadata ->> 'plan_id') is not null
     and (new.metadata ->> 'plan_id') is distinct from (old.metadata ->> 'plan_id') then
    raise exception 'a queued run keeps the plan it was born with (0390): plan_id % -> %',
      old.metadata ->> 'plan_id', coalesce(new.metadata ->> 'plan_id', '<removed>')
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.automation_run_gate_is_pinned() is
  'BEFORE UPDATE on family_automation_runs, for callers subject to RLS: metadata->>approval_id and metadata->>plan_id, once non-null, cannot be removed or changed. The Autopilot panel''s "Do it" resolves its approval from approval_requests, not from here; this keeps the server-written cache honest (0390).';

revoke all on function public.automation_run_gate_is_pinned() from public, anon, authenticated;

drop trigger if exists family_automation_runs_gate_is_pinned on public.family_automation_runs;
create trigger family_automation_runs_gate_is_pinned
  before update on public.family_automation_runs
  for each row execute function public.automation_run_gate_is_pinned();

do $$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'family_automation_runs'
      and t.tgname = 'family_automation_runs_gate_is_pinned'
      and not t.tgisinternal
  ) then
    raise exception '0390: family_automation_runs_gate_is_pinned was not created';
  end if;

  -- 0251 owns UPDATE and 0329 owns the INSERT guard; this file narrows a
  -- column, it replaces neither.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'family_automation_runs'
      and policyname = 'family_automation_runs_update' and cmd = 'UPDATE'
  ) then
    raise exception '0390: 0251''s family_automation_runs_update policy is missing';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'family_automation_runs'
      and policyname = 'family_automation_runs_manager_insert_guard' and permissive = 'RESTRICTIVE'
  ) then
    raise exception '0390: 0329''s restrictive insert guard is missing';
  end if;

  if has_function_privilege('anon', 'public.automation_run_gate_is_pinned()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.automation_run_gate_is_pinned()', 'EXECUTE') then
    raise exception '0390: automation_run_gate_is_pinned is executable by a client role';
  end if;
end $$;

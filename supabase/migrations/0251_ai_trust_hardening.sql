-- ════════════════════════════════════════════════════════════════════════════
-- 0251 — Trust / approval hardening (backlog P1-02, spec §4/§12/§31/§43).
--
-- Two things: (1) approval_requests grows the columns the run executor needs to
-- pause on an approval and resume from it — run/step linkage, structured
-- consequences, the Edit flow, and a real expiry — and (2) the write RLS on the
-- three approval-shaped tables is narrowed from "any family member" to
-- "managers decide, requesters may cancel their own", so a signed-in teen or
-- child cannot PATCH an approval to `approved` or flip an automation run to
-- `executed` straight through PostgREST.
--
-- WHAT WAS VERIFIED BEFORE LOCKING (grepped the app; every writer listed):
--   approval_requests
--     INSERT  lib/trust/server.ts evaluateTrust() — runs as the *requesting*
--             member's RLS client for any role (a child's spend request opens
--             its own approval), so member INSERT is KEPT (the child
--             request-row exception in docs/agents/DECISIONS.md).
--     UPDATE  app/(app)/dashboard/trust/actions.ts decideApprovalAction and
--             app/(app)/dashboard/concierge/actions.ts execute/dismiss — all
--             three already refuse non-managers in code (isManager gate), so
--             manager-only UPDATE breaks no live path; it just makes the
--             database agree with the app.
--     DELETE  no writer anywhere → stays denied (0093 never created one).
--   family_automation_runs
--     INSERT  app/(app)/dashboard/concierge/actions.ts planAcceptedAction, with
--             the *member's* RLS client, for any role that can accept a plan.
--             INSERT therefore stays open to members (see the note below).
--     UPDATE  concierge executeQueuedRunAction / dismissQueuedRunAction and
--             lib/family/actions.ts resolveAutomationRun — all manager-gated.
--     DELETE  no writer → manager-only.
--   parent_approvals (0088, the wallet approval inbox)
--     INSERT  app/(app)/wallet/actions.ts requestSpendAction /
--             requestAllowanceAction — a CHILD files these, so INSERT stays
--             open to members.
--     UPDATE  decideSpendRequestAction / decideAllowanceRequestAction (manager
--             gated) and the 0205 SECURITY DEFINER wallet RPCs, which run as
--             the table owner and are unaffected by RLS.
--     DELETE  no writer → manager-only.
--
-- Note on family_automation_runs INSERT: the map's end state is for
-- planAcceptedAction to insert with createServiceClient(). Until that app
-- change lands, tightening INSERT to can_manage_family would make plan
-- acceptance fail for teen/caregiver members with an RLS error, so INSERT is
-- left at is_family_member here and the forgery risk is closed where it
-- actually matters: the AI ledgers (0250 — no member writes at all) and
-- UPDATE/DELETE on this table (managers only), which is what "Completed by
-- Bubaly" and the approve/dismiss flows read.
--
-- Additive + idempotent: every policy is `drop policy if exists` then `create`,
-- every column `add column if not exists`, every constraint guarded by
-- `exception when duplicate_object`.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── approval_requests: run linkage, consequences, Edit flow, expiry ────────
-- `consequences` is the plain-language list the approval card renders ("adds 3
-- events", "spends $42 of the dining budget") — produced by the planner or by
-- the simulate/impact helpers — so a parent is never asked to approve an opaque
-- payload. `edited_payload` holds the manager's edits when they choose Edit
-- instead of Approve; the executor then plans a new version from it.
alter table public.approval_requests
  add column if not exists request_id uuid references public.ai_requests(id) on delete set null,
  add column if not exists run_id uuid references public.family_automation_runs(id) on delete set null,
  -- plan_step_id is the FK for the common single-step gate (one risky action
  -- pauses for approval); plan_step_ids carries the batch a
  -- {kind:'plan_steps'} payload releases at once, which cannot be one FK.
  add column if not exists plan_step_id uuid references public.ai_plan_steps(id) on delete set null,
  add column if not exists plan_step_ids uuid[] not null default '{}',
  add column if not exists consequences jsonb not null default '[]'::jsonb,
  add column if not exists evidence jsonb,
  add column if not exists edited_payload jsonb,
  add column if not exists payload_kind text,
  add column if not exists reviewed_by uuid references public.family_members(id) on delete set null,
  add column if not exists review_note text;

-- Payload discriminator (§4.6): new writers set both payload->>'kind' and this
-- column so server code can branch without parsing jsonb, while the legacy
-- shape ({name, args} written by lib/trust/server.ts) leaves it null and is
-- read as a 'tool' payload.
do $$
begin
  alter table public.approval_requests
    add constraint approval_requests_payload_kind_check
    check (payload_kind is null or payload_kind in ('tool','plan_steps','concierge_plan'));
exception when duplicate_object then null;
end $$;

-- 0093 declared expires_at but nothing ever set it, so approvals sat pending
-- forever and a run could block indefinitely. Default it to 48h and give the
-- rows that are pending today the same deadline measured from their creation,
-- so the expiry sweep in /api/cron/notifications has something to act on.
alter table public.approval_requests alter column expires_at set default (now() + interval '48 hours');
update public.approval_requests
set expires_at = created_at + interval '48 hours'
where expires_at is null and status = 'pending';

create index if not exists idx_approval_requests_family_status_expires
  on public.approval_requests (family_id, status, expires_at);
create index if not exists idx_approval_requests_run on public.approval_requests (run_id) where run_id is not null;
create index if not exists idx_approval_requests_request on public.approval_requests (request_id) where request_id is not null;

-- ─── trust_audit_logs: widen the decision vocabulary ───────────────────────
-- Policy, grant, delegation, role and autonomy-dial mutations now write an
-- audit row too (§43 "every trust decision is explainable"), and the approval
-- Edit flow records 'modified'. Widening a CHECK can never fail on existing
-- rows, but it is still added NOT VALID + VALIDATE to match the house pattern
-- for constraint changes on a live table.
do $$
begin
  alter table public.trust_audit_logs drop constraint if exists trust_audit_logs_decision_check;
  alter table public.trust_audit_logs
    add constraint trust_audit_logs_decision_check
    check (decision in ('allow','deny','require_approval','auto_approve','executed','approved','rejected',
                        'emergency_override','policy_changed','grant_changed','delegation_changed',
                        'role_changed','emergency_ended','modified','approved_execution')) not valid;
  alter table public.trust_audit_logs validate constraint trust_audit_logs_decision_check;
end $$;

-- ─── approval_requests RLS ─────────────────────────────────────────────────
-- Read: every member (a child sees that their request is pending).
-- Insert: every member (they may ask — the decision is what is gated).
-- Update: managers decide; the requester may cancel their own pending request
--         and nothing else (the WITH CHECK pins the resulting status).
-- Delete: nobody through PostgREST.
alter table public.approval_requests enable row level security;
drop policy if exists approval_requests_read on public.approval_requests;
drop policy if exists approval_requests_insert on public.approval_requests;
drop policy if exists approval_requests_update on public.approval_requests;
drop policy if exists approval_requests_select on public.approval_requests;
drop policy if exists approval_requests_decide on public.approval_requests;
drop policy if exists approval_requests_cancel_own on public.approval_requests;
create policy approval_requests_select on public.approval_requests
  for select to authenticated using (public.is_family_member(family_id));
create policy approval_requests_insert on public.approval_requests
  for insert to authenticated with check (public.is_family_member(family_id));
create policy approval_requests_decide on public.approval_requests
  for update to authenticated
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));
create policy approval_requests_cancel_own on public.approval_requests
  for update to authenticated
  using (
    status = 'pending'
    and exists (
      select 1 from public.family_members fm
      where fm.id = approval_requests.requested_by_member_id
        and fm.family_id = approval_requests.family_id
        and fm.user_id = auth.uid()
        and fm.is_active
    )
  )
  with check (
    status = 'cancelled'
    and exists (
      select 1 from public.family_members fm
      where fm.id = approval_requests.requested_by_member_id
        and fm.family_id = approval_requests.family_id
        and fm.user_id = auth.uid()
        and fm.is_active
    )
  );

-- ─── family_automation_runs RLS ────────────────────────────────────────────
-- 0022 gave this table one FOR ALL policy on is_family_member, so any member
-- could set status='executed' on a run they never approved — the exact row the
-- autopilot panel and the time-saved metric count. Split it: members read and
-- file runs, managers approve/dismiss/delete, the executor writes with the
-- service client (BYPASSRLS).
alter table public.family_automation_runs enable row level security;
drop policy if exists "Members can manage family_automation_runs" on public.family_automation_runs;
drop policy if exists family_automation_runs_select on public.family_automation_runs;
drop policy if exists family_automation_runs_insert on public.family_automation_runs;
drop policy if exists family_automation_runs_update on public.family_automation_runs;
drop policy if exists family_automation_runs_delete on public.family_automation_runs;
create policy family_automation_runs_select on public.family_automation_runs
  for select to authenticated using (public.is_family_member(family_id));
create policy family_automation_runs_insert on public.family_automation_runs
  for insert to authenticated with check (public.is_family_member(family_id));
create policy family_automation_runs_update on public.family_automation_runs
  for update to authenticated
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));
create policy family_automation_runs_delete on public.family_automation_runs
  for delete to authenticated using (public.can_manage_family(family_id));

-- ─── parent_approvals RLS ──────────────────────────────────────────────────
-- Same shape, and the same reason: 0088's FOR ALL policy let the child who
-- filed a spend request approve it themselves (the money move is separately
-- guarded by 0217, but the approval inbox is what a parent reviews).
alter table public.parent_approvals enable row level security;
drop policy if exists "Members manage parent_approvals" on public.parent_approvals;
drop policy if exists parent_approvals_select on public.parent_approvals;
drop policy if exists parent_approvals_insert on public.parent_approvals;
drop policy if exists parent_approvals_update on public.parent_approvals;
drop policy if exists parent_approvals_delete on public.parent_approvals;
create policy parent_approvals_select on public.parent_approvals
  for select to authenticated using (public.is_family_member(family_id));
create policy parent_approvals_insert on public.parent_approvals
  for insert to authenticated with check (public.is_family_member(family_id));
create policy parent_approvals_update on public.parent_approvals
  for update to authenticated
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));
create policy parent_approvals_delete on public.parent_approvals
  for delete to authenticated using (public.can_manage_family(family_id));

-- Production verification (run after `supabase db push`):
--   select polname, cmd, qual from pg_policies
--    where tablename in ('approval_requests','family_automation_runs','parent_approvals');
--   select count(*) from public.approval_requests where status = 'pending' and expires_at is null; -- 0
--   As a child session: update approval_requests set status='approved' → 0 rows / RLS error.

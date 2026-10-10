-- Bubaly :: 0480 - an approval says who filed it, and only the server can say
--                   otherwise
-- ----------------------------------------------------------------------------
-- From the 2026-10-10 approvals audit (proposed-approvals-pin.sql, the SQL half
-- of audit/approvals-fix). Numbered 0480 by owner decision of 2026-10-10; the
-- SQL is the proposal's, unchanged.
--
-- ── why ─────────────────────────────────────────────────────────────────────
--
-- `approval_requests_decide` (0251) is `for update to authenticated using
-- (can_manage_family(family_id)) with check (can_manage_family(family_id))`
-- with no column pin. 0381 froze the rule columns (approval_model,
-- required_approvals, ...) and 0389 froze `payload` and every decided row,
-- but the columns that say WHO filed a pending row and WHAT it is linked to
-- are still a manager's to rewrite over /rest/v1:
--
--   * requested_by_kind / requested_by_member_id: an adult flips their own
--     member row to 'ai' and it reads as Bubaly's. The application no longer
--     trusts the column (it asks trust_audit_logs, which members cannot write,
--     0260) but the row still lies to every reader.
--   * payload_kind / plan_step_id / plan_step_ids / run_id / request_id:
--     the linkage `decide()` and the executor act on. The application now
--     finds steps only by `ai_plan_steps.approval_id`, but a rewritten
--     `payload_kind` still changes which branch a decision takes
--     ('concierge_plan' has no trust gate of its own).
--   * domain / capability / family_id: what the card says is being asked, and
--     whose it is.
--   * dedupe_key: the application reuses a pending row under a matching key.
--     It now also requires the row's filer and payload to match, but a key a
--     member can set (on insert — see B — or by PATCH) is how a planted row
--     collected Bubaly's `ai_agent` audit line in the first place.
--
-- And on concierge_plan_actions, 0158's member DELETE policy lets anyone in
-- the family erase the write-back ledger, after which the next "Make it
-- happen" (or a late approval) creates every calendar event and reminder again.
--
-- ── what this migration does ────────────────────────────────────────────────
--
--   A. One BEFORE UPDATE trigger on approval_requests, for callers subject to
--      row-level security (modelled on 0381 / 0389: the same pg_roles bypass
--      check, the same 42501 so PostgREST answers 403): requested_by_kind,
--      requested_by_member_id, payload_kind, plan_step_id, plan_step_ids,
--      run_id, request_id, domain, capability, family_id and dedupe_key cannot
--      change after insert.
--
--      Application writers checked against this list: the only post-insert
--      writers of any of these columns are lib/ai/tools/execute.ts
--      `associatePurchaseRequest` (request_id, payload_kind) and nothing else;
--      it writes through the service writer (lib/supabase/service-writer.ts),
--      which bypasses RLS and therefore this trigger. Every member-client
--      write (flipStatus, stampExecution, run cancellation in
--      lib/ai/runs/controls.ts, the private-purchase stamp) touches status,
--      approvals, decided_*, reviewed_by, review_note, edited_payload,
--      executed_at, execution_result or consequences only.
--      CAVEAT: in an environment without service credentials the service
--      writer falls back to the caller's client; there the purchase
--      association would be refused (fail-closed: the private answer is not
--      delivered). Production always has the service role.
--
--   B. approval_requests_insert (last written by 0255) is restated with one
--      added condition: `dedupe_key is null`. 0255 already requires
--      `requested_by_kind = 'member'`; it is kept. Every keyed row is filed by
--      `openApprovalRequest` / `openApproval` through the service writer.
--
--   C. concierge_plan_actions_delete (0158) is dropped. The only application
--      delete is the release of a failed reservation in
--      `materializeConciergePlan`, which (since the companion code change) goes
--      through the service writer and does not need the policy. Select,
--      insert and update are left as 0158 wrote them.
--
-- ── what does NOT change ────────────────────────────────────────────────────
--
--   * 0381's three triggers and 0389's trigger are left exactly as written;
--     this adds a fifth BEFORE UPDATE trigger and restates none of them.
--   * A pending row is as decidable as before: votes, the edit, a "no", the
--     requester's cancel, the execution stamp.
--
-- Idempotent: create or replace, drop ... if exists before every create.

-- ─── A. the filer and the linkage are pinned ────────────────────────────────

create or replace function public.approval_request_identity_is_pinned()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_bypass boolean;
begin
  -- The server bypasses row-level security, and so does this (0381, 0389).
  select r.rolsuper or r.rolbypassrls into v_bypass
  from pg_catalog.pg_roles r
  where r.rolname = current_user;
  if coalesce(v_bypass, false) then
    return new;
  end if;

  if new.requested_by_kind is distinct from old.requested_by_kind
     or new.requested_by_member_id is distinct from old.requested_by_member_id then
    raise exception 'who filed an approval request cannot be rewritten (0480)'
      using errcode = '42501';
  end if;

  if new.payload_kind is distinct from old.payload_kind
     or new.plan_step_id is distinct from old.plan_step_id
     or new.plan_step_ids is distinct from old.plan_step_ids
     or new.run_id is distinct from old.run_id
     or new.request_id is distinct from old.request_id then
    raise exception 'what an approval request is linked to cannot be rewritten (0480)'
      using errcode = '42501';
  end if;

  if new.domain is distinct from old.domain
     or new.capability is distinct from old.capability
     or new.family_id is distinct from old.family_id
     or new.dedupe_key is distinct from old.dedupe_key then
    raise exception 'what an approval request asks, for whom, and under which key cannot be rewritten (0480)'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.approval_request_identity_is_pinned() is
  'BEFORE UPDATE on approval_requests, for callers subject to RLS: requested_by_kind, requested_by_member_id, payload_kind, plan_step_id, plan_step_ids, run_id, request_id, domain, capability, family_id and dedupe_key never change after insert. Only the server (service role) attaches request_id/payload_kind after filing (0480).';

revoke all on function public.approval_request_identity_is_pinned() from public, anon, authenticated;

drop trigger if exists approval_requests_identity_is_pinned on public.approval_requests;
create trigger approval_requests_identity_is_pinned
  before update on public.approval_requests
  for each row execute function public.approval_request_identity_is_pinned();

-- ─── B. a member's own row carries no dedupe key ────────────────────────────
-- 0255's policy, restated verbatim, plus `dedupe_key is null`.

drop policy if exists approval_requests_insert on public.approval_requests;
create policy approval_requests_insert on public.approval_requests
  for insert to authenticated with check (
    public.is_family_member(family_id)
    and status = 'pending'
    and approvals = '[]'::jsonb
    and decided_by is null
    and decided_at is null
    and executed_at is null
    and execution_result is null
    and reviewed_by is null
    and review_note is null
    and edited_payload is null
    and requested_by_kind = 'member'
    and requested_by_member_id is not null
    and exists (
      select 1 from public.family_members fm
      where fm.id = approval_requests.requested_by_member_id
        and fm.family_id = approval_requests.family_id
        and fm.user_id = auth.uid()
        and fm.is_active
    )
    and payload_kind is null
    and request_id is null
    and run_id is null
    and plan_step_id is null
    and coalesce(plan_step_ids, '{}'::uuid[]) = '{}'::uuid[]
    and dedupe_key is null
  );

-- ─── C. the write-back ledger is not a member's to erase ────────────────────

drop policy if exists concierge_plan_actions_delete on public.concierge_plan_actions;

-- ─── self-check ─────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'approval_requests'
      and t.tgname = 'approval_requests_identity_is_pinned'
      and not t.tgisinternal
  ) then
    raise exception '0480: approval_requests_identity_is_pinned was not created';
  end if;

  -- 0381's and 0389's rules must survive intact: this adds one, replaces none.
  if not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                 where c.relname = 'approval_requests' and t.tgname = 'approval_requests_decision_is_earned')
     or not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                    where c.relname = 'approval_requests' and t.tgname = 'approval_requests_rule_is_immutable')
     or not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                    where c.relname = 'approval_requests' and t.tgname = 'approval_requests_decision_is_final') then
    raise exception '0480: an earlier approval_requests trigger (0381/0389) is missing';
  end if;

  if has_function_privilege('anon', 'public.approval_request_identity_is_pinned()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.approval_request_identity_is_pinned()', 'EXECUTE') then
    raise exception '0480: approval_request_identity_is_pinned is executable by a client role';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'approval_requests' and policyname = 'approval_requests_insert'
      and with_check ilike '%dedupe_key IS NULL%'
  ) then
    raise exception '0480: approval_requests_insert does not require dedupe_key is null';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'concierge_plan_actions' and cmd = 'DELETE'
  ) then
    raise exception '0480: concierge_plan_actions still has a DELETE policy';
  end if;
end $$;

-- Bubaly :: 0389 - a decision once made stays made
--
-- 0381 put the family's approval model into the database: a vote is the
-- voter's own (rule A), a move INTO approved/modified needs the yeses the row's
-- model asks for (rule B), and the rule columns are frozen (rule C). It gated
-- the transition into a decision and, deliberately, nothing after it — "a
-- threshold is a property of the decision, not of every write after it."
--
-- That left the other direction open. `approval_requests_decide` (0251:135-137)
-- is still
--
--   for update to authenticated
--   using      (public.can_manage_family(family_id))
--   with check (public.can_manage_family(family_id))
--
-- with no status predicate and no column pin. So on a row a parent has
-- DECLINED, any manager — the other parent, an adult, or the same person from a
-- second tab — can, with the browser session and one PATCH over /rest/v1:
--
--   1. re-open it:  {"status":"pending","approvals":[]}
--      Rule A permits it (taking votes AWAY was left open as the fail-safe
--      direction; it is not fail-safe when the vote taken away is a "no").
--      Rule B does not run (the destination is not approved/modified). The row
--      is back in `listPending`, both parents are asked again, and nothing says
--      it was ever declined.
--   2. on a 'single' / 'first_available' / 'sequential' row, approve it
--      outright:  {"status":"approved","approvals":[<their own yes>]}
--      A: one vote, their own. B: the model is satisfied by one manager's yes.
--      The row reads approved, and the readers that act on `status` act:
--      lib/ai/runs/executor.ts reconcileApprovals releases the gated step and
--      runs it with `skipTrust: true`; `decide()` never ran, so
--      `trust_audit_logs` holds no decision for the flip.
--   3. on a 'two_parent' row where the OTHER parent had approved and this one
--      declined, replace their own "no" with a "yes" and flip — A counts the
--      replaced vote as one vote in their own name, and B is satisfied.
--
-- The same door works on every decided status: approved -> rejected (after
-- the work ran), expired -> pending (a request nobody answered comes back),
-- cancelled -> pending (a run the requester stopped is asked about again).
--
-- The application treats a decision as terminal. `openForDecision`
-- (lib/services/approvals/index.ts) refuses any decision on a non-pending row
-- with "This request was already decided.", and every status writer predicates
-- on `status = 'pending'`: `flipStatus` (decide / editAndApprove), the expiry
-- sweep (`expireStale`, pending -> expired) and run cancellation
-- (lib/ai/runs/controls.ts, pending -> cancelled). Nothing in the codebase
-- moves a row OUT of a decided status. The database can say the same.
--
-- ── what this migration does ────────────────────────────────────────────────
--
-- One BEFORE UPDATE trigger, for callers subject to row-level security:
--
--   D. Once `status` is anything but 'pending', the decision is a record:
--      `status`, `approvals`, `edited_payload`, `decided_by` and `decided_at`
--      cannot change. What the application still writes to a decided row —
--      `executed_at` / `execution_result` (stampExecution, on both the
--      approved and the error path; the private-purchase result stamp in
--      lib/services/purchases/private-result.ts) — touches none of these and
--      is untouched. So is `consequences`, `request_id` and `payload_kind`,
--      which lib/ai/tools/execute.ts attaches after filing.
--
--      `edited_payload` is in the list on purpose. On a decided plan-step row
--      it is what the executor runs (lib/ai/runs/executor.ts loadApproval);
--      an edit written AFTER the deciding vote is an edit nobody voted on.
--
--   E. `payload` — the ask itself — cannot change for the life of the row.
--      It is the thing the votes are votes ON: the approval card is built from
--      it (`classifyPayload` / `effectiveArgsOf` in lib/approvals/card-data.ts),
--      `decide()` executes from it, and the concierge loop links a queued run
--      to its approval through it (`payload->>'plan_id'`). Nothing in the
--      application updates it after insert (the only post-insert writers touch
--      `consequences`, `request_id` and `payload_kind`). A rewrite between the
--      first yes and the second would make the second parent approve something
--      the first never saw, and a rewrite of `plan_id` would unlink a queued
--      run from the vote that gates it.
--
-- Both apply to exactly the callers row-level security applies to, as 0381's A
-- and B do. A role that bypasses RLS (service_role, the migration owner) is the
-- server, and none of its writers moves a row out of a decided status or
-- rewrites a payload — the exemption is stated, not relied on: the boundary
-- this closes is the browser session's PATCH.
--
-- errcode 42501 (insufficient_privilege), so PostgREST answers 403 — the same
-- answer the caller would get from a policy — and the probe can tell a refusal
-- from a bug.
--
-- ── what does NOT change ────────────────────────────────────────────────────
--
--   * `approval_requests_decide` is left exactly as 0251 wrote it, and 0381's
--     three rules are left exactly as written. This adds a fourth trigger; it
--     restates nothing.
--   * A PENDING row is as writable as before: votes (under rule A), the edit
--     (`editAndApprove`), a "no" from anyone, the requester's own cancel.
--   * The threshold is still checked on the transition and only there (0381's
--     reasoning stands): a row decided before 0381 with no votes at all still
--     takes its execution stamp.
--
-- The live proof is docs/audit/two-parents-means-two-parents-check.sql, which
-- gained the re-open, the rejected->approved flip, the approved->rejected
-- reversal, the post-decision edit and the payload rewrite as refusals, the
-- stamps on decided rows as controls that LAND, and a negative control that
-- drops ONLY this trigger and requires the flip to succeed again.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent and additive: create or replace, drop trigger if exists before
-- create trigger; no column, table or policy is removed or restated.

create or replace function public.approval_decision_is_final()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_bypass boolean;
begin
  -- The server bypasses row-level security, and so does this: see the header
  -- for why none of its writers can meet either rule below.
  select r.rolsuper or r.rolbypassrls into v_bypass
  from pg_catalog.pg_roles r
  where r.rolname = current_user;
  if coalesce(v_bypass, false) then
    return new;
  end if;

  -- E. The ask is what the votes are votes on.
  if new.payload is distinct from old.payload then
    raise exception 'the request an approval was filed with cannot be rewritten (0389)'
      using errcode = '42501';
  end if;

  -- D. A decided row is a record.
  if old.status is distinct from 'pending' then
    if new.status is distinct from old.status then
      raise exception 'an approval that was % is decided and cannot be moved to % (0389)',
        old.status, coalesce(new.status, 'null')
        using errcode = '42501';
    end if;
    if new.approvals is distinct from old.approvals
       or new.edited_payload is distinct from old.edited_payload
       or new.decided_by is distinct from old.decided_by
       or new.decided_at is distinct from old.decided_at then
      raise exception 'an approval that was % is decided; its votes, its edit and its decider cannot change (0389)',
        old.status
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.approval_decision_is_final() is
  'BEFORE UPDATE on approval_requests, for callers subject to RLS: payload never changes after insert, and once status is not pending, status/approvals/edited_payload/decided_by/decided_at are frozen. The application never moves a row out of a decided status (every status writer predicates on pending); this makes the database say the same (0389).';

revoke all on function public.approval_decision_is_final() from public, anon, authenticated;

drop trigger if exists approval_requests_decision_is_final on public.approval_requests;
create trigger approval_requests_decision_is_final
  before update on public.approval_requests
  for each row execute function public.approval_decision_is_final();

do $$
begin
  -- A migration that silently created nothing is worse than one that failed:
  -- the probe would be asserting a boundary that only looks present.
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'approval_requests'
      and t.tgname = 'approval_requests_decision_is_final'
      and not t.tgisinternal
  ) then
    raise exception '0389: approval_requests_decision_is_final was not created';
  end if;

  -- 0381's rules must survive intact: this file adds a fourth, it replaces none.
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'approval_requests' and t.tgname = 'approval_requests_decision_is_earned'
  ) or not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'approval_requests' and t.tgname = 'approval_requests_rule_is_immutable'
  ) then
    raise exception '0389: 0381''s triggers are missing from approval_requests';
  end if;

  if has_function_privilege('anon', 'public.approval_decision_is_final()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.approval_decision_is_final()', 'EXECUTE') then
    raise exception '0389: approval_decision_is_final is executable by a client role';
  end if;
end $$;

-- Bubaly :: 0344 - two parents means two parents in the database too
--
-- Settings -> Trust & Permissions offers three approval models
-- (components/modules/trust-module.tsx:449-453): "Just one parent or adult",
-- "Two parents", "Every parent and adult". The whole point of the second and
-- third is that ONE person cannot authorise the thing alone — a caregiver-grade
-- adult account, a teenager promoted to adult, a co-parent's phone left
-- unlocked.
--
-- That rule was enforced in TypeScript and nowhere else.
--
--   lib/approvals/threshold.ts:33      model -> {required, parentsOnly}
--   lib/services/approvals/index.ts    thresholdOf / countingApprovals / decide
--                                      / editAndApprove — the only enforcement
--
-- The surviving UPDATE policy for a manager on this table is
-- `approval_requests_decide` (0251:135-137):
--
--   for update to authenticated
--   using      (public.can_manage_family(family_id))
--   with check (public.can_manage_family(family_id))
--
-- `can_manage_family` (0003:22) is `role in ('parent','adult')`. The policy
-- names no column. So any signed-in adult — the very role `decide()` refuses at
-- index.ts with "This one needs two parents to agree" — could
--
--   PATCH /rest/v1/approval_requests?id=eq.<id>   {"status":"approved"}
--
-- straight through PostgREST with the browser session
-- (lib/supabase/client.ts), from a family's own account, and the database said
-- yes. 0251's own header says the reason that migration existed was that
-- someone "cannot PATCH an approval to `approved` ... straight through
-- PostgREST". For the DECIDE path it never closed it, and index.ts says so out
-- loud — "approval_requests_decide lets any manager write any column on a
-- pending row."
--
-- What the flip costs, in order of how much it takes:
--
--   1. The request is closed. `listPending` filters `status = 'pending'` and
--      `openForDecision` refuses a non-pending row ("This request was already
--      decided."), so the second parent can never vote. A two-parent request is
--      permanently and silently decided by one person.
--   2. `trust_audit_logs` has no decision row for it, because `auditDecision`
--      only runs inside `decide()`.
--   3. Add a second PATCH on `family_automation_runs` (state='ready', same
--      role-only policy at 0251:178) and on the next cron tick
--      lib/ai/runs/executor.ts reconcileApprovals reads ONLY `status`, returns
--      the gated step to 'ready', and the executor calls the tool with
--      `skipTrust: true` — the high-risk work a family put behind "Two parents"
--      performed on one adult's say-so.
--
-- `status = 'modified'` is the same door: reconcileApprovals treats
-- 'approved' and 'modified' identically, so both are gated here.
--
-- ── what this migration does ────────────────────────────────────────────────
--
-- Three rules, all enforced by a BEFORE UPDATE trigger rather than by a policy:
--
--   A. A vote is cast by the member it names. `approvals` is the evidence the
--      threshold is counted from, and it is a column any manager may write, so
--      without this rule the threshold below is theatre: an adult writes
--      `[{"member_id":"<mum>","decision":"approved"},
--        {"member_id":"<dad>","decision":"approved"}]` — both ids are one
--      family_members read away — and flips. An UPDATE may therefore ADD at
--      most one vote, and it must name the caller's own active membership in
--      this family. That is exactly what `decide()` and `editAndApprove()`
--      write (`[...prior, { member_id: scope.memberId, ... }]`), on the
--      caller's own session. Taking votes AWAY is not refused: it can only
--      lower the count, which is the fail-safe direction, and `priorVotes`
--      already drops malformed entries when it rewrites the array.
--
--   B. `approved` / `modified` must be earned. On the TRANSITION into either,
--      the row's votes must satisfy its own approval model
--      (`approval_votes_satisfy`, which mirrors thresholdFor). It is checked on
--      the transition and only there: a policy's WITH CHECK would re-run on
--      every later write to an already-decided row (stampExecution's
--      executed_at, a private-purchase result stamp) and refuse those for rows
--      decided before this migration or whose approver has since left — a
--      threshold is a property of the decision, not of every write after it.
--      Row-level security cannot see OLD, so this has to be a trigger.
--
--   C. `approval_model` and `required_approvals` cannot change after the row
--      is filed. Without it A and B are one extra PATCH away: set
--      approval_model='single', then flip. Nothing in the application updates
--      either column — they are written once, at insert, by
--      lib/trust/server.ts:214 and lib/ai/tools/execute.ts:530, and neither
--      appears in the table's Update type in lib/database.types.ts — so this
--      applies to every role, the service role included: a rule the family
--      chose is not a rule Bubaly gets to relax.
--
-- A and B apply to exactly the callers row-level security applies to. A role
-- that bypasses RLS (service_role, the migration owner) is the server, and
-- none of the server's own writers moves a row into approved/modified: the
-- expiry sweep writes 'expired', run cancellation writes 'cancelled', and
-- `decide()` runs on the deciding member's own session. So the approval path a
-- family uses is subject to all three rules, and nothing the server does is
-- newly refused.
--
-- `approval_requests_decide` itself is left exactly as 0251 wrote it: a
-- manager may still open any of their family's rows, record their own vote,
-- leave it pending, reject it (one "no" still stops the AI whoever says it),
-- or let the cron expire it. `approval_requests_cancel_own` (0251:139) is
-- untouched and cannot be used as a way around this: its own WITH CHECK pins
-- `status = 'cancelled'`.
--
-- ── no SECURITY DEFINER, on purpose ─────────────────────────────────────────
--
-- Both functions run as the CALLER. The threshold helper reads family_members,
-- and a caller can read only their own family's members (fm_select,
-- 0118:66-68), so a direct call about some other family counts nothing and
-- answers false. A definer version of the same helper would have been a
-- membership oracle: `approval_votes_satisfy('<family>','two_parent',1,
-- '[{"decision":"approved","member_id":"<uuid>"}]')` would say whether any
-- uuid is an active parent of any family, past family_members' RLS. EXECUTE is
-- still revoked from PUBLIC and anon, and granted only to the roles that write
-- this table (0341:324-327 is the pattern).
--
-- ── two ways this is deliberately STRICTER than the TypeScript ──────────────
--
-- 1. A counted yes must name a member who is, right now, an active
--    parent/adult of THIS family, and `parentsOnly` is decided from that
--    member's current role — not from the `role` string stored inside the vote,
--    which the voter wrote themselves. The cost is one rare, fail-closed
--    divergence: a parent demoted to adult between voting and the deciding
--    vote no longer counts, and `decide()`'s flip is refused rather than
--    succeeding ("Bubaly could not record that decision."). Refusing a decision
--    the family may have wanted is a visible, recoverable outcome; counting a
--    vote that no longer carries the authority it claims is not.
-- 2. Votes are counted by DISTINCT member, so a duplicated array entry cannot
--    stand in for a second person.
--
-- ── what this does NOT close ────────────────────────────────────────────────
--
-- A manager can still change who the family's parents are. fm_insert and
-- fm_update (0118:69-71, 0211:11-14) are `can_manage_family` with no column
-- pin, so an adult can promote their own membership to 'parent', or add a
-- membership for a second account they control, and then cast the second
-- vote from that account. That is a role-escalation boundary on
-- family_members, not on approvals, and is recorded as its own finding rather
-- than folded in here.
--
-- Everything below is idempotent (create or replace, drop ... if exists before
-- create) and additive — no column, table or policy is removed or restated.

-- ── the threshold, mirrored from lib/approvals/threshold.ts ─────────────────
-- thresholdFor(model, stored, managerCount):
--   'two_parent' -> {required: max(2, floor), parentsOnly: true}
--   'consensus'  -> {required: max(activeManagers, floor), parentsOnly: false}
--   anything else (incl. 'single', 'first_available', 'sequential', null)
--                -> {required: floor, parentsOnly: false}
-- where floor = max(1, required_approvals) — a stored count may RAISE a
-- model's floor and never lower it.
create or replace function public.approval_votes_satisfy(
  p_family_id uuid,
  p_model text,
  p_required integer,
  p_votes jsonb
)
returns boolean
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_floor        integer := greatest(1, coalesce(p_required, 1));
  v_required     integer;
  v_parents_only boolean;
  v_managers     integer;
  v_counted      integer := 0;
  v_seen         uuid[]  := '{}';
  v_vote         jsonb;
  v_member_id    uuid;
  v_role         text;
begin
  -- `approvals` is `jsonb NOT NULL DEFAULT '[]'` (0093:106), so a bare
  -- {"status":"approved"} PATCH arrives here as an EMPTY array and is refused
  -- by the count at the bottom (0 < at least 1). This arm is only for a value
  -- that is not an array at all, which counts nothing either.
  if p_votes is null or jsonb_typeof(p_votes) <> 'array' then
    return false;
  end if;

  if p_model = 'two_parent' then
    v_required := greatest(2, v_floor);
    v_parents_only := true;
  elsif p_model = 'consensus' then
    select count(*) into v_managers
    from public.family_members fm
    where fm.family_id = p_family_id
      and fm.is_active
      and fm.role in ('parent', 'adult');
    -- Clamped to at least one, so a single-manager household is not left with
    -- an unreachable threshold (thresholdFor does the same).
    v_required := greatest(greatest(1, coalesce(v_managers, 0)), v_floor);
    v_parents_only := false;
  else
    v_required := v_floor;
    v_parents_only := false;
  end if;

  -- Counted in a loop rather than one set query on purpose: `member_id` is
  -- caller-supplied text, and a cast inside a join condition can be evaluated
  -- before the filter that was meant to protect it. The arrays hold a handful
  -- of votes at most.
  for v_vote in select value from jsonb_array_elements(p_votes) loop
    if jsonb_typeof(v_vote) <> 'object' then
      continue;
    end if;
    if coalesce(v_vote->>'decision', '') <> 'approved' then
      continue;
    end if;
    if coalesce(v_vote->>'member_id', '') !~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      continue;
    end if;
    v_member_id := (v_vote->>'member_id')::uuid;
    -- One person, one vote: a duplicated entry is not a second yes.
    if v_member_id = any (v_seen) then
      continue;
    end if;

    v_role := null;
    select fm.role into v_role
    from public.family_members fm
    where fm.id = v_member_id
      and fm.family_id = p_family_id
      and fm.is_active
      and fm.role in ('parent', 'adult');
    if v_role is null then
      continue;
    end if;
    if v_parents_only and v_role <> 'parent' then
      continue;
    end if;

    v_seen := v_seen || v_member_id;
    v_counted := v_counted + 1;
  end loop;

  return v_counted >= v_required;
end;
$$;

comment on function public.approval_votes_satisfy(uuid, text, integer, jsonb) is
  'Does approval_requests.approvals hold enough real, distinct, correctly-roled yeses for this row''s approval_model/required_approvals? Mirrors thresholdFor + countingApprovals in lib/approvals/threshold.ts and lib/services/approvals/index.ts. SECURITY INVOKER: it counts only members the caller can already see (0344).';

revoke all on function public.approval_votes_satisfy(uuid, text, integer, jsonb) from public, anon;
grant execute on function public.approval_votes_satisfy(uuid, text, integer, jsonb) to authenticated, service_role;

-- ── A + B: a vote is the voter's own, and a decision is earned ──────────────
create or replace function public.approval_decision_is_earned()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_bypass   boolean;
  v_old      jsonb := coalesce(old.approvals, '[]'::jsonb);
  v_new      jsonb := coalesce(new.approvals, '[]'::jsonb);
  v_caller   uuid;
  v_added    integer;
  v_foreign  integer;
begin
  -- The server bypasses row-level security, and so does this: see the header
  -- for why none of its writers can meet either rule below.
  select r.rolsuper or r.rolbypassrls into v_bypass
  from pg_catalog.pg_roles r
  where r.rolname = current_user;
  if coalesce(v_bypass, false) then
    return new;
  end if;

  -- A. Votes added by this UPDATE must be the caller's own, and there may be at
  --    most one. "Added" is any element of the new array that is not, exactly,
  --    an element of the old one — so editing someone else's vote counts as
  --    adding a vote in their name, and is refused.
  if v_new is distinct from v_old then
    if jsonb_typeof(v_new) <> 'array' then
      raise exception 'approval votes must be a list (0344)'
        using errcode = '42501';
    end if;
    if jsonb_typeof(v_old) <> 'array' then
      v_old := '[]'::jsonb;
    end if;

    select fm.id into v_caller
    from public.family_members fm
    where fm.family_id = old.family_id
      and fm.user_id = auth.uid()
      and fm.is_active
    limit 1;

    select count(*),
           count(*) filter (
             where v_caller is null
                or lower(coalesce(e.value->>'member_id', '')) <> v_caller::text
           )
      into v_added, v_foreign
    from jsonb_array_elements(v_new) e
    where not exists (
      select 1 from jsonb_array_elements(v_old) o where o.value = e.value
    );

    if v_added > 1 or v_foreign > 0 then
      raise exception 'a vote on an approval can only be cast by the member it names, one at a time (0344)'
        using errcode = '42501';
    end if;
  end if;

  -- B. Declaring a row approved or modified needs the yeses its own model asks
  --    for. The rule columns are read from OLD: C below pins them, and the
  --    rule a row was filed under is the one it is decided under.
  if new.status in ('approved', 'modified') and new.status is distinct from old.status then
    if not public.approval_votes_satisfy(old.family_id, old.approval_model, old.required_approvals, v_new) then
      raise exception 'this approval does not have the yeses its % rule needs yet (0344)',
        coalesce(old.approval_model, 'single')
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.approval_decision_is_earned() is
  'BEFORE UPDATE on approval_requests, for callers subject to RLS: an UPDATE may add at most one vote and only in the caller''s own name, and a transition into approved/modified must satisfy approval_votes_satisfy for the row''s own model (0344).';

revoke all on function public.approval_decision_is_earned() from public, anon, authenticated;

drop trigger if exists approval_requests_decision_is_earned on public.approval_requests;
create trigger approval_requests_decision_is_earned
  before update on public.approval_requests
  for each row execute function public.approval_decision_is_earned();

-- ── C: the rule cannot be weakened on the way past ──────────────────────────
create or replace function public.approval_rule_is_immutable()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.approval_model is distinct from old.approval_model then
    raise exception
      'approval_model cannot change after the request is filed (0344): % -> %',
      old.approval_model, new.approval_model;
  end if;
  if new.required_approvals is distinct from old.required_approvals then
    raise exception
      'required_approvals cannot change after the request is filed (0344): % -> %',
      old.required_approvals, new.required_approvals;
  end if;
  return new;
end;
$$;

comment on function public.approval_rule_is_immutable() is
  'Pins approval_requests.approval_model and required_approvals for the life of the row. Without it the decision rule in approval_decision_is_earned is one extra PATCH away: set approval_model=''single'', then flip status to approved (0344).';

revoke all on function public.approval_rule_is_immutable() from public, anon, authenticated;

drop trigger if exists approval_requests_rule_is_immutable on public.approval_requests;
create trigger approval_requests_rule_is_immutable
  before update on public.approval_requests
  for each row execute function public.approval_rule_is_immutable();

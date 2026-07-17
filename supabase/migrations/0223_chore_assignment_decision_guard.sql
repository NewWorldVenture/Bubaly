-- FamilyOS :: 0223 - chore assignment decision-status guard (A-07 defense-in-depth, sibling of 0222)
--
-- chore_assignments shipped (0043) with `is_family_member` FOR ALL write policies,
-- so a child could `update chore_assignments set status='approved'` directly via
-- PostgREST and forge the COMPLETION of their own chore — the assignment status is
-- the record the dashboard reads as "done/approved" (lib/chores/dashboard.ts:
-- COMPLETED_STATUSES). This mints no money (the reward is credited imperatively in
-- finalizeApproval under the manager-only wallet RLS, 0217 — never by this status),
-- so it is an accountability/integrity forgery, not a money-minting one; it is the
-- direct sibling of the chore_submissions forge closed in 0222 (PLA-0612).
--
-- Only two code paths set an assignment to a decision status, both already
-- privileged: finalizeApproval -> 'approved' (service role on auto-approve, or a
-- manager session on manual approve) and rejectSubmissionAction -> 'rejected'
-- (manager, isManager-gated). Members legitimately drive todo/in_progress/
-- submitted/done only. So this guard breaks no legitimate flow.
--
-- Guarded statuses: approved, rejected. Member-allowed: todo, in_progress,
-- submitted, done.

do $$
begin
  if to_regclass('public.chore_assignments') is null then
    return;
  end if;

  create or replace function public.chore_assignment_decision_guard()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public
  as $fn$
  begin
    -- Only guard transitions INTO a manager-decision status.
    if new.status in ('approved','rejected')
       and (tg_op = 'INSERT' or new.status is distinct from old.status) then
      -- Allow the trusted server (service role, or a migration/seed running
      -- without an authenticated session) and family managers (parent/adult).
      -- Block a plain member (e.g. a child self-completing their own chore).
      if current_user = 'service_role'
         or coalesce(auth.role(), '') = 'service_role'
         or auth.uid() is null
         or public.can_manage_family(new.family_id) then
        return new;
      end if;
      raise exception
        'chore assignment status % may only be set by a family manager', new.status
        using errcode = '42501';
    end if;
    return new;
  end;
  $fn$;

  drop trigger if exists trg_chore_assignment_decision_guard on public.chore_assignments;
  create trigger trg_chore_assignment_decision_guard
    before insert or update on public.chore_assignments
    for each row execute function public.chore_assignment_decision_guard();
end $$;

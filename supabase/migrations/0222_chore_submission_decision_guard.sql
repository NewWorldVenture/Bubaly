-- Bubaly :: 0222 - chore submission decision-status guard (A-07 defense-in-depth)
--
-- chore_submissions shipped (0043) with a single `FOR ALL ... USING/ WITH CHECK
-- is_family_member` policy. Children hold real Supabase sessions and the anon key
-- ships in the client bundle, so a child could `update chore_submissions set
-- status='approved'` directly via PostgREST and forge an approval of their own
-- proof — bypassing the manager-gated approve/reject server actions (PLA-0450).
-- Proven live on the PG16 harness: a non-manager UPDATE to status='approved'
-- succeeded pre-0222.
--
-- The money path is already decoupled (0217 routes the reward credit through the
-- service role, and no trigger mints on this status), so a forged status is a
-- data-integrity problem, not a money-minting one. This migration closes it at
-- the DB layer: only a family manager or the trusted server (service role /
-- migration / seed context) may transition a submission INTO a manager-decision
-- status. Members may still create submissions (status='pending') and dispute
-- them (status='disputed'); the AI-verdict and auto-approve writes now run under
-- the service role (see submitProofAction), so legitimate flows are unaffected.
--
-- Decision statuses guarded: approved, rejected, needs_improvement, parent_review.
-- Member-allowed statuses: pending, ai_reviewed, disputed.

do $$
begin
  if to_regclass('public.chore_submissions') is null then
    return;
  end if;

  create or replace function public.chore_submission_decision_guard()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public
  as $fn$
  begin
    -- Only guard transitions INTO a manager-decision status.
    if new.status in ('approved','rejected','needs_improvement','parent_review')
       and (tg_op = 'INSERT' or new.status is distinct from old.status) then
      -- Allow the trusted server (service role, or a migration/seed running
      -- without an authenticated session) and family managers (parent/adult).
      -- Block a plain member (e.g. a child self-approving their own proof).
      if current_user = 'service_role'
         or coalesce(auth.role(), '') = 'service_role'
         or auth.uid() is null
         or public.can_manage_family(new.family_id) then
        return new;
      end if;
      raise exception
        'chore submission status % may only be set by a family manager', new.status
        using errcode = '42501';
    end if;
    return new;
  end;
  $fn$;

  drop trigger if exists trg_chore_submission_decision_guard on public.chore_submissions;
  create trigger trg_chore_submission_decision_guard
    before insert or update on public.chore_submissions
    for each row execute function public.chore_submission_decision_guard();
end $$;

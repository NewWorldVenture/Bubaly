-- Bubaly :: 0331 - chore_assignments.ai_score may only hold a number the AI
--                  actually produced (AUTHZ-014)
--
-- `chore_assignments.ai_score` was added by `00430_chore_missions.sql` (~L46)
-- and has not appeared in a migration since. The table's four policies are
-- `0004_rls.sql`'s role-blind CRUD set (`is_family_member(family_id)`), and the
-- BEFORE trigger on it guards the decision STATUS (0223) and the two award
-- amounts `points_awarded` / `cash_awarded_cents` (0305) — and nothing else.
-- A child may legitimately move their own assignment to 'done' or 'submitted',
-- and could set `ai_score` in the same statement. Measured on a replayed
-- database with all 343 migrations applied, acting as a `child` member:
--
--   update chore_assignments set ai_score = 100  where id = <mine>  -> UPDATE 1
--   update chore_assignments set ai_score = null where id = <mine>  -> UPDATE 1
--   insert into chore_assignments (… , ai_score) values (…, 100)    -> INSERT 1
--   update chore_assignments set status='done', ai_score=100        -> UPDATE 1
--
-- Where that number ends up: `approveSubmissionAction`
-- (app/(app)/missions/actions.ts ~L305) computes
--
--   const score = intVal(formData, 'score') ?? assignment.ai_score ?? 100;
--
-- and hands it to `finalizeApproval` -> `computeReward(rewardConfig(chore),
-- score)` (lib/chores/logic.ts). For `reward_mode = 'ai_cash'` that is
-- `scaleByScore(cash_min_cents, cash_max_cents, score)`; for `'ai_points'` the
-- points band. The result is written to `cash_awarded_cents` IN THE PARENT'S
-- SESSION, which is exactly how it satisfies 0305's guard, and
-- `payChoreRewardAction` (app/(app)/wallet/actions.ts ~L191) then credits the
-- wallet from `assignment.cash_awarded_cents`. Fixed-price chores
-- (`fixed_cash` / `fixed_points` / `prize` / `responsibility`) ignore the score
-- entirely and are unaffected.
--
-- ── why a BLANKET refusal would be WRONG, which is the whole point ──────────
-- The obvious repair — "a non-manager may not write ai_score" — breaks the
-- product for every child in the family. `submitProofAction` writes this column
-- in the CHILD'S OWN RLS-bound session (app/(app)/missions/actions.ts ~L194):
--
--   const { data: updatedAssignment } = await supabase.from('chore_assignments')
--     .update({ ai_score: verdict.quality_score, submitted_at: … })
--
-- `supabase` there is `createServer()`, i.e. the submitting member. The comment
-- immediately above it says the AI verdict and the decision statuses are server
-- decisions and routes THOSE through `createServiceClient()` — the validation
-- row insert and every `setSubmissionStatus` call do use the service client —
-- but this one assignment update does not. So the AI validation pass is NOT the
-- only writer of `ai_score`; an ordinary member is a legitimate writer of it,
-- every single time a child submits proof. A manager-only guard here would
-- return 42501 on the normal submit path for every child.
--
-- `restoreAssignmentState` (~L54) is the second member-session writer: it puts
-- `ai_score` back to whatever the row held before, on the failure paths of that
-- same action. Nothing else in the codebase writes the column — checked against
-- every `.from('chore_assignments')` call site in app/, lib/, components/ and
-- mobile/; the other writers touch `status`, `member_id`, the award columns or
-- `disputed`.
--
-- ── so the shape is a PIN, not a refusal ────────────────────────────────────
-- The narrower true rule is the one the column's own name states: `ai_score` is
-- what the AI said. `chore_ai_validations` is the service-written record of what
-- the AI said, and it is genuinely SELECT-only for members — `00430` ~L213
-- creates `chore_ai_validations_select` and no INSERT, UPDATE or DELETE policy
-- exists at all. Measured, as a child: INSERT is refused by RLS outright,
-- UPDATE and DELETE affect 0 rows. That makes it a sound anchor.
--
-- So a non-manager may set `ai_score` only to a value that a service-written
-- validation actually produced for one of THIS assignment's own submissions,
-- by this member. `submitProofAction` inserts that validation row (service
-- client) BEFORE it writes the assignment, and writes the identical
-- `verdict.quality_score` — so the legitimate path passes unchanged, and a
-- typed-in 100 does not. This is `0320`'s move (pin a column to a trusted
-- source) rather than `0322`'s (take the table away), for the same reason
-- `0326` chose a trigger: the blanket version would take the feature away from
-- the person it exists for.
--
-- ── what this deliberately still allows, stated rather than hidden ─────────
--  * CLEARING it to NULL. `restoreAssignmentState` does exactly that when the
--    submission it just created is rolled back, so blocking it would break a
--    real path. It also buys an attacker nothing: `?? assignment.ai_score ??
--    100` treats a missing score as a PERFECT one, so the null case is the
--    application's own default and not a number a child wrote. That default is
--    an application decision and is recorded as such — it is not something a
--    column guard can fix.
--  * A MANAGER setting any score, on the same terms 0223 and 0305 allow: a
--    parent deciding what their child's work was worth is the feature.
--  * The trusted server (service role, or a migration/seed with no
--    authenticated session), unchanged.
--
-- And what it does NOT close, so nobody reads more into it than is there:
-- `chore_submissions` is still role-blind `FOR ALL` (00430 ~L195) and `0222`
-- guards only 'approved'/'rejected'/'needs_improvement'/'parent_review', while
-- the review queue's REVIEW_STATUSES (app/(app)/missions/page.tsx ~L15) also
-- accepts the UNGUARDED 'pending', 'ai_reviewed' and 'disputed'. A child can
-- therefore still put a validation-less submission in front of a parent — which
-- is what makes the `?? 100` default reachable at all, and is also the residual
-- way to move a score between assignments (re-point a validated submission's
-- `assignment_id`). That is a separate finding about a different table; this
-- migration does not widen into it.
--
-- The guard is 0223's own function, extended in place for the third time rather
-- than added alongside, so there is still ONE trigger on this table and one
-- place to read what it allows. 0223's status rule and 0305's amount rule are
-- carried through verbatim.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent.

do $$
begin
  if to_regclass('public.chore_assignments') is null then
    return;
  end if;

  create or replace function public.chore_assignment_decision_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $guard$
  declare
    deciding boolean;
    amount_changed boolean;
    score_changed boolean;
    vouched boolean;
  begin
    -- A transition INTO a manager-decision status (0223's original rule).
    deciding := new.status in ('approved','rejected')
      and (tg_op = 'INSERT' or new.status is distinct from old.status);

    -- Or a change to what the approval is WORTH, at any status (0305). On
    -- INSERT a non-null amount counts as setting it; on UPDATE only an actual
    -- change does, so a member ticking a chore 'done' without touching the
    -- amounts passes exactly as before.
    amount_changed := case
      when tg_op = 'INSERT' then
        coalesce(new.points_awarded, 0) <> 0 or coalesce(new.cash_awarded_cents, 0) <> 0
      else
        new.points_awarded is distinct from old.points_awarded
        or new.cash_awarded_cents is distinct from old.cash_awarded_cents
    end;

    -- Or a change to the SCORE the award is computed from (0331). Same rule:
    -- on INSERT, setting it at all; on UPDATE, only an actual change.
    score_changed := case
      when tg_op = 'INSERT' then new.ai_score is not null
      else new.ai_score is distinct from old.ai_score
    end;

    if deciding or amount_changed or score_changed then
      -- Allow the trusted server (service role, or a migration/seed running
      -- without an authenticated session) and family managers (parent/adult).
      -- Block a plain member (e.g. a child self-completing their own chore).
      if current_user = 'service_role'
         or coalesce(auth.role(), '') = 'service_role'
         or auth.uid() is null
         or public.can_manage_family(new.family_id) then
        return new;
      end if;
      if deciding then
        raise exception
          'chore assignment status % may only be set by a family manager', new.status
          using errcode = '42501';
      end if;
      if amount_changed then
        raise exception
          'chore assignment award amounts may only be set by a family manager'
          using errcode = '42501';
      end if;

      -- A member reached here by changing ai_score alone.
      --
      -- Clearing it is allowed: submitProofAction's rollback
      -- (restoreAssignmentState) puts the previous value back in the member's
      -- own session, and a null score is the absence of a number rather than a
      -- number the member chose.
      if new.ai_score is null then
        return new;
      end if;

      -- Otherwise the value must be one the AI actually produced for this
      -- assignment, for this member. chore_ai_validations is SELECT-only for
      -- members (00430), so the member cannot author its own vouching row; and
      -- submitProofAction writes that row (service client) before it writes
      -- this column, with the identical verdict.quality_score.
      select exists (
        select 1
        from public.chore_ai_validations v
        join public.chore_submissions s on s.id = v.submission_id
        where s.assignment_id = new.id
          and s.family_id     = new.family_id
          and s.member_id     = new.member_id
          and v.quality_score = new.ai_score
      ) into vouched;

      if vouched then
        return new;
      end if;

      raise exception
        'chore assignment ai_score % is not a score any AI validation produced for this assignment', new.ai_score
        using errcode = '42501';
    end if;
    return new;
  end;
  $guard$;

  comment on function public.chore_assignment_decision_guard() is
    'Guards the manager-decision statuses (0223), the award amounts points_awarded / cash_awarded_cents (0305), and ai_score (0331). ai_score is PINNED rather than refused: submitProofAction writes it in the submitting child''s own session, so a manager-only rule would break every child''s submit. A non-manager may only set it to a quality_score a service-written chore_ai_validations row produced for one of this assignment''s own submissions, or clear it (which restoreAssignmentState does on rollback). The score matters because approveSubmissionAction falls back to it and computeReward scales an ai_cash payout from it.';

  drop trigger if exists trg_chore_assignment_decision_guard on public.chore_assignments;
  create trigger trg_chore_assignment_decision_guard
    before insert or update on public.chore_assignments
    for each row execute function public.chore_assignment_decision_guard();
end
$$;

-- A migration that silently created nothing is worse than one that failed: the
-- probe would be asserting a boundary that only looks present.
do $$
begin
  if to_regclass('public.chore_assignments') is null then
    return;
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.chore_assignments'::regclass
      and tgname = 'trg_chore_assignment_decision_guard'
      and not tgisinternal
  ) then
    raise exception '0331: the chore assignment decision guard was not created';
  end if;
  if (select prosrc from pg_proc where proname = 'chore_assignment_decision_guard') not like '%chore_ai_validations%' then
    raise exception '0331: the guard function does not pin ai_score to chore_ai_validations';
  end if;
  raise notice '0331 OK: ai_score may only hold a score an AI validation produced; 0223 status and 0305 amount rules carried through.';
end $$;

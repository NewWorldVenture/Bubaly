-- Bubaly :: 0305 - the award AMOUNTS on a chore assignment, not just its status
--
-- 0223 guards the chore-assignment STATUS: a child cannot move their own
-- assignment into 'approved' or 'rejected'. That holds — measured, it refuses
-- with 42501. What it does not guard is the two columns that say how much the
-- approval was worth:
--
--   chore_assignments.points_awarded
--   chore_assignments.cash_awarded_cents
--
-- A child may legitimately set their own assignment to 'done' (a chore that
-- needs no approval is theirs to tick off), and 'done' is not a guarded status.
-- Nothing stopped them setting the amounts in the same statement. Measured on a
-- replayed database with every migration applied, acting as a child:
--
--   update chore_assignments set status='done', points_awarded=9999   -> 1 row
--   update chore_assignments set status='done', cash_awarded_cents=500000 -> 1 row
--
-- What that reaches, stated precisely, because the two columns differ:
--
--   * points_awarded — the SPENDABLE rewards balance counts only 'approved'
--     rows (lib/rewards/points.ts skips anything else), and a real approval
--     overwrites the column server-side, so this does not mint spendable
--     points. It does inflate every DISPLAY that counts 'done': the kids page,
--     the per-member standings in lib/chores/dashboard.ts, the 30-day figure on
--     the profile, and the chore numbers fed to a model in lib/ai/insights.ts.
--     A leaderboard forgery of the same kind 0222, 0223 and 0295 exist to stop.
--
--   * cash_awarded_cents — this one is read by a PAYOUT.
--     app/(app)/wallet/actions.ts:payChoreRewardAction computes
--     `assignment.cash_awarded_cents ?? chore?.cash_cents ?? 0` and credits the
--     child's wallet with it. The action is manager-gated and idempotent per
--     assignment, and the chores board hides its Pay button while the column is
--     truthy (`canPay = … && !a.cash_awarded_cents`) — so the ordinary click
--     path does not currently pay a forged amount. That is an accident of a
--     condition written for idempotency, not a boundary: the number a child
--     wrote is trusted by a money path, and the only thing between them is a
--     button's display rule. A server action is directly invocable, and the day
--     that condition changes the mitigation is gone.
--
-- So the amounts join the status: the trusted server and family managers may
-- set them, a plain member may not. Everything a member legitimately does is
-- untouched — ticking a chore 'done', submitting it, leaving the amounts alone.
--
-- The guard is 0223's own, extended in place rather than added alongside, so
-- there is one trigger on this table and one place to read what it allows.

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
  begin
    -- A transition INTO a manager-decision status (0223's original rule).
    deciding := new.status in ('approved','rejected')
      and (tg_op = 'INSERT' or new.status is distinct from old.status);

    -- Or a change to what the approval is WORTH, at any status. On INSERT a
    -- non-null amount counts as setting it; on UPDATE only an actual change
    -- does, so a member ticking a chore 'done' without touching the amounts
    -- passes exactly as before.
    amount_changed := case
      when tg_op = 'INSERT' then
        coalesce(new.points_awarded, 0) <> 0 or coalesce(new.cash_awarded_cents, 0) <> 0
      else
        new.points_awarded is distinct from old.points_awarded
        or new.cash_awarded_cents is distinct from old.cash_awarded_cents
    end;

    if deciding or amount_changed then
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
      raise exception
        'chore assignment award amounts may only be set by a family manager'
        using errcode = '42501';
    end if;
    return new;
  end;
  $guard$;

  comment on function public.chore_assignment_decision_guard() is
    'Guards both the manager-decision statuses (0223) and the award amounts points_awarded / cash_awarded_cents (0305). The amounts matter because payChoreRewardAction credits a wallet from cash_awarded_cents.';

  drop trigger if exists trg_chore_assignment_decision_guard on public.chore_assignments;
  create trigger trg_chore_assignment_decision_guard
    before insert or update on public.chore_assignments
    for each row execute function public.chore_assignment_decision_guard();
end
$$;

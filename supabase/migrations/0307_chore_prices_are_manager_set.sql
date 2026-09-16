-- Bubaly :: 0307 - the chore's own price, which 0305 did not reach
--
-- 0305 closed `chore_assignments.cash_awarded_cents`, the override a manager
-- writes at approval. The payout reads that column with a fallback:
--
--   app/(app)/wallet/actions.ts:206
--     const amount = assignment.cash_awarded_cents ?? chore?.cash_cents ?? 0;
--
-- An ordinary chore carries no override, so the number a parent's Pay click
-- credits is `chores.cash_cents` — and `chores` has four permissive policies
-- whose entire condition is `is_family_member(family_id)`.
--
-- This is worse than the column 0305 fixed, not the same. There, the chores
-- board's `canPay = … && !a.cash_awarded_cents` happened to hide the Pay button
-- once the column was set, so the ordinary click path did not pay a forged
-- amount. Here the button's condition is
--
--   canPay = manager && done && (a.chore?.cash_cents ?? 0) > 0 && !a.cash_awarded_cents
--   (components/modules/chores-module.tsx:554)
--
-- which is exactly the state a child can manufacture: create the chore, price
-- it, assign it to yourself, tick it done. The parent is then shown
-- "Pay $5,000.00" on a chore their child wrote and priced. There is no accident
-- standing in the way this time; this is the happy path.
--
-- Measured on a replayed database with every migration applied, acting as a
-- child of the family, with both positive controls passing: the child CREATED a
-- chore paying 500000 cents, RAISED a manager's chore from 500 to 500000, set
-- its cash range, and re-priced it in points. See
-- docs/audit/chore-price-check.sql.
--
-- ── what is guarded, and what deliberately is not ───────────────────────────
--
-- CASH — `cash_cents`, `cash_min_cents`, `cash_max_cents` — is manager-only to
-- set or to change. No legitimate member writer exists: the only writer in the
-- product is `createChoreAction`, whose own comment reads "Parent creates a
-- chore" (this migration ships with the manager check that comment always
-- implied), and the assistant's tasks service never sets a cash column at all.
--
-- POINTS — `points`, `points_min`, `points_max` — is guarded on CHANGE only, so
-- a member may still create a chore carrying points. That is not a concession,
-- it is the assistant path: lib/services/tasks/index.ts inserts
-- `points: input.points ?? 10` through the CALLING USER's client, so a guard on
-- INSERT would close a working feature rather than a hole. Points reach a
-- balance only through an approval a manager makes with the number in front of
-- them, and 0305 already owns `points_awarded`; re-pricing somebody else's
-- standing chore is the part that is nobody's business but a manager's.
--
-- The trusted server (service role, or a migration or seed with no session) is
-- exempt, as elsewhere in this series.

do $$
begin
  if to_regclass('public.chores') is null then
    return;
  end if;

  create or replace function public.chore_price_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $guard$
  declare
    cash_set boolean;
    points_repriced boolean;
  begin
    -- Cash: setting it at all on INSERT, or changing it on UPDATE.
    cash_set := case
      when tg_op = 'INSERT' then
        coalesce(new.cash_cents, 0) <> 0
        or coalesce(new.cash_min_cents, 0) <> 0
        or coalesce(new.cash_max_cents, 0) <> 0
      else
        new.cash_cents is distinct from old.cash_cents
        or new.cash_min_cents is distinct from old.cash_min_cents
        or new.cash_max_cents is distinct from old.cash_max_cents
    end;

    -- Points: only a change to an existing chore's figures.
    points_repriced := tg_op = 'UPDATE' and (
      new.points is distinct from old.points
      or new.points_min is distinct from old.points_min
      or new.points_max is distinct from old.points_max
    );

    if cash_set or points_repriced then
      if current_user = 'service_role'
         or coalesce(auth.role(), '') = 'service_role'
         or auth.uid() is null
         or public.can_manage_family(new.family_id) then
        return new;
      end if;
      if cash_set then
        raise exception
          'a chore''s cash reward may only be set by a family manager'
          using errcode = '42501';
      end if;
      raise exception
        'a chore''s points may only be changed by a family manager'
        using errcode = '42501';
    end if;
    return new;
  end;
  $guard$;

  comment on function public.chore_price_guard() is
    'A chore''s cash reward is manager-set, and its points are manager-repriced. payChoreRewardAction credits a wallet from chores.cash_cents whenever the assignment carries no override (0305), and the chores board copies chores.points into points_awarded on approval.';

  drop trigger if exists trg_chore_price_guard on public.chores;
  create trigger trg_chore_price_guard
    before insert or update on public.chores
    for each row execute function public.chore_price_guard();
end
$$;

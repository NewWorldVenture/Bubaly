-- 0335_a_reward_is_paid_for_with_points_that_exist.sql
--
-- DATA-004: a reward could be approved with points the child did not have.
--
-- The spendable balance is arithmetic over two tables (lib/rewards/points.ts):
-- points EARNED are `points_awarded` on a member's approved chore_assignments,
-- and points SPENT are `cost_points` on their redemptions in 'approved' or
-- 'fulfilled'. Nothing below the browser ever did that arithmetic.
--
--   * rewards-module checks `canAfford` before offering Approve — in the
--     browser, from reads that can be stale, and not at all on a direct
--     PostgREST write;
--   * decideRedemptionAction approves whatever id it is given;
--   * requestRedemptionAction's manager-for-self path inserts 'approved'
--     outright, and a parent can do that for a 0-point balance;
--   * two parents approving two requests at once each see the same balance,
--     and both succeed — the classic check-then-act overspend.
--
-- 0295 decided WHO may approve and 0308 decided WHAT a reward costs. This
-- decides whether the child can PAY: whenever a redemption ENTERS a spending
-- status — an insert straight to approved/fulfilled, or an update from any
-- other status into one — the member's balance is recomputed from committed
-- rows and the transition is refused if it cannot cover `cost_points`.
--
-- ── Why the lock ────────────────────────────────────────────────────────────
-- A per-member transaction-scoped advisory lock serialises the recompute, so
-- the second of two concurrent approvals waits for the first to commit and then
-- sees its spend (READ COMMITTED takes a fresh snapshot per statement). Without
-- it the guard would reproduce exactly the race it exists to close.
--
-- ── What is deliberately NOT here ───────────────────────────────────────────
-- A status-transition graph. The enum carries 'pending' and 'cancelled', which
-- no current screen shows, and pinning transitions the product may still depend
-- on is how a guard becomes an outage. Re-entering a spending status (rejected
-- or cancelled back to approved) is covered anyway, because it is an ENTRY and
-- pays again. The UI's graph (requested → approved|rejected, approved →
-- fulfilled) is enforced in decideRedemptionAction as an expected-status write.
--
-- approved → fulfilled is not an entry: both statuses already spend, so the
-- points are not charged twice. The trusted server (service role) and
-- migrations/seeds (no session) are exempt, as in 0295 and 0308.
--
-- Idempotent; a database without the tables is left alone.

do $$
begin
  if to_regclass('public.reward_redemptions') is null
     or to_regclass('public.chore_assignments') is null then
    return;
  end if;

  create or replace function public.reward_redemption_balance_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $guard$
  declare
    earned bigint;
    spent  bigint;
  begin
    -- Only a transition INTO a spending status can overspend. A member or cost
    -- change on a row that already spends is treated as a new entry, so it
    -- cannot move a paid-for reward onto a sibling with no points.
    if new.status not in ('approved', 'fulfilled') then
      return new;
    end if;
    if tg_op = 'UPDATE'
       and old.status in ('approved', 'fulfilled')
       and new.member_id is not distinct from old.member_id
       and new.cost_points is not distinct from old.cost_points then
      return new;
    end if;

    if current_user = 'service_role'
       or coalesce(auth.role(), '') = 'service_role'
       or auth.uid() is null then
      return new;
    end if;

    perform pg_advisory_xact_lock(hashtextextended('reward_redemption_balance:' || new.member_id::text, 0));

    select coalesce(sum(points_awarded), 0) into earned
      from public.chore_assignments
     where member_id = new.member_id
       and status = 'approved'
       and points_awarded is not null;

    select coalesce(sum(cost_points), 0) into spent
      from public.reward_redemptions
     where member_id = new.member_id
       and status in ('approved', 'fulfilled')
       and id is distinct from new.id;

    if earned - spent < coalesce(new.cost_points, 0) then
      raise exception 'not enough points for this reward: % available, % needed',
        greatest(earned - spent, 0), new.cost_points
        using errcode = '23514';
    end if;

    return new;
  end;
  $guard$;

  comment on function public.reward_redemption_balance_guard() is
    'A redemption may enter approved/fulfilled only if the member''s earned points (approved chore_assignments) minus points already spent cover its cost_points; serialised per member so concurrent approvals cannot overspend. DATA-004.';

  revoke all on function public.reward_redemption_balance_guard() from public;

  -- Named to fire LAST. Row triggers on one event run in name order, and this
  -- must run after 0295's decision guard and 0308's cost guard: a child
  -- approving their own reward is refused as UNAUTHORISED, not as short of
  -- points, and the balance is checked against the price 0308 has confirmed.
  drop trigger if exists trg_reward_redemption_balance_guard on public.reward_redemptions;
  drop trigger if exists trg_reward_redemption_zz_balance_guard on public.reward_redemptions;
  create trigger trg_reward_redemption_zz_balance_guard
    before insert or update on public.reward_redemptions
    for each row execute function public.reward_redemption_balance_guard();
end
$$;

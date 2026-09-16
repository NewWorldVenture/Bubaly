-- Bubaly :: 0308 - the price on the shelf, and the price on the ticket
--
-- `rewards` is written STRAIGHT FROM THE BROWSER. components/modules/
-- rewards-module.tsx calls `sb.from('rewards').insert/update/delete` with the
-- viewer's own JWT — there is no server action in between. The only thing
-- standing between a child and the family's reward catalogue is
-- `canManage = isManager(role)` deciding whether a button renders (lines 146,
-- 233, 251). A hidden button is not a boundary. The table's policies are
-- `is_family_member(family_id)` and nothing else.
--
-- Measured on a replayed database with every migration applied, acting as a
-- child of the family, with the positive control passing: the child RE-PRICED
-- "New bike" from 5000 points to 5, ADDED a reward costing nothing, DELETED a
-- reward the parent had set up, and requested a 5000-point reward for 1 point.
-- See docs/audit/reward-catalogue-price-check.sql.
--
-- ── 1. the shelf ───────────────────────────────────────────────────────────
--
-- `requestRedemptionAction` copies `rewards.cost_points` into the redemption
-- server-side, so re-pricing the shelf re-prices the ticket a parent is asked
-- to approve: the queue shows a 5-point request for the bike. Restrictive
-- manager guards, 0254's mechanism — they AND with the union of the permissive
-- policies, so no permissive policy, present or added later, can grant past
-- them. Nothing legitimate breaks: the module already refuses to show a
-- non-manager the editor, and no other writer exists.
--
-- ── 2. the ticket ──────────────────────────────────────────────────────────
--
-- `reward_redemptions` has one policy — `Members can manage … FOR ALL …
-- is_family_member` — and 0295's trigger guards the DECISION on it, not the
-- amount. So a direct insert could name its own price without touching the
-- shelf at all, exactly as `invest_orders` could before 0306.
--
-- As there, the guard is CONSISTENCY rather than authorship, because authorship
-- is not the problem: a child legitimately requests a reward, and
-- `requestRedemptionAction` already derives the cost server-side. Requiring the
-- ticket to carry the shelf's price refuses the forged insert and leaves the
-- real one untouched — a manager-only rule here would stop a child asking for a
-- reward at all.
--
-- lib/rewards/points.ts deducts `cost_points` at 'approved' and 'fulfilled', so
-- both numbers are the spendable balance the whole chores economy settles in —
-- the ledger 0222, 0223, 0295 and 0305 exist to keep honest.

-- ── 1 ───────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.rewards') is null then
    return;
  end if;

  drop policy if exists rewards_manager_insert_guard on public.rewards;
  create policy rewards_manager_insert_guard on public.rewards
    as restrictive for insert to authenticated
    with check (public.can_manage_family(family_id));

  drop policy if exists rewards_manager_update_guard on public.rewards;
  create policy rewards_manager_update_guard on public.rewards
    as restrictive for update to authenticated
    using (public.can_manage_family(family_id))
    with check (public.can_manage_family(family_id));

  drop policy if exists rewards_manager_delete_guard on public.rewards;
  create policy rewards_manager_delete_guard on public.rewards
    as restrictive for delete to authenticated
    using (public.can_manage_family(family_id));
end
$$;

-- ── 2 ───────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.reward_redemptions') is null then
    return;
  end if;

  create or replace function public.reward_redemption_cost_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $guard$
  declare
    shelf_cost integer;
  begin
    if tg_op = 'UPDATE' and new.cost_points is not distinct from old.cost_points then
      return new;  -- a decision, not a repricing
    end if;

    -- The trusted server may record whatever a backfill or seed needs.
    if current_user = 'service_role'
       or coalesce(auth.role(), '') = 'service_role'
       or auth.uid() is null then
      return new;
    end if;

    -- A redemption that names no reward carries no shelf price to disagree
    -- with; the catalogue guard above is what bounds those.
    if new.reward_id is null then
      return new;
    end if;

    select cost_points into shelf_cost from public.rewards where id = new.reward_id;
    if shelf_cost is not null and new.cost_points is distinct from shelf_cost then
      raise exception
        'redemption cost % is not this reward''s price %', new.cost_points, shelf_cost
        using errcode = '23514';
    end if;

    return new;
  end;
  $guard$;

  comment on function public.reward_redemption_cost_guard() is
    'A redemption must carry the reward''s own cost_points. lib/rewards/points.ts deducts this column from the spendable balance at approved/fulfilled, and requestRedemptionAction already copies it from the reward server-side — so this refuses a forged direct insert without touching the real path.';

  drop trigger if exists trg_reward_redemption_cost_guard on public.reward_redemptions;
  create trigger trg_reward_redemption_cost_guard
    before insert or update on public.reward_redemptions
    for each row execute function public.reward_redemption_cost_guard();
end
$$;

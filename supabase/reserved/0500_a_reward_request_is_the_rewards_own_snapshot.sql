-- 0500 — A reward request is the reward's own snapshot.
-- 0308's ticket guard, completed. Found and reproduced 2026-10-10 on a replay
-- of every runnable migration.
--
-- 0308 measured a child requesting "a 5000-point reward for 1 point" and made
-- the ticket carry the shelf's price, so that "the forged insert" is refused
-- while requestRedemptionAction, which copies the reward's id, title and price
-- server-side, is untouched. Its guard compares cost_points with the price of
-- the reward named by reward_id, looked up by id alone. It returns early when
-- reward_id is null and on an UPDATE that leaves cost_points alone, and
-- reward_title (what the parent reads) is free text. Measured as an active
-- child of the family, through PostgREST's role, with "New bike" at 5000 and
-- "Sticker" at 1 on the shelf:
--
--   control  own "New bike" at 1 point                       refused (0308)
--   A        reward_id null, titled "New bike", 1 point      landed
--   B        another family's 1-point reward, "New bike"     landed
--   C        a real bike request, then reward_id := null,
--            cost_points := 1                                1 row
--   D        own 1-point "Sticker" titled "New bike"         landed
--   E        a real sticker request, retitled "New bike"     1 row
--
-- Each one reaches the parent's queue (rewards-module) as "Kid wants New bike
-- · 1 pts", indistinguishable from a real request, and one approval spends 1
-- point on it.
--
-- This replaces the body of 0308's reward_redemption_cost_guard (same name,
-- same trigger, still SECURITY DEFINER so the shelf is read whatever the
-- caller may see). For a signed-in caller:
--
--   * INSERT: reward_id names a reward of the ticket's own family; cost_points
--     is that reward's price (0308's sentence, unchanged); reward_title is that
--     reward's title.
--   * UPDATE: reward_id, reward_title and cost_points stay as they were.
--     Decisions, withdrawals and notes change other columns and are untouched.
--     The one change allowed is the foreign key's ON DELETE SET NULL when the
--     reward itself has been deleted, so a ticket's history still survives its
--     reward (0028), with the title and price it was made with.
--
-- The token economy has the same title hole. 0428's
-- economy_redemption_request_guard binds a non-manager's request to a reward
-- of the family, at its cost and in its currency, and refuses any later
-- update, but never reads economy_redemptions.title, which /economy shows the
-- parent. Measured as the same child: the 5000-token bike at 1 token was
-- refused; the 1-token sticker titled "New bike" landed. This replaces that
-- function's body with the same body and one more check, the reward's own
-- title (42501, like its other refusals); function, trigger, SECURITY
-- INVOKER and exemptions are unchanged.
--
-- The service role and session-less callers (seeds, backfills) stay exempt, as
-- in 0295, 0308 and 0439. Each table's only writer, requestRedemptionAction
-- (app/(app)/dashboard/rewards/actions.ts and app/(app)/economy/actions.ts),
-- already inserts exactly the reward's own id, title and price for a reward it
-- read from the active family, and never updates those columns, so nothing
-- legitimate changes. A parent renaming or re-pricing a reward in the instant
-- between that read and the insert now gets a refusal instead of a ticket at
-- the old figures; 0308 already refused the re-pricing half of that race.
--
-- HELD: proposed as 0500 (the first number above 0499; requested on #771 in
-- comment 6094977772, economy scope added in 6095050742, not yet confirmed)
-- in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/a-reward-request-is-the-rewards-own-snapshot-check.sql
-- and .github/workflows/reward-snapshot-runtime.yml. Not applied to production
-- by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
begin
  if to_regprocedure('public.reward_redemption_cost_guard()') is null then
    raise exception '0500 replaces reward_redemption_cost_guard() from 0308; apply 0308 first';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.reward_redemptions'::regclass
                    and tgname = 'trg_reward_redemption_cost_guard'
                    and tgfoid = 'public.reward_redemption_cost_guard()'::regprocedure) then
    raise exception '0500: trg_reward_redemption_cost_guard is not 0308''s trigger on reward_redemptions';
  end if;
  if to_regprocedure('public.economy_redemption_request_guard()') is null
     or to_regclass('public.economy_rewards') is null then
    raise exception '0500 replaces economy_redemption_request_guard() from 0428; apply 0428 first';
  end if;
end
$$;

create or replace function public.reward_redemption_cost_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $guard$
declare
  shelf record;
begin
  -- The trusted server may record whatever a backfill or seed needs.
  if current_user = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or auth.uid() is null then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.reward_id is not distinct from old.reward_id
       and new.reward_title is not distinct from old.reward_title
       and new.cost_points is not distinct from old.cost_points then
      return new;  -- a decision, a withdrawal or a note, not a re-pricing
    end if;
    -- ON DELETE SET NULL, once the reward is gone: the snapshot stays.
    if old.reward_id is not null and new.reward_id is null
       and new.reward_title is not distinct from old.reward_title
       and new.cost_points is not distinct from old.cost_points
       and not exists (select 1 from public.rewards r where r.id = old.reward_id) then
      return new;
    end if;
    raise exception 'a reward request keeps the reward, title and price it was made with'
      using errcode = '23514';
  end if;

  select r.family_id, r.title, r.cost_points into shelf
    from public.rewards r
   where r.id = new.reward_id;
  if new.reward_id is null or not found or shelf.family_id is distinct from new.family_id then
    raise exception 'a reward request must name a reward of this family'
      using errcode = '23514';
  end if;
  if new.cost_points is distinct from shelf.cost_points then
    raise exception
      'redemption cost % is not this reward''s price %', new.cost_points, shelf.cost_points
      using errcode = '23514';
  end if;
  if new.reward_title is distinct from shelf.title then
    raise exception 'redemption title is not this reward''s title'
      using errcode = '23514';
  end if;

  return new;
end;
$guard$;

comment on function public.reward_redemption_cost_guard() is
  'A redemption is a snapshot of one reward of its own family: on insert, reward_id names such a reward and cost_points and reward_title are its own (0308, 0500); on update those three stay, except the foreign key setting reward_id null once the reward is deleted. lib/rewards/points.ts deducts cost_points at approved/fulfilled, and the parent approves what reward_title says. The service role is exempt.';

-- ── The token economy: the request carries the reward's own title ──────────
create or replace function public.economy_redemption_request_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  v_reward record;
  v_own    uuid;
begin
  -- The trusted server (service role, or a migration/seed with no authenticated
  -- session) and family managers decide; a plain member only asks.
  if current_user = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or auth.uid() is null
     or public.can_manage_family(new.family_id) then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    raise exception 'a redemption may only be decided by a family manager'
      using errcode = '42501';
  end if;

  if coalesce(new.status, 'pending') <> 'pending' then
    raise exception 'a redemption may only be requested as pending, not as %', new.status
      using errcode = '42501';
  end if;
  if new.decided_by is not null or new.decided_at is not null or new.txn_id is not null then
    raise exception 'a redemption may not be requested with a decision already recorded'
      using errcode = '42501';
  end if;

  -- Your own member, not a sibling's balance.
  select id into v_own
    from public.family_members
   where family_id = new.family_id and user_id = auth.uid() and is_active
   limit 1;
  if v_own is null or new.member_id is distinct from v_own then
    raise exception 'a redemption may only be requested for your own member'
      using errcode = '42501';
  end if;

  -- A real reward, at its price, in its currency, under its own title. Without
  -- a reward_id this is a free-form debit whose amount the caller picked.
  if new.reward_id is null then
    raise exception 'a redemption must name a reward'
      using errcode = '42501';
  end if;
  select id, title, cost, currency_id, is_active, stock into v_reward
    from public.economy_rewards
   where id = new.reward_id and family_id = new.family_id;
  if not found then
    raise exception 'that reward does not belong to this family'
      using errcode = '42501';
  end if;
  if not coalesce(v_reward.is_active, false) then
    raise exception 'that reward is not available'
      using errcode = '42501';
  end if;
  if new.cost is distinct from v_reward.cost then
    raise exception 'a reward costs what the family set for it, not %', new.cost
      using errcode = '42501';
  end if;
  if new.currency_id is distinct from v_reward.currency_id then
    raise exception 'a redemption must be priced in the reward''s own currency'
      using errcode = '42501';
  end if;
  -- 0500: the title the parent reads is the reward's own.
  if new.title is distinct from v_reward.title then
    raise exception 'a redemption carries the reward''s own title'
      using errcode = '42501';
  end if;

  return new;
end; $fn$;

revoke all on function public.economy_redemption_request_guard() from public;


do $$
begin
  if not exists (select 1 from pg_proc f
                  where f.oid = 'public.reward_redemption_cost_guard()'::regprocedure
                    and f.prosecdef
                    and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')
                    and pg_get_functiondef(f.oid) ~ 'must name a reward of this family'
                    and pg_get_functiondef(f.oid) ~ 'keeps the reward, title and price') then
    raise exception '0500: reward_redemption_cost_guard is not the snapshot guard (SECURITY DEFINER, pinned search_path)';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.reward_redemptions'::regclass
                    and tgname = 'trg_reward_redemption_cost_guard'
                    and tgenabled <> 'D'
                    and (tgtype & 2) = 2 and (tgtype & 20) = 20) then
    raise exception '0500: trg_reward_redemption_cost_guard is not an enabled BEFORE INSERT OR UPDATE trigger';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.economy_redemptions'::regclass
                    and tgname = 'trg_economy_redemption_request_guard'
                    and tgfoid = 'public.economy_redemption_request_guard()'::regprocedure
                    and tgenabled <> 'D'
                    and (tgtype & 2) = 2 and (tgtype & 20) = 20)
     or pg_get_functiondef('public.economy_redemption_request_guard()'::regprocedure) !~ 'carries the reward''''s own title' then
    raise exception '0500: economy_redemption_request_guard is not 0428''s trigger with the title check';
  end if;
end
$$;

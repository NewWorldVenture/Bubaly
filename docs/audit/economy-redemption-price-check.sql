-- Behavioural proof for 0304, run as real `authenticated` sessions under RLS.
--
-- `economy_redemptions_insert` constrained ONE column — `family_id` — so `cost`,
-- `member_id`, `status`, `decided_by`, `decided_at` and `txn_id` were all the
-- caller's to choose. And `economy_decide_redemption()` debited
-- `v_redemption.cost`: the number on the row the child wrote. It locks the
-- `economy_rewards` row two statements earlier, for STOCK, and never read the
-- price off it.
--
-- The sibling table `reward_redemptions` has carried a decision guard since
-- 0295. This one had only `set_updated_at`.
--
-- What a member may still do is asserted alongside what they may not: a child
-- still REQUESTS a redemption, at the family's price, for themselves — and the
-- parent's approval still debits and fulfils it.
grant usage on schema public to authenticated;
-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

do $$
declare
  fam        uuid := 'dddd1111-0000-4000-8000-00000000000d';
  parent_uid uuid := 'd1000000-0000-4000-8000-000000000001';
  child_uid  uuid := 'd1000000-0000-4000-8000-000000000002';
  parent_mid uuid;
  child_mid  uuid;
  cur        uuid;
  rew        uuid;
  red        uuid;
  blocked    boolean;
  n          int;
  v_cost     bigint;
  v_balance  bigint;
  res        jsonb;
begin
  delete from public.currency_transactions where family_id = fam;
  delete from public.economy_redemptions where family_id = fam;
  delete from public.economy_rewards where family_id = fam;
  delete from public.family_currencies where family_id = fam;
  delete from public.family_members where user_id in (parent_uid, child_uid);
  delete from public.families where id = fam;

  insert into public.families (id, name) values (fam, 'Economy') on conflict do nothing;
  insert into auth.users (id, email) values (parent_uid, 'ep@example.test'), (child_uid, 'ec@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true) returning id into parent_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, child_uid, 'Child', 'child', true) returning id into child_mid;

  insert into public.family_currencies (family_id, name, emoji)
  values (fam, 'Stars', '⭐') returning id into cur;
  insert into public.economy_rewards (family_id, currency_id, title, cost, is_active, created_by)
  values (fam, cur, 'PlayStation 5', 5000, true, parent_uid) returning id into rew;

  -- The child has earned 60 stars. Nowhere near 5000.
  insert into public.currency_transactions (family_id, currency_id, member_id, direction, amount, reason, created_by)
  values (fam, cur, child_mid, 'credit', 60, 'Chores', parent_uid);

  -- ── As the CHILD ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- 1. The headline: cannot name their own price. Before 0304 this inserted,
  --    and the parent's approval then debited ONE star for a 5000-star reward.
  blocked := false;
  begin
    insert into public.economy_redemptions (family_id, reward_id, currency_id, member_id, title, cost, status, requested_by)
    values (fam, rew, cur, child_mid, 'PlayStation 5', 1, 'pending', child_uid);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child priced their own redemption';
  end if;

  -- 2. Cannot forge a decision.
  blocked := false;
  begin
    insert into public.economy_redemptions (family_id, reward_id, currency_id, member_id, title, cost, status, decided_by, decided_at, requested_by)
    values (fam, rew, cur, child_mid, 'PlayStation 5', 5000, 'fulfilled', parent_uid, now(), child_uid);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child inserted an already-fulfilled redemption';
  end if;

  -- 3. Cannot bill a sibling — here, the parent.
  blocked := false;
  begin
    insert into public.economy_redemptions (family_id, reward_id, currency_id, member_id, title, cost, status, requested_by)
    values (fam, rew, cur, parent_mid, 'PlayStation 5', 5000, 'pending', child_uid);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child billed another member''s balance';
  end if;

  -- 4. Cannot invent a free-form redemption with no reward behind it.
  blocked := false;
  begin
    insert into public.economy_redemptions (family_id, currency_id, member_id, title, cost, status, requested_by)
    values (fam, cur, child_mid, 'A pony', 1, 'pending', child_uid);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child invented a redemption with no reward';
  end if;

  -- 5. …but may still ASK, at the family's price, for themselves. A guard that
  --    blocked this would be a different bug.
  insert into public.economy_redemptions (family_id, reward_id, currency_id, member_id, title, cost, status, requested_by)
  values (fam, rew, cur, child_mid, 'PlayStation 5', 5000, 'pending', child_uid)
  returning id into red;

  -- ── As the PARENT: the decision, and the price that is actually charged ──
  reset role;
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  -- Not affordable at the real price, and the function says so rather than
  -- debiting something it made up.
  res := public.economy_decide_redemption(red, true, null);
  if res->>'reason' <> 'insufficient_tokens' then
    raise exception 'a 5000-star reward was approved on a 60-star balance: %', res;
  end if;

  -- Give the child enough, then approve for real.
  reset role;
  insert into public.currency_transactions (family_id, currency_id, member_id, direction, amount, reason, created_by)
  values (fam, cur, child_mid, 'credit', 6000, 'Birthday', parent_uid);
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  res := public.economy_decide_redemption(red, true, null);
  if res->>'status' <> 'fulfilled' then
    raise exception 'a parent could not approve a legitimate redemption: %', res;
  end if;

  reset role;
  select amount into v_cost from public.currency_transactions
   where related_id = red and direction = 'debit';
  if v_cost <> 5000 then
    raise exception 'the ledger was debited % rather than the reward''s 5000', v_cost;
  end if;
  select cost into v_cost from public.economy_redemptions where id = red;
  if v_cost <> 5000 then
    raise exception 'the redemption records % rather than what was charged', v_cost;
  end if;

  -- ── The function no longer trusts the row, even if one gets written ──────
  -- A manager CAN author a row directly (rule 1 exempts them), so prove the
  -- second lock independently of the first: a redemption whose cost says 1 is
  -- still charged the reward's 5000.
  insert into public.economy_redemptions (family_id, reward_id, currency_id, member_id, title, cost, status, requested_by)
  values (fam, rew, cur, child_mid, 'PlayStation 5', 1, 'pending', parent_uid) returning id into red;
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  res := public.economy_decide_redemption(red, true, null);
  reset role;
  if res->>'status' <> 'fulfilled' then
    raise exception 'the second approval did not go through: %', res;
  end if;
  select amount into v_cost from public.currency_transactions
   where related_id = red and direction = 'debit';
  if v_cost <> 5000 then
    raise exception 'a row claiming cost=1 was charged % rather than the reward''s 5000', v_cost;
  end if;

  raise notice 'OK economy redemptions: a child asks at the family''s price for themselves, and the price CHARGED is the reward''s whatever the row says';
end $$;

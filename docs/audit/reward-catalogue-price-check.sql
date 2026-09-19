-- The price on the shelf, and the price on the ticket.
--
-- `rewards` is written STRAIGHT FROM THE BROWSER — components/modules/
-- rewards-module.tsx calls `sb.from('rewards').insert/update/delete` with the
-- viewer's own JWT. The only thing between a child and the family's reward
-- catalogue is `canManage = isManager(role)` deciding whether a button renders
-- (lines 146, 233, 251). A hidden button is not a boundary; the table's four
-- policies are `is_family_member(family_id)` and nothing else.
--
-- Two numbers follow from that:
--
--   rewards.cost_points      — `requestRedemptionAction` copies it into the
--                              redemption server-side, so re-pricing the shelf
--                              re-prices the ticket the parent approves. A
--                              child lowers "New bike, 5000" to 5, requests it,
--                              and the approval queue shows a 5-point ask.
--   reward_redemptions.cost_points
--                            — one policy, `Members can manage … FOR ALL …
--                              is_family_member`, and 0295's trigger guards the
--                              DECISION, not the amount. A direct insert can
--                              name its own price without touching the shelf at
--                              all.
--
-- lib/rewards/points.ts deducts cost_points at 'approved' and 'fulfilled', so
-- both are the spendable balance — the same ledger 0222, 0223, 0295 and 0305
-- exist to keep honest.
--
-- Judged on ROW COUNTS: an UPDATE refused by nothing simply lands, and an
-- exception-only assertion would report a boundary that is not there.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000000fd01';
  parent_uid uuid := '00000000-0000-4000-8000-00000000fda1';
  child_uid  uuid := '00000000-0000-4000-8000-00000000fda2';
  child_mid uuid;
  bike uuid;
  spare uuid;
  n int;
  failures int := 0;
begin
  delete from public.reward_redemptions where family_id = fam;
  delete from public.rewards where family_id = fam;

  insert into auth.users (id, email) values
    (parent_uid, 'shelf-parent@example.com'), (child_uid, 'shelf-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Reward Shelf', parent_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, child_uid,  'Child',  'child',  true)
  on conflict do nothing;
  select id into child_mid from public.family_members where family_id = fam and user_id = child_uid;

  insert into public.rewards (family_id, title, cost_points, created_by)
    values (fam, 'New bike', 5000, parent_uid) returning id into bike;
  -- A second shelf item, so the delete assertion cannot destroy the row the
  -- consistency assertion below needs.
  insert into public.rewards (family_id, title, cost_points, created_by)
    values (fam, 'Ice cream', 100, parent_uid) returning id into spare;

  -- ── as the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: acting as a manager, so nothing below is a child boundary';
  end if;

  -- 1. A child may still ASK for a reward at the shelf price — the positive
  --    control. requestRedemptionAction inserts exactly this row as the child,
  --    so a guard that blocked it would have closed the feature, not the hole.
  begin
    insert into public.reward_redemptions
      (family_id, reward_id, member_id, reward_title, cost_points, status)
    values (fam, bike, child_mid, 'New bike', 5000, 'requested');
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a child could not request a reward (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a child could not request a reward (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 2. But may not re-price the shelf under it.
  begin
    update public.rewards set cost_points = 5 where id = bike;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child re-priced a family reward from 5000 to 5 (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 3. Nor stock the shelf with one of their own, free.
  begin
    insert into public.rewards (family_id, title, cost_points, created_by)
      values (fam, 'A day off', 0, child_uid);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child added a reward costing nothing (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 4. Nor clear the shelf.
  begin
    delete from public.rewards where id = spare;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child deleted a family reward (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 5. Nor write a ticket at a price the shelf never carried. This is the
  --    consistency half — 0295's trigger guards the DECISION on this table, not
  --    the amount, exactly as 0304 did for invest_orders before 0306.
  begin
    insert into public.reward_redemptions
      (family_id, reward_id, member_id, reward_title, cost_points, status)
    values (fam, bike, child_mid, 'New bike', 1, 'requested');
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child requested a 5000-point reward for % point (rows: %)', 1, n;
      failures := failures + 1;
    end if;
  exception when check_violation then null; when insufficient_privilege then null;
  end;

  -- 6. And the shelf price a parent would be shown is still the one they set.
  select cost_points into n from public.rewards where id = bike;
  if n is distinct from 5000 then
    raise warning 'BREACH: the reward the approval queue prices is now % points', n;
    failures := failures + 1;
  end if;

  reset role;

  -- 7. A manager still runs the catalogue, or the guard has closed the product.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  begin
    insert into public.rewards (family_id, title, cost_points, created_by)
      values (fam, 'Movie night', 250, parent_uid);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not add a reward (rows: %)', n;
      failures := failures + 1;
    end if;
    update public.rewards set cost_points = 4500 where id = bike;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not re-price a reward (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a manager could not run the catalogue (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  if failures > 0 then
    raise exception 'reward-catalogue-price: % assertion(s) failed', failures;
  end if;
  raise notice 'reward-catalogue-price: OK — a child may ask at the shelf price, and may not set it';
end
$probe$;

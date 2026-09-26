-- Behavioural proof for 0335, run as real `authenticated` sessions under RLS.
--
-- A redemption spends points when it ENTERS 'approved' or 'fulfilled'. Before
-- 0335 nothing below the browser checked the member could pay: a parent could
-- approve a reward for a child with no points, approve two requests that
-- together cost more than the balance, or move a paid-for reward onto a sibling.
--
-- What must still work is asserted beside what must not — a guard that stopped
-- a child asking, a parent approving what the child can afford, or a fulfilled
-- reward being recorded, would be a worse bug than the one it fixes.
grant usage on schema public to authenticated;

do $$
declare
  fam        uuid := 'aaa60000-0000-4000-8000-00000000005b';
  parent_uid uuid := 'aaa60000-0000-4000-8000-000000000001';
  child_uid  uuid := 'aaa60000-0000-4000-8000-000000000002';
  sib_uid    uuid := 'aaa60000-0000-4000-8000-000000000003';
  parent_mid uuid;
  child_mid  uuid;
  sib_mid    uuid;
  chore      uuid;
  reward     uuid;
  first_ask  uuid;
  second_ask uuid;
  seeded     uuid;
  refused    boolean;
  n          int;
begin
  -- ── Fixture, written with no session (as a seed would be) ────────────────
  insert into public.families (id, name) values (fam, 'Balance') on conflict do nothing;
  insert into auth.users (id, email) values
    (parent_uid, 'bal-p@example.test'), (child_uid, 'bal-c@example.test'), (sib_uid, 'bal-s@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, parent_uid, 'Parent', 'parent', true) returning id into parent_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, child_uid, 'Child', 'child', true) returning id into child_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, sib_uid, 'Sibling', 'child', true) returning id into sib_mid;
  insert into public.chores (family_id, title) values (fam, 'Dishes') returning id into chore;
  -- The child has EARNED exactly 100 points; the sibling has earned none.
  insert into public.chore_assignments (family_id, chore_id, member_id, status, points_awarded)
    values (fam, chore, child_mid, 'approved', 100);
  insert into public.rewards (family_id, title, cost_points) values (fam, 'Movie night', 100) returning id into reward;

  -- ── As the child: asking costs nothing, twice ─────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;
  insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status)
    values (fam, reward, child_mid, 'Movie night', 100, 'requested') returning id into first_ask;
  insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status)
    values (fam, reward, child_mid, 'Movie night', 100, 'requested') returning id into second_ask;
  reset role;

  -- ── As the parent ────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  -- 1. What the child can afford is approved.
  update public.reward_redemptions set status = 'approved', decided_by = parent_mid where id = first_ask;

  -- 2. The second 100 is not there to spend.
  refused := false;
  begin
    update public.reward_redemptions set status = 'approved', decided_by = parent_mid where id = second_ask;
  exception when check_violation then refused := true;
  end;
  if not refused then
    raise exception 'a parent approved a reward the child could not pay for (100 earned, 200 approved)';
  end if;

  -- 3. Fulfilling what was approved is not a second charge.
  update public.reward_redemptions set status = 'fulfilled' where id = first_ask;
  select count(*) into n from public.reward_redemptions where id = first_ask and status = 'fulfilled';
  if n <> 1 then
    raise exception 'fulfilling an approved reward was refused — approved → fulfilled must not pay twice';
  end if;

  -- 4. Inserting straight to 'approved' is a spend like any other.
  refused := false;
  begin
    insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status, decided_by)
      values (fam, reward, child_mid, 'Movie night', 100, 'approved', parent_mid);
  exception when check_violation then refused := true;
  end;
  if not refused then
    raise exception 'a parent inserted an approved reward the child could not pay for';
  end if;

  -- 5. Rejected-then-approved re-enters spending and pays again.
  update public.reward_redemptions set status = 'rejected', decided_by = parent_mid where id = second_ask;
  refused := false;
  begin
    update public.reward_redemptions set status = 'approved', decided_by = parent_mid where id = second_ask;
  exception when check_violation then refused := true;
  end;
  if not refused then
    raise exception 'a rejected reward was re-approved without the points to pay for it';
  end if;

  -- 6. A paid-for reward cannot be moved onto a sibling with no points.
  refused := false;
  begin
    update public.reward_redemptions set member_id = sib_mid where id = first_ask;
  exception when check_violation then refused := true;
  end;
  if not refused then
    raise exception 'a fulfilled reward was moved onto a sibling who never earned the points';
  end if;

  reset role;

  -- 7. Earning more makes the second request payable — the guard reads the
  --    ledger, it does not just say no.
  insert into public.chore_assignments (family_id, chore_id, member_id, status, points_awarded)
    values (fam, chore, child_mid, 'approved', 100);
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  update public.reward_redemptions set status = 'approved', decided_by = parent_mid where id = second_ask;
  select count(*) into n from public.reward_redemptions where id = second_ask and status = 'approved';
  if n <> 1 then
    raise exception 'a parent could not approve a reward the child had since earned';
  end if;
  reset role;

  -- 8. A seed or backfill (no session) still records history as it finds it.
  perform set_config('request.jwt.claim.sub', '', true);
  insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status)
    values (fam, reward, sib_mid, 'Movie night', 100, 'fulfilled') returning id into seeded;
  if seeded is null then
    raise exception 'a seed could not record a historical redemption';
  end if;

  -- 9. The recompute is serialised per member, or two concurrent approvals
  --    would each see the same balance. A single session cannot race itself,
  --    so the lock is asserted where it lives.
  select count(*) into n from pg_proc
   where proname = 'reward_redemption_balance_guard'
     and prosrc like '%pg_advisory_xact_lock%' and prosecdef;
  if n <> 1 then
    raise exception 'the balance guard no longer serialises per member (or is no longer SECURITY DEFINER)';
  end if;

  raise notice 'OK  a reward is paid for with points that exist; asking, affordable approval, fulfilment and seeds still work';
end $$;
